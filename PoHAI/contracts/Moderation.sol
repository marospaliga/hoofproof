// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Stasis} from "./Stasis.sol";
import {CowRating} from "./CowRating.sol";

/// @title Moderation — reputation-weighted curation disputes
///
/// Rating is democracy backed by blockchain: documented items (photos, posts)
/// can be hidden by the same reputation that rated them — never by money.
///
/// Flow: propose → challenge window → execute.
///  - Dominance fast-path: if the proposer's side holds a supermajority
///    (default 66%) of expressed weight, the action executes after a short
///    timelock with no further vote — one clearly-biggest oracle moderates alone.
///  - Contested path: both sides accumulate standing (score snapshots at
///    no VP spent); removal needs a majority AND distinct raters — evenly
///    matched sides must build their case.
/// Hides are reversible (a counter-proposal restores) and fully logged; the
/// server enforces visibility off the execution record, the chain holds proof.
contract Moderation is Ownable {
    uint256 public constant BPS = 10_000;

    Stasis public immutable stasis;
    CowRating public immutable cowRating;

    enum Action {
        Hide,
        Restore
    }

    enum State {
        Open,
        Executed,
        Rejected
    }

    struct Proposal {
        uint256 tokenId;
        bytes32 itemKey; // CowRating content key (evidence or post)
        Action action;
        State state;
        address proposer;
        uint256 forWeight;
        uint256 againstWeight;
        uint256 votersFor;
        uint256 votersAgainst;
        uint256 createdAt;
    }

    /// @notice Share of expressed weight that decides alone (fast-path).
    uint256 public dominanceBps = 6_600; // 66%
    /// @notice Dominant proposals still wait out this timelock (challenge chance).
    uint256 public fastPathDelay = 48 hours;
    /// @notice Contested proposals need this long before they can execute.
    uint256 public challengeWindow = 3 days;
    /// @notice Contested execution needs at least this many distinct raters.
    uint256 public minDistinctVoters = 2;

    uint256 public nextProposalId = 1;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    /// @notice One open proposal per item at a time (challengers vote, not fork).
    mapping(bytes32 => uint256) public openProposal;

    event ModerationProposed(
        uint256 indexed id, uint256 indexed tokenId, bytes32 indexed itemKey, Action action, address proposer, uint256 weight
    );
    event ModerationChallenged(uint256 indexed id, address indexed voter, bool support, uint256 weight);
    event ModerationExecuted(uint256 indexed id, Action action, uint256 forWeight, uint256 againstWeight);

    error UnknownItem();
    error ItemMismatch();
    error ProposalOpen();
    error AlreadyVoted();
    error AlreadyResolved();
    error TooEarly();
    error WindowClosed();
    error QuorumNotMet();

    constructor(address stasis_, address cowRating_) Ownable(msg.sender) {
        stasis = Stasis(stasis_);
        cowRating = CowRating(cowRating_);
    }

    function setPolicy(uint256 dominance, uint256 fastDelay, uint256 window, uint256 minVoters) external onlyOwner {
        dominanceBps = dominance;
        fastPathDelay = fastDelay;
        challengeWindow = window;
        minDistinctVoters = minVoters;
    }

    /// @notice Standing weight: reputation behind an account.
    function voterWeight(address account) public view returns (uint256) {
        return stasis.effectiveScore(account);
    }

    function propose(uint256 tokenId, bytes32 itemKey, Action action) external returns (uint256 id) {
        if (cowRating.contentAuthor(itemKey) == address(0)) revert UnknownItem();
        if (cowRating.contentTokenId(itemKey) != tokenId) revert ItemMismatch();
        if (openProposal[itemKey] != 0) revert ProposalOpen();

        id = nextProposalId++;
        uint256 weight = voterWeight(msg.sender);
        proposals[id] = Proposal({
            tokenId: tokenId,
            itemKey: itemKey,
            action: action,
            state: State.Open,
            proposer: msg.sender,
            forWeight: weight,
            againstWeight: 0,
            votersFor: 1,
            votersAgainst: 0,
            createdAt: block.timestamp
        });
        hasVoted[id][msg.sender] = true;
        openProposal[itemKey] = id;
        emit ModerationProposed(id, tokenId, itemKey, action, msg.sender, weight);
    }

    /// @notice Take a side while the window is open. One voice per account.
    function challenge(uint256 id, bool support) external {
        Proposal storage p = proposals[id];
        if (p.proposer == address(0) || p.state != State.Open) revert AlreadyResolved();
        if (block.timestamp > p.createdAt + challengeWindow) revert WindowClosed();
        if (hasVoted[id][msg.sender]) revert AlreadyVoted();

        uint256 weight = voterWeight(msg.sender);
        hasVoted[id][msg.sender] = true;
        if (support) {
            p.forWeight += weight;
            p.votersFor += 1;
        } else {
            p.againstWeight += weight;
            p.votersAgainst += 1;
        }
        emit ModerationChallenged(id, msg.sender, support, weight);
    }

    /// @notice Execute once decided: dominance fast-path after the timelock,
    ///         otherwise majority + distinct raters after the full window.
    function execute(uint256 id) external {
        Proposal storage p = proposals[id];
        if (p.proposer == address(0) || p.state != State.Open) revert AlreadyResolved();

        uint256 total = p.forWeight + p.againstWeight;
        bool dominant = total > 0 && p.forWeight * BPS >= total * dominanceBps;

        if (dominant) {
            if (block.timestamp < p.createdAt + fastPathDelay) revert TooEarly();
        } else {
            if (block.timestamp < p.createdAt + challengeWindow) revert TooEarly();
            if (p.forWeight <= p.againstWeight) {
                p.state = State.Rejected;
                openProposal[p.itemKey] = 0;
                emit ModerationExecuted(id, p.action, p.forWeight, p.againstWeight);
                return;
            }
            if (p.votersFor + p.votersAgainst < minDistinctVoters) revert QuorumNotMet();
        }

        p.state = State.Executed;
        openProposal[p.itemKey] = 0;
        // A hide freezes the content so its liens can be slashed in batches;
        // a restore unfreezes it. Slashes already taken are not refunded.
        if (p.action == Action.Hide) {
            cowRating.setContentHidden(p.tokenId, p.itemKey, true);
        } else {
            cowRating.setContentHidden(p.tokenId, p.itemKey, false);
        }
        emit ModerationExecuted(id, p.action, p.forWeight, p.againstWeight);
    }
}

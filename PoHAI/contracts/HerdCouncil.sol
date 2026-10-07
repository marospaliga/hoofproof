// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CowNFT} from "./CowNFT.sol";
import {CowRating} from "./CowRating.sol";

/// @title HerdCouncil — propose and decide by reputation, on-chain accounting
///
/// A discussion happens off-chain (a cid hash is pinned as the proposal body);
/// this contract keeps the vote honest. A cow owner may propose for a herd
/// they belong to, and members vote with the full weight of the rating they
/// have committed to *their* cows in that herd — reputation, not money, and
/// not a coin-vote. Passing proposals only ever emit a decision signal: the
/// council advises, humans execute.
contract HerdCouncil is Ownable {
    uint256 public constant BPS = 10_000;

    CowNFT public immutable cowNFT;
    CowRating public immutable cowRating;

    struct Proposal {
        uint256 id;
        uint256 herdId;
        bytes32 hash; // cid of the off-chain proposal body
        uint256 forVotes;
        uint256 againstVotes;
        uint256 endsAt;
        bool executed;
    }

    uint256 public nextProposalId = 1;
    uint256 public minDuration = 1 days;
    uint256 public maxDuration = 30 days;

    mapping(uint256 => Proposal) public proposals;
    mapping(bytes32 => uint256) public proposalIdOf; // dedupe on proposal hash
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    event Proposed(uint256 indexed id, uint256 indexed herdId, bytes32 hash, uint256 endsAt, address proposer);
    event CouncilVote(uint256 indexed id, address indexed member, bool support, uint256 weight);
    event Decided(uint256 indexed id, uint256 indexed herdId, bytes32 hash, bool passed);

    error NotAMember();
    error NotAResident(); // cow not in this herd
    error AlreadyProposed();
    error AlreadyVoted();
    error VotingClosed();
    error NotExecutable();

    constructor(address cowNFT_, address cowRating_) Ownable(msg.sender) {
        cowNFT = CowNFT(cowNFT_);
        cowRating = CowRating(cowRating_);
    }

    function setDurationLimits(uint256 min_, uint256 max_) external onlyOwner {
        minDuration = min_;
        maxDuration = max_;
    }

    /// @notice A member's voting weight in a herd = sum of rating of their own
    ///         cows in that herd, scaled by their ethical momentum.
    function memberVoteWeight(address account, uint256 herdId) public view returns (uint256 weight) {
        uint256 count = cowNFT.nextTokenId();
        for (uint256 i = 1; i < count; i++) {
            (,, uint256 cowHerd, ) = cowNFT.cows(i);
            if (cowHerd != herdId) continue;
            if (cowNFT.ownerOf(i) != account) continue;
            weight += cowRating.ratingOf(i);
        }
        if (weight > 0) {
            weight = (weight * cowRating.momentumBps(account)) / BPS;
        }
    }

    function isMember(address account, uint256 herdId) public view returns (bool) {
        uint256 count = cowNFT.nextTokenId();
        for (uint256 i = 1; i < count; i++) {
            (,, uint256 cowHerd, ) = cowNFT.cows(i);
            if (cowHerd == herdId && cowNFT.ownerOf(i) == account) return true;
        }
        return false;
    }

    function propose(uint256 herdId, bytes32 hash, uint256 durationDays) external returns (uint256 id) {
        if (!isMember(msg.sender, herdId)) revert NotAMember();
        if (hash == bytes32(0) || proposalIdOf[hash] != 0) revert AlreadyProposed();

        uint256 duration = durationDays * 1 days;
        if (duration < minDuration) duration = minDuration;
        if (duration > maxDuration) duration = maxDuration;

        id = nextProposalId++;
        proposals[id] = Proposal({
            id: id,
            herdId: herdId,
            hash: hash,
            forVotes: 0,
            againstVotes: 0,
            endsAt: block.timestamp + duration,
            executed: false
        });
        proposalIdOf[hash] = id;

        emit Proposed(id, herdId, hash, proposals[id].endsAt, msg.sender);
    }

    function vote(uint256 proposalId, bool support) external {
        Proposal storage p = proposals[proposalId];
        if (p.id == 0 || p.endsAt == 0) revert VotingClosed();
        if (block.timestamp >= p.endsAt) revert VotingClosed();
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted();
        if (!isMember(msg.sender, p.herdId)) revert NotAMember();

        uint256 weight = memberVoteWeight(msg.sender, p.herdId);
        if (weight == 0) revert NotAResident();

        hasVoted[proposalId][msg.sender] = true;
        if (support) p.forVotes += weight;
        else p.againstVotes += weight;

        emit CouncilVote(proposalId, msg.sender, support, weight);
    }

    /// @notice Tally after the window. Only emits a decision — execution is a
    ///         real-world, off-chain step (or a later module).
    function finalize(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        if (p.id == 0 || p.executed) revert NotExecutable();
        if (block.timestamp < p.endsAt) revert VotingClosed();

        p.executed = true;
        bool passed = p.forVotes > p.againstVotes;
        emit Decided(proposalId, p.herdId, p.hash, passed);
    }
}
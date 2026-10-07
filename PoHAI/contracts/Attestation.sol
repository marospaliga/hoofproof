// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Stasis} from "./Stasis.sol";
import {CowNFT} from "./CowNFT.sol";
import {CowRating} from "./CowRating.sol";

/// @title Attestation — proof of stake on real-world events
///
/// There is no oracle vendor here and no admin key deciding what happened.
/// Anyone may assert a real-world fact ("this cow was sold", "this cow died",
/// "the funding need is now zero"); the assertion's weight is the Stasis of
/// the person making it, and it is *bonded* as collateral. High-stakes claims
/// need several independent attestations before they execute.
///
/// This is staked testimony, not independent truth — which is exactly why the
/// bond exists, and why disputes can destroy it.
contract Attestation is Ownable {
    enum Kind {
        Existence, // evidence the cow exists and is documented
        Care, // evidence of ongoing care
        Sale, // the real cow changed hands offline
        Death, // the real cow died
        Revenue, // reported farm output (ghee, cheese, ...)
        FundingNeed // the project's remaining monthly need
    }

    enum State {
        Open,
        Executed,
        Disputed,
        Refuted
    }

    struct Claim {
        uint256 tokenId;
        Kind kind;
        State state;
        address attester; // first reporter
        address subject; // payload: new owner (Sale) or solver (FundingNeed)
        uint256 value; // payload: numeric amount (FundingNeed / Revenue)
        uint256 bond; // total bonded across all supporters
        uint256 support; // distinct attesters
        uint256 postedAt;
        string cid; // IPFS pointer to the evidence
    }

    Stasis public immutable stasis;
    CowNFT public immutable cowNFT;
    CowRating public immutable cowRating;

    uint256 public constant BPS = 10_000;
    uint256 public minBond = 100;

    mapping(Kind => uint256) public quorum;
    mapping(uint256 => Claim) public claims;
    mapping(uint256 => mapping(address => uint256)) public bondOf;
    mapping(uint256 => mapping(address => bool)) public supported;
    mapping(uint256 => address[]) public supporters;
    mapping(uint256 => address) public disputer;
    mapping(uint256 => uint256) public disputeBond;

    uint256 public nextClaimId = 1;

    event Attested(uint256 indexed claimId, uint256 indexed tokenId, Kind indexed kind, address attester, uint256 support, string cid);
    event ClaimExecuted(uint256 indexed claimId, Kind indexed kind, uint256 tokenId);
    event ClaimDisputed(uint256 indexed claimId, address disputer);
    event ClaimResolved(uint256 indexed claimId, bool upheld);
    event QuorumSet(Kind indexed kind, uint256 quorum);

    error InsufficientBond();
    error AlreadySupported();
    error AlreadyResolved();
    error NotDisputable();
    error NotDisputed();
    error OnlyCowNFTOwner();

    constructor(address stasis_, address cowNFT_, address cowRating_) Ownable(msg.sender) {
        stasis = Stasis(stasis_);
        cowNFT = CowNFT(cowNFT_);
        cowRating = CowRating(cowRating_);

        quorum[Kind.Existence] = 2;
        quorum[Kind.Care] = 2;
        quorum[Kind.Revenue] = 2;
        quorum[Kind.Sale] = 3;
        quorum[Kind.Death] = 3;
        quorum[Kind.FundingNeed] = 1;
    }

    function setQuorum(Kind kind, uint256 value) external onlyOwner {
        quorum[kind] = value;
        emit QuorumSet(kind, value);
    }

    function setMinBond(uint256 value) external onlyOwner {
        minBond = value;
    }

    // ------------------------------------------------------------- attesting

    /// @notice Assert a real-world fact about a cow, bonding Stasis behind it.
    ///         Repeated independent reports accumulate toward quorum; on
    ///         quorum the claim executes and every bond comes back.
    function attest(
        uint256 tokenId,
        Kind kind,
        string calldata cid,
        uint256 value,
        address subject,
        uint256 bond
    ) external returns (uint256 claimId) {
        if (bond < minBond) revert InsufficientBond();
        // Reverts if the token was never minted — an attestation must target a real record.
        cowNFT.statusOf(tokenId);

        claimId = _findOpen(tokenId, kind, value, subject);
        if (claimId != 0) {
            if (supported[claimId][msg.sender]) revert AlreadySupported();
        } else {
            claimId = nextClaimId++;
            claims[claimId] = Claim({
                tokenId: tokenId,
                kind: kind,
                state: State.Open,
                attester: msg.sender,
                subject: subject,
                value: value,
                bond: 0,
                support: 0,
                postedAt: block.timestamp,
                cid: cid
            });
        }

        stasis.bond(msg.sender, bond);
        Claim storage c = claims[claimId];
        bondOf[claimId][msg.sender] += bond;
        c.bond += bond;
        if (bondOf[claimId][msg.sender] == bond) {
            supporters[claimId].push(msg.sender);
        }
        supported[claimId][msg.sender] = true;
        c.support += 1;

        emit Attested(claimId, tokenId, kind, msg.sender, c.support, cid);

        if (c.state == State.Open && c.support >= quorum[kind]) {
            _execute(claimId);
        }
    }

    function _findOpen(uint256 tokenId, Kind kind, uint256 value, address subject) internal view returns (uint256) {
        // MVP note: linear scan. Fine for a testnet demo with dozens of claims;
        // replace with an index keyed on (tokenId, kind) before a real pilot.
        for (uint256 id = 1; id < nextClaimId; id++) {
            Claim storage c = claims[id];
            if (c.state == State.Open && c.tokenId == tokenId && c.kind == kind && c.value == value && c.subject == subject) {
                return id;
            }
        }
        return 0;
    }

    // -------------------------------------------------------------- disputes

    /// @notice Challenge an open claim with your own bonded Stasis. The winner
    ///         keeps their bond; the loser's is destroyed.
    function dispute(uint256 claimId, uint256 bond) external {
        Claim storage c = claims[claimId];
        if (c.state != State.Open) revert AlreadyResolved();
        if (bond < minBond) revert InsufficientBond();

        stasis.bond(msg.sender, bond);
        disputer[claimId] = msg.sender;
        disputeBond[claimId] = bond;
        c.state = State.Disputed;

        emit ClaimDisputed(claimId, msg.sender);
    }

    /// @notice MVP resolution path: the pilot operator (or a later multisig)
    ///         decides a disputed claim. This is the deliberate centralised
    ///         backstop for claims that move real-world state.
    function resolve(uint256 claimId, bool upheld) external onlyOwner {
        Claim storage c = claims[claimId];
        if (c.state != State.Disputed) revert NotDisputed();

        address challenger = disputer[claimId];

        if (upheld) {
            _returnAllBonds(claimId, challenger);
            if (disputeBond[claimId] > 0) {
                stasis.slashBonded(challenger, disputeBond[claimId], "lost dispute");
            }
            disputeBond[claimId] = 0;
            c.state = State.Open;
            if (c.support >= quorum[c.kind]) _execute(claimId);
        } else {
            _slashAllBonds(claimId, challenger);
            if (disputeBond[claimId] > 0) {
                stasis.unbond(challenger, disputeBond[claimId]);
            }
            c.state = State.Refuted;
        }

        emit ClaimResolved(claimId, upheld);
    }

    // ------------------------------------------------------------ execution

    function _execute(uint256 claimId) internal {
        Claim storage c = claims[claimId];
        if (c.state == State.Executed) return;

        Kind kind = c.kind;
        uint256 tokenId = c.tokenId;

        if (kind == Kind.Death) {
            cowRating.markMemorial(tokenId);
        } else if (kind == Kind.Sale) {
            cowRating.realWorldTransfer(tokenId, c.subject);
        } else if (kind == Kind.FundingNeed) {
            cowRating.recordFundingNeed(tokenId, c.value, c.subject == address(0) ? c.attester : c.subject);
        }
        // Existence, Care and Revenue are recorded evidence: they do not move
        // state on their own — users boost the cow after reading them.

        c.state = State.Executed;
        _returnAllBonds(claimId, address(0));

        emit ClaimExecuted(claimId, kind, tokenId);
    }

    function _returnAllBonds(uint256 claimId, address except) internal {
        Claim storage c = claims[claimId];
        address[] storage list = supporters[claimId];
        for (uint256 i = 0; i < list.length; i++) {
            address account = list[i];
            if (account == except) continue;
            uint256 amount = bondOf[claimId][account];
            if (amount == 0) continue;
            bondOf[claimId][account] = 0;
            stasis.unbond(account, amount);
        }
        c.bond = 0;
    }

    function _slashAllBonds(uint256 claimId, address except) internal {
        Claim storage c = claims[claimId];
        address[] storage list = supporters[claimId];
        for (uint256 i = 0; i < list.length; i++) {
            address account = list[i];
            if (account == except) continue;
            uint256 amount = bondOf[claimId][account];
            if (amount == 0) continue;
            bondOf[claimId][account] = 0;
            stasis.slashBonded(account, amount, "claim refuted");
        }
        c.bond = 0;
    }
}

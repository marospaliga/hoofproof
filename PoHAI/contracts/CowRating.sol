// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Stasis} from "./Stasis.sol";
import {CowNFT} from "./CowNFT.sol";
import {ITransferValidator} from "./interfaces/ITransferValidator.sol";

/// @notice Minimal view of Attestation so CowRating can check protection
///         anchors and spend proofs without a circular import.
interface IAttestation {
    function lastExecutedAt(uint256 tokenId, uint8 kind) external view returns (uint256);
    function executedCount(uint8 kind) external view returns (uint256);
    function claimState(uint256 claimId) external view returns (uint8);
    function claimToken(uint256 claimId) external view returns (uint256);
}

/// @title CowRating — fluid rating, conviction staking, sustainability lifecycle
///
/// Money and rating are two separate fields of the system:
///  - money buys a *share* of a cow (handled off the rating path entirely);
///  - rating is the only thing that grants influence, activates a cow, or
///    moves one to a new owner.
///
/// Rating is non-transferable between people, but it can be *committed* —
/// staked onto a cow, or voiced as a thumbs-up on the cow or on content under
/// it, and spent as the cost of a transfer. **A voice is simply rating
/// committed**: there is no size ladder and no weighting formula, so voting
/// harder means spending more rating. The rating you commit is refundable once
/// the lock period elapses; there is no separate budget or power meter, because
/// your rating *is* the budget.
contract CowRating is Ownable, ITransferValidator {
    uint256 public constant BPS = 10_000;

    // ---- staking
    uint256 public activationThreshold = 1_000; // weighted rating to leave Inert
    uint256 public concentrationCapBps = 2_000; // one account may hold at most 20%
    uint256 public lockPeriod = 30 days; // conviction window
    uint256 public earlyUnlockPenaltyBps = 5_000; // max 50%, scaled by time remaining

    // ---- voting (rating put behind a cow)
    /// @notice A voice is simply rating committed. There is no size ladder:
    ///         rating *is* the amount, and it is refundable until the lock
    ///         period elapses (see `unvote`). `minVoice` is only a dust guard.
    uint256 public minVoice = 1;
    /// @notice Recent, sustained activity still marks an account as a live
    ///         participant — it no longer scales a vote, it only feeds the
    ///         activity ledger the cycle credit pays out against.
    uint256 public momentumDecay = 90 days;
    uint256 public maxActivityPoints = 500;

    // ---- sweat equity (real-world care work)
    uint256 public sweatBaseRate = 1; // reputation points per attested hour
    uint256 public sweatRatingReference = 1_000; // rating that pays the base rate
    uint256 public sweatFactorCapBps = 30_000; // max 3x for the highest-rated work
    uint256 public sweatFactorFloorBps = 2_000; // fresh projects still pay 0.2x

    // ---- herds
    uint256 public herdBonusBps = 500; // +5% per additional member
    uint256 public maxHerdBonusBps = 5_000; // capped at +50%

    // ---- sustainability lifecycle
    uint256 public needPeriod = 30 days;
    uint256 public zeroStreakRequired = 3; // consecutive zero-need periods
    uint256 public creditBps = 1_000; // 10% of the reduction is credited to the solver

    // ---- transfers
    uint256 public baseTransferCost = 500;
    uint256 public minTransferCost = 50;
    uint256 public transferRatingCap = 4_000; // rating above this stops raising the cost
    uint256 public maxBuyerDiscountBps = 5_000; // a high-rating buyer pays at most 50% less
    uint256 public discountScale = 10_000; // score needed to reach the max discount

    /// What a vote may target. Cow = the whole record; Image and Post are
    /// content on/off the cow — rating them is rating their authenticity.
    enum VoteKind {
        Cow,
        Image,
        Post
    }

    struct Stake {
        uint256 amount;
        uint256 since;
        uint8 tier; // conviction lock tier: 0 flexible, 1 = 90d, 2 = 180d
        uint256 weighted; // last recorded contribution (recomputed on touch)
    }

    struct Funding {
        uint256 need;
        uint256 lastRecord;
        uint256 zeroStreak;
    }

    Stasis public stasis;
    CowNFT public cowNFT;
    address public attestation;

    mapping(uint256 => mapping(address => Stake)) public stakes;
    mapping(uint256 => uint256) public totalStaked;
    /// Staked rating weighted by conviction (tier ramp). Activation is decided
    /// on this, so longer commitments push a cow toward Active faster.
    mapping(uint256 => uint256) public totalWeightedStaked;
    mapping(uint256 => uint256) public cowRating;
    /// Content-level ratings: contentRating[tokenId][cidHash][kind bps bytes].
    mapping(uint256 => mapping(bytes32 => mapping(uint8 => uint256))) public contentRating;
    mapping(uint256 => Funding) public funding;

    /// Lazy activity ledger (decays at read time).
    mapping(address => uint256) public activity;
    mapping(address => uint256) public activityAt;

    /// Accounts that ever touched the activity ledger, in first-touch order.
    /// The GeneralPool cycle credit enumerates this registry and measures each
    /// rater's activity *delta* since the previous settle — so being active is
    /// what qualifies for the cycle thank-you, not holding a big score.
    address[] private _activeAccounts;
    mapping(address => bool) private _seenAccount;

    // ---- platform-level aggregates (consumed by the GeneralPool value index)
    uint256 public totalBacking;
    uint256 public totalRatingPoints;
    uint256 public activeCowCount;

    /// @notice Need-weights (BPS-scaled: 10_000 = 1x, 0 = unset -> 1x): set the
    ///         value the system currently lacks, and contributing to it earns
    ///         boosted rating. Owner-set in the MVP; a weighted-vote setter
    ///         ships in v2 (money is out of scope first).
    mapping(bytes32 => uint256) public parameter;

    // ---- content registry (author attribution for the Steemit-style split)
    mapping(bytes32 => address) public contentAuthor;
    mapping(bytes32 => uint256) public contentTokenId;
    mapping(bytes32 => uint256) public contentLastActive;
    mapping(bytes32 => bool) public contentProtectionLinked;
    /// @notice Content with no vote/heartbeat inside this window goes dormant:
    ///         new votes freeze, existing voice locks can be reaped.
    uint256 public contentDormantWindow = 180 days;

    // ---- protection anchor windows (anti-speculation gate for all payoffs)
    uint256 public careWindow = 90 days;
    uint256 public laborWindow = 90 days;
    uint256 public needWindow = 90 days;

    // ---- voices (rating committed to a cow or to content under it)
    /// @notice Base author share of a vote's value, pre whale-damping.
    uint256 public authorShareBps = 1_000; // 10%
    mapping(address => uint256) public voiceLocked;
    mapping(address => mapping(bytes32 => uint256)) public lockOf;
    mapping(address => mapping(bytes32 => uint256)) public lockAt;
    /// @notice Earliest time a lock may be released (labor conviction locks).
    mapping(address => mapping(bytes32 => uint256)) public lockUntil;
    struct LockTarget {
        uint256 tokenId;
        uint8 kind;
        bytes32 cidHash;
        bool isBoost;
        bool set;
    }
    mapping(bytes32 => LockTarget) public lockTarget;
    mapping(address => bytes32[]) private _voterKeys;
    mapping(address => mapping(bytes32 => uint256)) private _voterKeyPos; // 1-based

    // ---- author awards
    /// @notice Cap on the share of a curator's voice that can be transferred
    ///         to an author, so a single vote cannot hand over a whole lien.
    uint256 public authorAwardCapBps = 2_000; // 20%

    // ---- labor conviction (worker chooses how much of the minted reward to commit)
    /// @notice Share of an attested-labor reward the worker commits back as
    ///         cow rating (a lien on their own fresh Stasis). Set by the worker.
    mapping(address => uint16) public laborCommitBps;
    /// @notice Conviction window before a labor lien can be released.
    uint256 public laborLockPeriod = 30 days;
    uint256 private _laborLockNonce;

    // ---- moderation hook (content slashing)
    address public moderation;
    /// @notice Capped burn on hidden content, share of each voter's lien.
    uint256 public moderationSlashBps = 5_000; // up to 50%
    mapping(bytes32 => bool) public contentHidden;
    mapping(bytes32 => address[]) public keyVoters;
    mapping(bytes32 => mapping(address => bool)) private _isKeyVoter;
    mapping(bytes32 => uint256) public slashCursor;

    // ---- protection activity (cumulative; gates the gas rebate with momentum)
    mapping(address => uint256) public protectionActivity;
    uint256 public maxProtectionActivity = 500;

    // ---- oracle credibility (reputation that documents)
    /// @notice Cumulative author awards received: the oracle's track record.
    mapping(address => uint256) public oracleCred;
    /// @notice Provisional head starts awaiting independent corroboration.
    mapping(bytes32 => uint256) public contentProvisional;
    mapping(bytes32 => uint256) public contentProvisionalSince;
    /// @notice Head start = cred x this share, capped, for new protection docs.
    uint256 public headStartBps = 500; // 5% of credibility
    uint256 public maxHeadStart = 200;
    /// @notice Window for an independent vote to lock a head start in.
    uint256 public headStartWindow = 30 days;

    // ---- conviction staking tiers (proof-of-stake x proof-of-time, lazy)
    uint256 public tierCap0Bps = 10_000; // flexible: 1.00x
    uint256 public tierCap1Bps = 12_500; // 90d commit: 1.25x
    uint256 public tierCap2Bps = 15_000; // 180d commit: 1.50x
    uint256 public tierCommit1 = 90 days;
    uint256 public tierCommit2 = 180 days;
    uint256 public tierPenalty1Bps = 12_500; // 90d exit hurts 1.25x the base curve
    uint256 public tierPenalty2Bps = 15_000; // 180d exit hurts 1.50x the base curve

    // ---- protection aggregates (consumed by the GeneralPool cycle credit)
    uint256 public totalLaborHours;
    uint256 public selfSustainingCount;

    event Staked(uint256 indexed tokenId, address indexed account, uint256 amount, uint256 totalStaked);
    event Unstaked(uint256 indexed tokenId, address indexed account, uint256 amount, uint256 returned);
    event Voted(uint256 indexed tokenId, address indexed account, uint8 kind, bytes32 cidHash, uint256 weight, uint256 newRating);
    event Boosted(uint256 indexed tokenId, address indexed account, bytes32 category, uint256 weight, uint256 newRating);
    event LaborRewarded(uint256 indexed tokenId, address indexed worker, uint256 attestedHours, uint256 reward);
    event FundingNeedRecorded(uint256 indexed tokenId, uint256 previous, uint256 current, address solver);
    event SelfSustaining(uint256 indexed tokenId);
    event TransferValidated(uint256 indexed tokenId, address indexed from, address indexed to, uint256 cost);
    event ParameterSet(bytes32 indexed key, uint256 value);
    event WiringSet(address indexed cowNFT, address indexed attestation);
    event ContentRegistered(uint256 indexed tokenId, uint8 kind, bytes32 indexed cidHash, address indexed author, bool protectionLinked);
    event ContentRewarded(uint256 indexed tokenId, uint8 kind, bytes32 indexed cidHash, address indexed author, address curator, uint256 award, bool isSelf);
    event Unvoted(address indexed voter, bytes32 indexed key, uint256 freedWeight);
    event ConvictionPoked(uint256 indexed tokenId, address indexed account, uint256 newWeighted);
    event HeadStartGranted(uint256 indexed tokenId, uint8 kind, bytes32 indexed cidHash, address indexed author, uint256 amount);
    event HeadStartReaped(bytes32 indexed key, uint256 amount);
    event LaborCommitted(uint256 indexed tokenId, address indexed worker, uint256 amount, uint256 unlockAt);
    event ModerationSet(address indexed moderation, uint256 slashBps);
    event ContentFlagged(uint256 indexed tokenId, bytes32 indexed key, bool hidden);
    event ContentSlashed(bytes32 indexed key, address indexed voter, uint256 amount);
    error OnlyCowNFT();
    error OnlyAttestation();
    error ZeroAmount();
    error ConcentrationCap();
    error InsufficientStake();
    error PeriodNotElapsed();
    error InvalidBoost();
    error NoVotingPower();
    error IsMemorial();
    error WeightTooLow();
    error AlreadyWired();
    error AlreadyRegistered();
    error UnknownContent();
    error AuthorMismatch();
    error DormantContent();
    error VoiceBudgetExceeded();
    error NothingLocked();
    error TierMismatch();
    error BadTier();
    error TooManyKeys();
    error NoAnchor();
    error NothingProvisional();
    error ProvisionalLocked();
    error LockedUntil();
    error ContentHidden();
    error OnlyModeration();
    error NotHidden();
    error NothingToSlash();

    constructor(address stasis_) Ownable(msg.sender) {
        stasis = Stasis(stasis_);
    }

    // ----------------------------------------------------------- deployment

    function setWiring(address cowNFT_, address attestation_) external onlyOwner {
        if (address(cowNFT) != address(0) && attestation != address(0)) revert AlreadyWired();
        if (cowNFT_ != address(0)) cowNFT = CowNFT(cowNFT_);
        if (attestation_ != address(0)) attestation = attestation_;
        emit WiringSet(cowNFT_, attestation_);
    }

    function setParameter(bytes32 key, uint256 value) external onlyOwner {
        parameter[key] = value;
        emit ParameterSet(key, value);
    }

    function setContentDormantWindow(uint256 window) external onlyOwner {
        contentDormantWindow = window;
    }

    /// @notice Tune the labor conviction window and the moderation slash cap.
    function setRatingPolicy(
        uint16, /* discussion (unused: a voice is rating, no kind weighting) */
        uint16, /* evidence */
        uint16, /* cowVote */
        uint8, /* mode */
        uint256, /* curveRef */
        uint256 lockPeriod_,
        uint256 slashBps
    ) external onlyOwner {
        if (slashBps > BPS) revert InvalidBoost();
        laborLockPeriod = lockPeriod_;
        moderationSlashBps = slashBps;
    }

    /// @notice Wire the moderation contract allowed to flag hidden content.
    function setModeration(address moderation_, uint256 slashBps) external onlyOwner {
        if (slashBps > BPS) revert InvalidBoost();
        moderation = moderation_;
        moderationSlashBps = slashBps;
    }

    /// @notice Choose how much of each future attested-labor reward to commit
    ///         back to the cow as rating (0..10_000 bps).
    function setLaborCommitBps(uint16 bps) external {
        if (bps > BPS) revert InvalidBoost();
        laborCommitBps[msg.sender] = bps;
    }

    // -------------------------------------------------------------- staking

    function _concentrationBase(uint256 tokenId) internal view returns (uint256) {
        uint256 base = totalStaked[tokenId];
        // Before a cow reaches threshold the cap is measured against the
        // threshold itself, so a single account can never activate a cow alone.
        return base < activationThreshold ? activationThreshold : base;
    }

    /// @notice Commit rating to a cow. Committed rating is bonded — it can no
    ///         longer be spent elsewhere, and it is what makes backing a claim costly.
    ///         Flexible tier (1.00x, no commitment); see `stakeRatingTiered`.
    function stakeRating(uint256 tokenId, uint256 amount) external {
        _stake(tokenId, amount, 0);
    }

    /// @notice Commit rating with a conviction lock tier: 0 = flexible (1.00x),
    ///         1 = 90d commit (up to 1.25x), 2 = 180d commit (up to 1.50x).
    ///         Weight ramps from 1.00x toward the tier cap over the commit
    ///         period (lazy: accrues on touch, see `pokeStake`).
    function stakeRatingTiered(uint256 tokenId, uint256 amount, uint8 tier) external {
        if (tier > 2) revert BadTier();
        _stake(tokenId, amount, tier);
    }

    function _tierCap(uint8 tier) internal view returns (uint256) {
        if (tier == 1) return tierCap1Bps;
        if (tier == 2) return tierCap2Bps;
        return tierCap0Bps;
    }

    function _tierCommit(uint8 tier) internal view returns (uint256) {
        if (tier == 1) return tierCommit1;
        if (tier == 2) return tierCommit2;
        return lockPeriod;
    }

    /// @notice Current conviction multiplier (BPS) for a stake vintage.
    function convictionBps(uint256 since, uint8 tier) public view returns (uint256) {
        uint256 cap = _tierCap(tier);
        if (cap <= BPS || since == 0) return BPS;
        uint256 elapsed = block.timestamp > since ? block.timestamp - since : 0;
        uint256 commit = _tierCommit(tier);
        if (elapsed >= commit) return cap;
        return BPS + ((cap - BPS) * elapsed) / commit;
    }

    function _stake(uint256 tokenId, uint256 amount, uint8 tier) internal {
        if (amount == 0) revert ZeroAmount();
        if (cowNFT.statusOf(tokenId) == CowNFT.Status.Memorial) revert IsMemorial();

        Stake storage s = stakes[tokenId][msg.sender];
        if (s.amount > 0 && s.tier != tier) revert TierMismatch();
        uint256 allowed = (_concentrationBase(tokenId) * concentrationCapBps) / BPS;
        if (s.amount + amount > allowed) revert ConcentrationCap();

        stasis.bond(msg.sender, amount); // reverts unless the account has free score

        // Refresh the existing vintage to today's conviction before mutating,
        // so `totalWeightedStaked` stays exactly the sum of contributions.
        totalWeightedStaked[tokenId] -= s.weighted;
        if (s.since == 0) {
            s.since = block.timestamp;
            s.tier = tier;
        }
        s.amount += amount;
        s.weighted = (s.amount * convictionBps(s.since, s.tier)) / BPS;
        totalStaked[tokenId] += amount;
        totalBacking += amount;
        totalWeightedStaked[tokenId] += s.weighted;
        _touchActivity(msg.sender, 1);

        emit Staked(tokenId, msg.sender, amount, totalStaked[tokenId]);

        _tryActivate(tokenId);
    }

    function _tryActivate(uint256 tokenId) internal {
        if (totalWeightedStaked[tokenId] >= activationThreshold && cowNFT.statusOf(tokenId) == CowNFT.Status.Inert) {
            activeCowCount += 1;
            cowNFT.markActive(tokenId);
        }
    }

    /// @notice Permissionless refresh of anyone's conviction vintage: accrues
    ///         time-weight into `totalWeightedStaked` and may flip the cow Active.
    function pokeStake(uint256 tokenId, address account) external {
        Stake storage s = stakes[tokenId][account];
        if (s.amount == 0) return;
        totalWeightedStaked[tokenId] -= s.weighted;
        s.weighted = (s.amount * convictionBps(s.since, s.tier)) / BPS;
        totalWeightedStaked[tokenId] += s.weighted;
        emit ConvictionPoked(tokenId, account, s.weighted);
        _tryActivate(tokenId);
    }

    /// @notice Withdraw committed rating. Leaving early costs rating, scaled by
    ///         how much of the lock period was left — longer tiers exit harsher.
    function unstakeRating(uint256 tokenId, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        Stake storage s = stakes[tokenId][msg.sender];
        if (s.amount < amount) revert InsufficientStake();

        uint256 returned = amount;
        uint256 elapsed = block.timestamp - s.since;
        if (elapsed < lockPeriod) {
            uint256 remaining = lockPeriod - elapsed;
            uint256 penaltyMult = s.tier == 1 ? tierPenalty1Bps : s.tier == 2 ? tierPenalty2Bps : BPS;
            uint256 earlyPenalty = (amount * earlyUnlockPenaltyBps * penaltyMult * remaining) / (BPS * BPS * lockPeriod);
            if (earlyPenalty > amount) earlyPenalty = amount;
            returned = amount - earlyPenalty;
        }

        stasis.unbond(msg.sender, amount);

        totalWeightedStaked[tokenId] -= s.weighted;
        s.amount -= amount;
        if (s.amount == 0) {
            s.since = 0;
            s.weighted = 0;
        } else {
            s.weighted = (s.amount * convictionBps(s.since, s.tier)) / BPS;
            totalWeightedStaked[tokenId] += s.weighted;
        }
        totalStaked[tokenId] -= amount;
        totalBacking -= amount;

        uint256 penalty = amount - returned;
        if (penalty > 0) stasis.spend(msg.sender, penalty, "early unlock");

        emit Unstaked(tokenId, msg.sender, amount, returned);
    }

    // ----------------------------------------------------------- activity ledger

    function _activityAt(address account) internal view returns (uint256) {
        uint256 last = activityAt[account];
        if (last == 0) return 0;
        uint256 elapsed = block.timestamp > last ? block.timestamp - last : 0;
        if (elapsed >= momentumDecay) return 0;
        return activity[account] - (activity[account] * elapsed) / momentumDecay;
    }

    function _touchActivity(address account, uint256 points) internal {
        if (points == 0) return;
        if (!_seenAccount[account]) {
            _seenAccount[account] = true;
            _activeAccounts.push(account);
        }
        uint256 current = _activityAt(account);
        uint256 next = current + points;
        if (next > maxActivityPoints) next = maxActivityPoints;
        activity[account] = next;
        activityAt[account] = block.timestamp;
    }

    /// @notice Cumulative, uncapped-decay protection ledger: only care labor,
    ///         solver credits and protection-linked curation touch it. Gates the
    ///         gas rebate.
    function _touchProtection(address account, uint256 points) internal {
        if (points == 0 || account == address(0)) return;
        uint256 next = protectionActivity[account] + points;
        if (next > maxProtectionActivity) next = maxProtectionActivity;
        protectionActivity[account] = next;
    }

    /// @notice Public read of the (decayed) activity ledger. The GeneralPool
    ///         uses it to size each rater's share of the cycle credit: share ∝
    ///         how much their activity moved *since the previous settle*.
    function activityPoints(address account) public view returns (uint256) {
        return _activityAt(account);
    }

    /// @notice Number of accounts that ever touched the activity ledger.
    function activeAccountCount() external view returns (uint256) {
        return _activeAccounts.length;
    }

    function activeAccounts(uint256 i) external view returns (address) {
        return _activeAccounts[i];
    }

    // ----------------------------------------------------------------- voting

    function contentKeyOf(uint256 tokenId, uint8 kind, bytes32 cidHash) public pure returns (bytes32) {
        return keccak256(abi.encode(tokenId, kind, cidHash));
    }

    function cowKeyOf(uint256 tokenId) public pure returns (bytes32) {
        return keccak256(abi.encode("cow-voice", tokenId));
    }

    /// @notice Claim authorship of a discussion post (kind 2) or image/evidence
    ///         (kind 1) ahead of voting. First claim wins; re-claims by the same
    ///         author act as a heartbeat. Votes on unregistered content
    ///         auto-register the voter (see `_vote`).
    function registerContent(uint256 tokenId, uint8 kind, bytes32 cidHash, bool protectionLinked) external {
        if (kind != uint8(VoteKind.Image) && kind != uint8(VoteKind.Post)) revert InvalidBoost();
        cowNFT.statusOf(tokenId); // reverts for never-minted tokens
        bytes32 key = contentKeyOf(tokenId, kind, cidHash);
        address existing = contentAuthor[key];
        if (existing != address(0) && existing != msg.sender) revert AlreadyRegistered();
        contentAuthor[key] = msg.sender;
        contentTokenId[key] = tokenId;
        contentLastActive[key] = block.timestamp;
        if (existing == address(0)) {
            contentProtectionLinked[key] = protectionLinked;
            _grantHeadStart(tokenId, kind, cidHash, key, msg.sender);
        }
        emit ContentRegistered(tokenId, kind, cidHash, msg.sender, contentProtectionLinked[key]);
    }

    /// @notice Credibility head start: a proven documenter's new protection doc
    ///         arrives trusted (capped % of earned credibility). It is *not*
    ///         free rating — the author pledges it from their own Stasis, capped
    ///         by their remaining voice budget, so rating stays fully backed.
    ///         Provisional: evaporates unless an independent vote corroborates.
    function _grantHeadStart(uint256 tokenId, uint8 kind, bytes32 cidHash, bytes32 key, address author) internal {
        if (!contentProtectionLinked[key]) return;
        uint256 cred = oracleCred[author];
        if (cred == 0) return;
        uint256 headStart = (cred * headStartBps) / BPS;
        if (headStart > maxHeadStart) headStart = maxHeadStart;

        // Only as much as the author can actually voice: free score bounds the
        // pledge. There is no separate voice budget any more — rating is it.
        uint256 free = stasis.freeScore(author);
        if (headStart > free) headStart = free;
        if (headStart == 0) return;

        if (!lockTarget[key].set) {
            lockTarget[key] = LockTarget(tokenId, kind, cidHash, false, true);
        }
        stasis.voice(author, headStart);
        _recordLock(author, key, headStart);
        contentRating[tokenId][cidHash][kind] += headStart;
        cowRating[tokenId] += headStart;
        totalRatingPoints += headStart;
        contentProvisional[key] = headStart;
        contentProvisionalSince[key] = block.timestamp;
        emit HeadStartGranted(tokenId, kind, cidHash, author, headStart);
    }

    /// @notice Permissionless cleanup of an uncorroborated head start past its
    ///         window. Corroborated head starts (provisional == 0) are permanent.
    function reapProvisional(bytes32 key) external {
        uint256 amount = contentProvisional[key];
        if (amount == 0) revert NothingProvisional();
        if (block.timestamp - contentProvisionalSince[key] <= headStartWindow) revert ProvisionalLocked();
        contentProvisional[key] = 0;

        // Release the author's pledged lien.
        address author = contentAuthor[key];
        if (author != address(0) && lockOf[author][key] >= amount) {
            stasis.unvoice(author, amount);
            lockOf[author][key] -= amount;
            voiceLocked[author] -= amount;
            if (lockOf[author][key] == 0) _removeKey(author, key);
        }

        _subtractRating(key, amount);
        emit HeadStartReaped(key, amount);
    }

    /// @notice Content is votable while its cow lives and it saw activity
    ///         inside the dormancy window. Memorial freezes everything.
    function contentIsActive(bytes32 key) public view returns (bool) {
        if (contentAuthor[key] == address(0)) return false;
        uint256 tokenId = contentTokenId[key];
        if (address(cowNFT) == address(0)) return true;
        if (cowNFT.statusOf(tokenId) == CowNFT.Status.Memorial) return false;
        return block.timestamp - contentLastActive[key] < contentDormantWindow;
    }

    /// @notice A cow is a live protection project while Active with a fresh
    ///         quorum'd Care claim, executed Labor, or funding-need record.
    ///         Every payoff — Stasis mints and ETH releases — keys off this.
    function protectionAnchorLive(uint256 tokenId) public view returns (bool) {
        if (address(cowNFT) == address(0)) return false;
        if (cowNFT.statusOf(tokenId) != CowNFT.Status.Active) return false;
        uint256 t = block.timestamp;
        if (address(attestation) != address(0)) {
            IAttestation a = IAttestation(attestation);
            if (t - a.lastExecutedAt(tokenId, 1) < careWindow) return true; // Care
            if (t - a.lastExecutedAt(tokenId, 6) < laborWindow) return true; // Labor
        }
        Funding storage f = funding[tokenId];
        if (f.lastRecord != 0 && t - f.lastRecord < needWindow) return true;
        return false;
    }

    /// @notice Total executed Care quorums (protection aggregate for the cycle).
    function careQuorumCount() public view returns (uint256) {
        if (attestation == address(0)) return 0;
        return IAttestation(attestation).executedCount(1);
    }

    /// @notice Proof helper for money-moving contracts: cite an executed claim.
    function attestationProof(uint256 claimRef) public view returns (bool executed, uint256 tokenId) {
        if (attestation == address(0) || claimRef == 0) return (false, 0);
        IAttestation a = IAttestation(attestation);
        executed = a.claimState(claimRef) == 1; // Attestation.State.Executed
        tokenId = a.claimToken(claimRef);
    }

    /// @notice Whale-damped author share: small votes pay ~full 10%, votes big
    ///         enough to move the field pay a fraction.
    function authorAwardPreview(uint256 weight) public view returns (uint256) {
        uint256 total = totalRatingPoints;
        if (total == 0 || weight == 0) return 0;
        return (weight * authorShareBps * total) / (BPS * (total + weight));
    }

    /// @notice Subtract `amount` of rating from wherever `key` stores it: the
    ///         cow, its content rating, and the platform total. Shared by
    ///         unvote, dilution, reaping, awards and moderation slashing.
    function _subtractRating(bytes32 key, uint256 amount) internal {
        if (amount == 0) return;
        LockTarget storage t = lockTarget[key];
        if (!t.set) {
            if (totalRatingPoints >= amount) totalRatingPoints -= amount;
            else totalRatingPoints = 0;
            return;
        }
        if (cowRating[t.tokenId] >= amount) {
            cowRating[t.tokenId] -= amount;
            totalRatingPoints -= amount;
        } else {
            totalRatingPoints -= cowRating[t.tokenId];
            cowRating[t.tokenId] = 0;
        }
        if (!t.isBoost && t.kind != uint8(VoteKind.Cow)) {
            uint256 cr = contentRating[t.tokenId][t.cidHash][t.kind];
            contentRating[t.tokenId][t.cidHash][t.kind] = cr > amount ? cr - amount : 0;
        }
    }

    function _recordLock(address voter, bytes32 key, uint256 amount) internal {
        if (lockOf[voter][key] == 0) {
            _voterKeys[voter].push(key);
            _voterKeyPos[voter][key] = _voterKeys[voter].length; // 1-based
            if (!_isKeyVoter[key][voter]) {
                _isKeyVoter[key][voter] = true;
                keyVoters[key].push(voter);
            }
        }
        lockOf[voter][key] += amount;
        lockAt[voter][key] = block.timestamp;
        voiceLocked[voter] += amount;
    }

    function _removeKey(address voter, bytes32 key) internal {
        uint256 pos = _voterKeyPos[voter][key];
        if (pos == 0) return;
        uint256 last = _voterKeys[voter].length;
        if (pos != last) {
            bytes32 moved = _voterKeys[voter][last - 1];
            _voterKeys[voter][pos - 1] = moved;
            _voterKeyPos[voter][moved] = pos;
        }
        _voterKeys[voter].pop();
        delete _voterKeyPos[voter][key];
    }

    function _freeLock(address voter, bytes32 key, uint256 amount) internal {
        // Release the lien first: the Stasis returns to the voter's free pool.
        stasis.unvoice(voter, amount);
        lockOf[voter][key] -= amount;
        voiceLocked[voter] -= amount;
        if (lockOf[voter][key] == 0) _removeKey(voter, key);
        // If the author releases their own lien, the provisional head start it
        // carried is no longer separable and must not be reaped twice.
        if (contentProvisional[key] > 0 && voter == contentAuthor[key]) {
            contentProvisional[key] = 0;
        }
        _subtractRating(key, amount);
    }

    function _noteTarget(bytes32 key, uint256 tokenId, uint8 kind, bytes32 cidHash, bool isBoost) internal {
        if (!lockTarget[key].set) {
            lockTarget[key] = LockTarget(tokenId, kind, cidHash, isBoost, true);
        }
    }

    function _lockVoice(address voter, bytes32 key, uint256 amount) internal {
        // Committing voice *is* spending Stasis: the lien is a real Stasis
        // lien, not a shadow counter. There is no per-voter budget — your
        // rating is the budget, and it is consumed as you use it.
        stasis.voice(voter, amount);
        _recordLock(voter, key, amount);
    }

    function _applyVote(uint256 tokenId, uint8 kind, bytes32 cidHash, uint256 amount) internal returns (uint256) {
        cowRating[tokenId] += amount;
        totalRatingPoints += amount;
        if (kind != uint8(VoteKind.Cow)) {
            contentRating[tokenId][cidHash][kind] += amount;
        }
        return cowRating[tokenId];
    }

    /// @notice Rate a cow, image or post by spending `amount` of rating.
    ///         There is no size ladder: the amount *is* the weight, so rating
    ///         harder means spending more rating. Protection-linked votes on
    ///         anchored cows additionally pay the author a damped award.
    function vote(uint256 tokenId, uint8 kind, bytes32 cidHash, uint256 amount) external {
        _vote(tokenId, kind, cidHash, amount, address(0));
    }

    /// @notice Attributed vote: `author` must match the content registry
    ///         (`address(0)` behaves like the legacy call).
    function vote(uint256 tokenId, uint8 kind, bytes32 cidHash, uint256 amount, address author) external {
        _vote(tokenId, kind, cidHash, amount, author);
    }

    /// @notice Resolve (or first-claim) the content registry for a vote.
    ///         An independent touch corroborates a provisional head start,
    ///         locking it in permanently.
    function _resolveContent(uint256 tokenId, uint8 kind, bytes32 cidHash, address author)
        internal
        returns (bytes32 key)
    {
        key = contentKeyOf(tokenId, kind, cidHash);
        address reg = contentAuthor[key];
        if (reg == address(0)) {
            // First touch claims authorship for the voter.
            if (author != address(0) && author != msg.sender) revert AuthorMismatch();
            contentAuthor[key] = msg.sender;
            contentTokenId[key] = tokenId;
            contentLastActive[key] = block.timestamp;
            emit ContentRegistered(tokenId, kind, cidHash, msg.sender, false);
            _grantHeadStart(tokenId, kind, cidHash, key, msg.sender);
        } else {
            if (author != address(0) && author != reg) revert AuthorMismatch();
            if (!contentIsActive(key)) revert DormantContent();
            contentLastActive[key] = block.timestamp;
            if (msg.sender != reg && contentProvisional[key] > 0) {
                contentProvisional[key] = 0; // corroborated: head start is earned
            }
        }
    }

    function _vote(uint256 tokenId, uint8 kind, bytes32 cidHash, uint256 amount, address author) internal {
        if (kind > uint8(VoteKind.Post)) revert InvalidBoost();
        if (amount < minVoice) revert WeightTooLow();
        if (cowNFT.statusOf(tokenId) == CowNFT.Status.Memorial) revert IsMemorial();

        bytes32 lockKey = kind == uint8(VoteKind.Cow)
            ? cowKeyOf(tokenId)
            : _resolveContent(tokenId, kind, cidHash, author);

        _noteTarget(lockKey, tokenId, kind, cidHash, false);
        _lockVoice(msg.sender, lockKey, amount);
        _touchActivity(msg.sender, 2);
        uint256 newRating = _applyVote(tokenId, kind, cidHash, amount);
        _rewardContent(lockKey, amount);
        emit Voted(tokenId, msg.sender, kind, cidHash, amount, newRating);
    }

    /// @notice Protection-gated author award, read from storage (thin stack).
    /// @notice Protection-gated author award, read from storage (thin stack).
    ///         Every content vote is logged; only anchored protection-linked
    ///         votes pay — and they pay by **transferring** a slice of the
    ///         voter's lien to the author, so rating becomes spendable Stasis
    ///         without inflating the supply.
    function _rewardContent(bytes32 lockKey, uint256 weight) internal {
        LockTarget storage t = lockTarget[lockKey];
        if (!t.set || t.isBoost || t.kind == uint8(VoteKind.Cow)) return;
        address creator = contentAuthor[lockKey];
        if (creator == address(0)) return;
        uint256 award = 0;
        if (contentProtectionLinked[lockKey]) {
            // Curating protection-linked content counts as protection work even
            // before the cow's anchor is live; only the payout needs the anchor.
            _touchProtection(msg.sender, 1);
            if (protectionAnchorLive(t.tokenId) && msg.sender != creator) {
                award = authorAwardPreview(weight);
                uint256 lien = lockOf[msg.sender][lockKey];
                if (award > lien) award = lien;
                if (award > 0) {
                    stasis.transferVoiced(msg.sender, creator, award);
                    lockOf[msg.sender][lockKey] = lien - award;
                    voiceLocked[msg.sender] -= award;
                    if (lockOf[msg.sender][lockKey] == 0) _removeKey(msg.sender, lockKey);

                    // The author's slice leaves the cow with its author: the
                    // cow keeps the remaining rating.
                    _subtractRating(lockKey, award);

                    oracleCred[creator] += award;
                    _touchProtection(creator, 1);
                }
            }
        }
        emit ContentRewarded(t.tokenId, t.kind, t.cidHash, creator, msg.sender, award, msg.sender == creator);
    }

    /// @notice Release one of your own voice locks (hands the rating straight
    ///         back). Conviction-locked (labor) liens and hidden content stay frozen.
    function unvote(bytes32 key) external {
        uint256 amt = lockOf[msg.sender][key];
        if (amt == 0) revert NothingLocked();
        if (lockUntil[msg.sender][key] > block.timestamp) revert LockedUntil();
        if (contentHidden[key]) revert ContentHidden();
        _freeLock(msg.sender, key, amt);
        emit Unvoted(msg.sender, key, amt);
    }

    /// @notice Permissionless cleanup: free anyone's locks on dormant content.
    ///         Bounded per call (caller-sized, max 20) to avoid gas-DoS.
    function reapStale(address voter, bytes32[] calldata keys) external {
        if (keys.length == 0 || keys.length > 20) revert TooManyKeys();
        uint256 freed;
        for (uint256 i = 0; i < keys.length; i++) {
            bytes32 key = keys[i];
            uint256 amt = lockOf[voter][key];
            if (amt == 0) continue;
            if (contentHidden[key]) continue; // hidden content is slashed, not released
            LockTarget storage t = lockTarget[key];
            bool stale = true;
            if (t.set) {
                if (t.isBoost) {
                    stale = cowNFT.statusOf(t.tokenId) == CowNFT.Status.Memorial;
                } else if (t.kind == uint8(VoteKind.Cow)) {
                    stale = cowNFT.statusOf(t.tokenId) == CowNFT.Status.Memorial;
                } else {
                    stale = !contentIsActive(key);
                }
            }
            if (!stale) continue;
            _freeLock(voter, key, amt);
            freed += amt;
        }
        emit Unvoted(voter, bytes32(0), freed);
    }

    /// @notice Enumerate a voter's locks for meters/previews (view only).
    function voterLocks(address voter)
        external
        view
        returns (bytes32[] memory keys, uint256[] memory amounts, uint256 locked, uint256 budget)
    {
        bytes32[] storage all = _voterKeys[voter];
        uint256 n;
        for (uint256 i = 0; i < all.length; i++) {
            if (lockOf[voter][all[i]] > 0) n++;
        }
        keys = new bytes32[](n);
        amounts = new uint256[](n);
        uint256 j;
        for (uint256 i = 0; i < all.length; i++) {
            uint256 amt = lockOf[voter][all[i]];
            if (amt > 0) {
                keys[j] = all[i];
                amounts[j] = amt;
                j++;
            }
        }
        locked = voiceLocked[voter];
        // Kept for ABI compatibility: the budget *is* the account's rating.
        budget = stasis.effectiveScore(voter);
    }

    /// @notice Commit rating to the whole cow. `category` may reference a
    ///         need-weight parameter, which scales the amount actually applied.
    function boost(uint256 tokenId, bytes32 category, uint256 amount) external {
        if (cowNFT.statusOf(tokenId) == CowNFT.Status.Memorial) revert IsMemorial();
        if (amount < minVoice) revert WeightTooLow();

        uint256 applied = amount;
        uint256 param = parameter[category];
        if (param != 0) applied = (applied * param) / BPS;
        if (applied == 0) revert WeightTooLow();

        bytes32 key = cowKeyOf(tokenId);
        _noteTarget(key, tokenId, 0, bytes32(0), true);
        _lockVoice(msg.sender, key, applied);
        cowRating[tokenId] += applied;
        totalRatingPoints += applied;
        _touchActivity(msg.sender, 2);

        emit Boosted(tokenId, msg.sender, category, applied, cowRating[tokenId]);
    }

    function contentRatingOf(uint256 tokenId, uint8 kind, bytes32 cidHash) external view returns (uint256) {
        return contentRating[tokenId][cidHash][kind];
    }

    /// @notice A cow's rating including the herd-sharing bonus.
    function ratingOf(uint256 tokenId) public view returns (uint256) {
        uint256 base = cowRating[tokenId];
        if (base == 0) return 0;

        (, , uint256 herdId, ) = cowNFT.cows(tokenId);
        if (herdId == 0) return base;

        uint256 members = cowNFT.herdCount(herdId);
        if (members <= 1) return base;

        uint256 bonusBps = herdBonusBps * (members - 1);
        if (bonusBps > maxHerdBonusBps) bonusBps = maxHerdBonusBps;
        return (base * (BPS + bonusBps)) / BPS;
    }

    function stakeOf(uint256 tokenId, address account) external view returns (uint256) {
        return stakes[tokenId][account].amount;
    }

    // -------------------------------------------------------- sweat equity

    /// @notice Reward real care work with reputation. Called by Attestation
    ///         once a Labor claim (hours, worker) reaches quorum. The per-hour
    ///         reward scales with the project's own rating: the same hours are
    ///         worth more on a well-rated cow.
    function rewardLabor(uint256 tokenId, address worker, uint256 attestedHours) external {
        if (msg.sender != attestation) revert OnlyAttestation();
        if (attestedHours == 0 || worker == address(0)) revert ZeroAmount();

        uint256 factor = (ratingOf(tokenId) * BPS) / sweatRatingReference;
        if (factor < sweatFactorFloorBps) factor = sweatFactorFloorBps;
        if (factor > sweatFactorCapBps) factor = sweatFactorCapBps;

        uint256 reward = (attestedHours * sweatBaseRate * factor) / BPS;
        uint256 applied;
        if (reward > 0) applied = stasis.award(worker, reward, "labor");
        _touchActivity(worker, 5);
        _touchProtection(worker, 5);
        totalLaborHours += attestedHours;

        // Labor becomes rating: the worker chooses what share of the freshly
        // minted reward to commit back to the cow, as a lien on their own score.
        uint256 commit = (applied * laborCommitBps[worker]) / BPS;
        if (commit > 0) {
            uint256 free = stasis.freeScore(worker);
            if (commit > free) commit = free;
            if (commit > 0) {
                uint256 unlockAt = block.timestamp + laborLockPeriod;
                bytes32 laborKey = keccak256(abi.encode("labor", tokenId, worker, _laborLockNonce++));
                _noteTarget(laborKey, tokenId, uint8(VoteKind.Cow), bytes32(0), true);
                stasis.voice(worker, commit);
                _recordLock(worker, laborKey, commit);
                lockUntil[worker][laborKey] = unlockAt;
                cowRating[tokenId] += commit;
                totalRatingPoints += commit;
                emit LaborCommitted(tokenId, worker, commit, unlockAt);
            }
        }

        emit LaborRewarded(tokenId, worker, attestedHours, reward);
    }

    // ------------------------------------------------------- moderation slash

    /// @notice Called by Moderation on execution: freeze (or restore) content so
    ///         its liens can be slashed (or released) batch by batch.
    function setContentHidden(uint256 tokenId, bytes32 key, bool hidden) external {
        if (msg.sender != moderation) revert OnlyModeration();
        if (contentTokenId[key] != tokenId) revert UnknownContent();
        contentHidden[key] = hidden;
        emit ContentFlagged(tokenId, key, hidden);
    }

    /// @notice Permissionless, batched burn of the liens on hidden content.
    ///         Each voter loses up to `moderationSlashBps` of their lien; the
    ///         rating those liens carried is destroyed with them. Bounded so it
    ///         can never grief the block gas limit.
    function slashContent(bytes32 key, uint256 maxVoters) external {
        if (!contentHidden[key]) revert NotHidden();
        if (maxVoters == 0 || maxVoters > 100) revert TooManyKeys();

        address[] storage voters = keyVoters[key];
        uint256 cursor = slashCursor[key];
        uint256 end = cursor + maxVoters;
        if (end > voters.length) end = voters.length;
        if (cursor >= end) revert NothingToSlash();

        for (uint256 i = cursor; i < end; i++) {
            address voter = voters[i];
            uint256 lien = lockOf[voter][key];
            if (lien == 0) continue;
            uint256 burn = (lien * moderationSlashBps) / BPS;
            if (burn == 0) continue;

            stasis.burnVoiced(voter, burn, "moderation");
            lockOf[voter][key] = lien - burn;
            voiceLocked[voter] -= burn;
            if (lockOf[voter][key] == 0) _removeKey(voter, key);
            _subtractRating(key, burn);
            if (lockOf[voter][key] == 0 && contentProvisional[key] > 0 && voter == contentAuthor[key]) {
                contentProvisional[key] = 0;
            }
            emit ContentSlashed(key, voter, burn);
        }
        slashCursor[key] = end;
    }

    // ------------------------------------------------- sustainability lifecycle

    /// @notice Record the project's remaining funding need for this period.
    ///         Hitting zero for `zeroStreakRequired` consecutive periods flips
    ///         the cow to SelfSustaining. A *reduction* credits the solver —
    ///         the person who removed the dependency earns the rating.
    function recordFundingNeed(uint256 tokenId, uint256 newNeed, address solver) external {
        if (msg.sender != attestation) revert OnlyAttestation();

        Funding storage f = funding[tokenId];
        if (f.lastRecord != 0 && block.timestamp < f.lastRecord + needPeriod) revert PeriodNotElapsed();

        uint256 previous = f.need;
        f.lastRecord = block.timestamp;
        f.need = newNeed;

        // Reporting a verified need is protection work whether it is new,
        // ongoing or reduced; the Stasis award below is only for reductions.
        if (solver != address(0)) _touchProtection(solver, 3);

        if (newNeed == 0) f.zeroStreak += 1;
        else f.zeroStreak = 0;

        emit FundingNeedRecorded(tokenId, previous, newNeed, solver);

        if (newNeed < previous && solver != address(0)) {
            uint256 reduction = previous - newNeed;
            uint256 award = (reduction * creditBps) / BPS;
            if (award > 0) stasis.award(solver, award, "sustainability");
        }

        if (f.zeroStreak >= zeroStreakRequired && cowNFT.statusOf(tokenId) == CowNFT.Status.Active) {
            cowNFT.markSelfSustaining(tokenId);
            selfSustainingCount += 1;
            emit SelfSustaining(tokenId);
        }
    }

    // --------------------------------------------------------------- transfer

    /// @notice What a given buyer must pay in Stasis to receive this cow.
    ///         Robust cows with little backing cost more; a high-rating buyer
    ///         pays less. Rating spent here is destroyed — liquid becomes steam.
    function transferCost(uint256 tokenId, address buyer) public view returns (uint256) {
        uint256 rating = ratingOf(tokenId);
        if (rating > transferRatingCap) rating = transferRatingCap;

        uint256 backing = totalStaked[tokenId];
        if (backing < activationThreshold) backing = activationThreshold;

        uint256 base = (baseTransferCost * (BPS + rating)) / (BPS + backing);

        uint256 discount = (stasis.effectiveScore(buyer) * maxBuyerDiscountBps) / discountScale;
        if (discount > maxBuyerDiscountBps) discount = maxBuyerDiscountBps;

        uint256 cost = (base * (BPS - discount)) / BPS;
        return cost < minTransferCost ? minTransferCost : cost;
    }

    /// @inheritdoc ITransferValidator
    function validateTransfer(uint256 tokenId, address from, address to) external {
        if (msg.sender != address(cowNFT)) revert OnlyCowNFT();

        uint256 cost = transferCost(tokenId, to);
        // Reverts if the buyer lacks the rating: money alone cannot move a cow.
        stasis.spend(to, cost, "transfer");

        emit TransferValidated(tokenId, from, to, cost);
    }

    /// @notice Called by Attestation when an offline sale is proven. Bypasses
    ///         the rated handshake because reality already happened.
    function realWorldTransfer(uint256 tokenId, address to) external {
        if (msg.sender != attestation) revert OnlyAttestation();
        cowNFT.realWorldTransfer(tokenId, to);
    }

    /// @notice Called by Attestation once enough bonded raters report a death.
    function markMemorial(uint256 tokenId) external {
        if (msg.sender != attestation) revert OnlyAttestation();
        cowNFT.markMemorial(tokenId);
    }
}
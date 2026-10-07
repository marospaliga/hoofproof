// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Stasis} from "./Stasis.sol";
import {CowNFT} from "./CowNFT.sol";
import {ITransferValidator} from "./interfaces/ITransferValidator.sol";

/// @title CowRating — fluid rating, conviction staking, sustainability lifecycle
///
/// Money and rating are two separate fields of the system:
///  - money buys a *share* of a cow (handled off the rating path entirely);
///  - rating is the only thing that grants influence, activates a cow, or
///    moves one to a new owner.
///
/// Rating is non-transferable between people, but it can be *committed* —
/// staked onto a cow, voiced as a thumbs-up, and spent as the cost of a
/// transfer. There is no hard cooldown: every account has a **voting power**
/// meter that refills continuously, so votes are fluid but brigading still
/// depletes the attacker. Votes may target the cow itself, an image or a
/// discussion post (content is how authenticity is proven), and **ethical
/// momentum** — recent, sustained activity — raises how much a voice weighs
/// and how far a stake pushes a cow toward activation.
contract CowRating is Ownable, ITransferValidator {
    uint256 public constant BPS = 10_000;

    // ---- staking
    uint256 public activationThreshold = 1_000; // weighted rating to leave Inert
    uint256 public concentrationCapBps = 2_000; // one account may hold at most 20%
    uint256 public lockPeriod = 30 days; // conviction window
    uint256 public earlyUnlockPenaltyBps = 5_000; // max 50%, scaled by time remaining

    // ---- voting (thumbs up)
    /// @notice At most this share of a rater's score per vote.
    uint256 public maxBoostBps = 1_000; // 10%
    /// @notice Each thumbs-up spends this share of the account's voting power.
    uint256 public voteCostBps = 2_000; // 20%
    /// @notice Full voting-power refill time. Power recovers linearly.
    uint256 public voteRecovery = 1 days;

    // ---- ethical momentum
    /// @notice Recent, sustained activity scales an account's voice. The
    ///         multiplier runs from 1x (idle / brand new) to 1.5x (sustained
    ///         recent activity), decaying linearly over `momentumDecay`.
    uint256 public momentumDecay = 90 days;
    uint256 public momentumMinBps = 10_000; // 1.00x
    uint256 public momentumMaxBps = 15_000; // 1.50x
    uint256 public maxActivityPoints = 500; // activity needed for the full 1.5x

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
        uint256 weightBps; // momentum snapshot at stake time (activation weighting)
    }

    struct VotePower {
        uint256 power; // bps remaining (0..10_000)
        uint256 updatedAt;
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
    /// Staked rating weighted by each rater's momentum snapshot. Activation
    /// is decided on this, so high-momentum raters push a cow further
    /// ("lower liquidity requirements" for trusted communities).
    mapping(uint256 => uint256) public totalWeightedStaked;
    mapping(uint256 => uint256) public cowRating;
    /// Content-level ratings: contentRating[tokenId][cidHash][kind bps bytes].
    mapping(uint256 => mapping(bytes32 => mapping(uint8 => uint256))) public contentRating;
    mapping(uint256 => Funding) public funding;

    mapping(address => VotePower) public votePower;
    /// Lazy activity ledger for momentum (decays at read time).
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

    event Staked(uint256 indexed tokenId, address indexed account, uint256 amount, uint256 totalStaked);
    event Unstaked(uint256 indexed tokenId, address indexed account, uint256 amount, uint256 returned);
    event Voted(uint256 indexed tokenId, address indexed account, uint8 kind, bytes32 cidHash, uint256 bps, uint256 weight, uint256 newRating);
    event Boosted(uint256 indexed tokenId, address indexed account, bytes32 category, uint256 weight, uint256 newRating);
    event LaborRewarded(uint256 indexed tokenId, address indexed worker, uint256 attestedHours, uint256 reward);
    event FundingNeedRecorded(uint256 indexed tokenId, uint256 previous, uint256 current, address solver);
    event SelfSustaining(uint256 indexed tokenId);
    event TransferValidated(uint256 indexed tokenId, address indexed from, address indexed to, uint256 cost);
    event ParameterSet(bytes32 indexed key, uint256 value);
    event WiringSet(address indexed cowNFT, address indexed attestation);

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

    // -------------------------------------------------------------- staking

    function _concentrationBase(uint256 tokenId) internal view returns (uint256) {
        uint256 base = totalStaked[tokenId];
        // Before a cow reaches threshold the cap is measured against the
        // threshold itself, so a single account can never activate a cow alone.
        return base < activationThreshold ? activationThreshold : base;
    }

    /// @notice Commit rating to a cow. Committed rating is bonded — it can no
    ///         longer be spent elsewhere, and it is what makes backing a claim costly.
    function stakeRating(uint256 tokenId, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (cowNFT.statusOf(tokenId) == CowNFT.Status.Memorial) revert IsMemorial();

        Stake storage s = stakes[tokenId][msg.sender];
        uint256 allowed = (_concentrationBase(tokenId) * concentrationCapBps) / BPS;
        if (s.amount + amount > allowed) revert ConcentrationCap();

        stasis.bond(msg.sender, amount); // reverts unless the account has free score

        if (s.since == 0) s.since = block.timestamp;
        uint256 weightBps = momentumBps(msg.sender);
        s.weightBps = weightBps;
        s.amount += amount;
        totalStaked[tokenId] += amount;
        totalBacking += amount;
        totalWeightedStaked[tokenId] += (amount * weightBps) / BPS;
        _touchActivity(msg.sender, 1);

        emit Staked(tokenId, msg.sender, amount, totalStaked[tokenId]);

        if (totalWeightedStaked[tokenId] >= activationThreshold && cowNFT.statusOf(tokenId) == CowNFT.Status.Inert) {
            activeCowCount += 1;
            cowNFT.markActive(tokenId);
        }
    }

    /// @notice Withdraw committed rating. Leaving early costs rating, scaled by
    ///         how much of the lock period was left — so pulling out is never free.
    function unstakeRating(uint256 tokenId, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        Stake storage s = stakes[tokenId][msg.sender];
        if (s.amount < amount) revert InsufficientStake();

        uint256 returned = amount;
        uint256 elapsed = block.timestamp - s.since;
        if (elapsed < lockPeriod) {
            uint256 remaining = lockPeriod - elapsed;
            uint256 earlyPenalty = (amount * earlyUnlockPenaltyBps * remaining) / (BPS * lockPeriod);
            returned = amount - earlyPenalty;
        }

        stasis.unbond(msg.sender, amount);

        s.amount -= amount;
        if (s.amount == 0) s.since = 0;
        totalStaked[tokenId] -= amount;
        totalBacking -= amount;
        uint256 weighted = (amount * s.weightBps) / BPS;
        totalWeightedStaked[tokenId] = totalWeightedStaked[tokenId] > weighted
            ? totalWeightedStaked[tokenId] - weighted
            : 0;

        uint256 penalty = amount - returned;
        if (penalty > 0) stasis.spend(msg.sender, penalty, "early unlock");

        emit Unstaked(tokenId, msg.sender, amount, returned);
    }

    // ------------------------------------------------------------ voting power

    /// @notice Voting power refills linearly: full charge in `voteRecovery`.
    function _regen(uint256 power, uint256 updatedAt) internal view returns (uint256) {
        if (power >= BPS) return BPS;
        uint256 elapsed = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
        uint256 recover = (elapsed * BPS) / voteRecovery;
        return power + recover >= BPS ? BPS : power + recover;
    }

    /// @notice Persist any accumulated power regeneration.
    function _tickVotePower(address account) internal {
        VotePower storage vp = votePower[account];
        if (vp.updatedAt == 0) {
            vp.updatedAt = block.timestamp;
            vp.power = BPS;
            return;
        }
        vp.power = _regen(vp.power, vp.updatedAt);
        vp.updatedAt = block.timestamp;
    }

    function votingPowerOf(address account) public view returns (uint256) {
        VotePower storage vp = votePower[account];
        if (vp.updatedAt == 0) return BPS;
        return _regen(vp.power, vp.updatedAt);
    }

    // --------------------------------------------------------- ethical momentum

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

    /// @notice BPS multiplier for an account's votes and stakes, 1x..1.5x.
    function momentumBps(address account) public view returns (uint256) {
        uint256 bonus = _activityAt(account);
        if (bonus > maxActivityPoints) bonus = maxActivityPoints;
        uint256 headroom = momentumMaxBps - momentumMinBps;
        return momentumMinBps + (headroom * bonus) / maxActivityPoints;
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

    /// @notice The weight a vote carries, then spends 20% of voting power.
    function _voteWeight(address account, uint256 bps) internal returns (uint256 weight) {
        if (bps == 0 || bps > maxBoostBps) revert InvalidBoost();
        _tickVotePower(account);
        if (votePower[account].power < voteCostBps) revert NoVotingPower();
        votePower[account].power -= voteCostBps;

        weight = stasis.effectiveScore(account);
        weight = (weight * bps) / BPS;
        weight = (weight * momentumBps(account)) / BPS;
        if (weight == 0) revert WeightTooLow();
    }

    /// @notice Thumbs-up a cow, image or post. Every vote is recorded against
    ///         the cow too, so well-documented cows accumulate authenticity.
    function vote(uint256 tokenId, uint8 kind, bytes32 cidHash, uint256 bps) external {
        if (kind > uint8(VoteKind.Post)) revert InvalidBoost();
        if (cowNFT.statusOf(tokenId) == CowNFT.Status.Memorial) revert IsMemorial();

        uint256 weight = _voteWeight(msg.sender, bps);
        cowRating[tokenId] += weight;
        totalRatingPoints += weight;
        if (kind != uint8(VoteKind.Cow)) {
            contentRating[tokenId][cidHash][kind] += weight;
        }
        _touchActivity(msg.sender, 2);

        emit Voted(tokenId, msg.sender, kind, cidHash, bps, weight, cowRating[tokenId]);
    }

    /// @notice Legacy thumbs-up on the whole cow with a need-parameter weight
    ///         (kept so existing integrations and tooling keep working).
    function boost(uint256 tokenId, bytes32 category, uint256 bps) external {
        if (cowNFT.statusOf(tokenId) == CowNFT.Status.Memorial) revert IsMemorial();
        uint256 weight = _voteWeight(msg.sender, bps);

        uint256 param = parameter[category];
        if (param != 0) weight = (weight * param) / BPS;
        if (weight == 0) revert WeightTooLow();

        cowRating[tokenId] += weight;
        totalRatingPoints += weight;
        _touchActivity(msg.sender, 2);

        emit Boosted(tokenId, msg.sender, category, weight, cowRating[tokenId]);
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
        if (reward > 0) stasis.award(worker, reward, "labor");
        _touchActivity(worker, 5);

        emit LaborRewarded(tokenId, worker, attestedHours, reward);
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
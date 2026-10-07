// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Stasis} from "./Stasis.sol";
import {CowNFT} from "./CowNFT.sol";
import {ITransferValidator} from "./interfaces/ITransferValidator.sol";

/// @title CowRating — rating, conviction staking and the sustainability lifecycle
///
/// Money and rating are two separate fields of the system:
///  - money buys a *share* of a cow (handled off the rating path entirely);
///  - rating is the only thing that grants influence, activates a cow, or
///    moves one to a new owner.
///
/// Rating is non-transferable between people, but it can be *committed* —
/// staked onto a cow, boosted into a project, and spent as the cost of a
/// transfer. Spending converts "liquid to steam".
contract CowRating is Ownable, ITransferValidator {
    uint256 public constant BPS = 10_000;

    // ---- staking
    uint256 public activationThreshold = 1_000; // total rating to leave Inert
    uint256 public concentrationCapBps = 2_000; // one account may hold at most 20%
    uint256 public lockPeriod = 30 days; // conviction window
    uint256 public earlyUnlockPenaltyBps = 5_000; // max 50%, scaled by time remaining

    // ---- boosts (thumbs up)
    uint256 public maxBoostBps = 1_000; // at most 10% of own score per boost
    uint256 public boostCooldown = 1 days; // per cow, per account

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

    struct Stake {
        uint256 amount;
        uint256 since;
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
    mapping(uint256 => uint256) public cowRating;
    mapping(uint256 => mapping(address => uint256)) public lastBoost;
    mapping(uint256 => Funding) public funding;

    /// @notice Need-weights (BPS-scaled: 10_000 = 1x, 0 = unset -> 1x): set the
    ///         value the system currently lacks, and contributing to it earns
    ///         boosted rating. Owner-set in the MVP; a weighted-vote setter
    ///         ships in v2 (money is out of scope first).
    mapping(bytes32 => uint256) public parameter;

    event Staked(uint256 indexed tokenId, address indexed account, uint256 amount, uint256 totalStaked);
    event Unstaked(uint256 indexed tokenId, address indexed account, uint256 amount, uint256 returned);
    event Boosted(uint256 indexed tokenId, address indexed account, bytes32 category, uint256 weight, uint256 newRating);
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
    error CooldownActive();
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
        s.amount += amount;
        totalStaked[tokenId] += amount;

        emit Staked(tokenId, msg.sender, amount, totalStaked[tokenId]);

        if (totalStaked[tokenId] >= activationThreshold) {
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

        uint256 penalty = amount - returned;
        if (penalty > 0) stasis.spend(msg.sender, penalty, "early unlock");

        emit Unstaked(tokenId, msg.sender, amount, returned);
    }

    // --------------------------------------------------------------- boosting

    /// @notice Thumbs-up. Weight = your score × bps × the need-parameter for
    ///         `category`. Rate-limited per cow so brigading is expensive.
    function boost(uint256 tokenId, bytes32 category, uint256 bps) external {
        if (bps == 0 || bps > maxBoostBps) revert InvalidBoost();
        if (cowNFT.statusOf(tokenId) == CowNFT.Status.Memorial) revert IsMemorial();
        if (block.timestamp < lastBoost[tokenId][msg.sender] + boostCooldown) revert CooldownActive();

        uint256 weight = stasis.effectiveScore(msg.sender);
        weight = (weight * bps) / BPS;

        uint256 param = parameter[category];
        if (param != 0) weight = (weight * param) / BPS;
        if (weight == 0) revert WeightTooLow();

        lastBoost[tokenId][msg.sender] = block.timestamp;
        cowRating[tokenId] += weight;

        emit Boosted(tokenId, msg.sender, category, weight, cowRating[tokenId]);
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

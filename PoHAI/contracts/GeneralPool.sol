// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Stasis} from "./Stasis.sol";
import {CowRating} from "./CowRating.sol";

/// @title GeneralPool — platform value index, Rajas ledger, care & gas pools
///
/// The "genesis pool" of the ecosystem: one place that (1) tracks the value
/// of the whole platform over time (the index), (2) holds the spendable
/// **Rajas** action-credits with Sattva<->Rajas conversion, (3) earmarks care
/// allowance per cow, and (4) lets high-momentum raters claim fee rebates so
/// "more reputation means less you pay" is real — the pool covers the gas cost.
///
/// Money and reputation stay separate: Rajas buys perks and fee relief, never
/// votes. Influence (Sattva) can only be re-earned through activity, except a
/// gain-capped Rajas->Sattva conversion so creditable work can fund influence
/// without turning the ledger into a market.
contract GeneralPool is Ownable {
    uint256 public constant BPS = 10_000;

    Stasis public immutable stasis;
    CowRating public immutable cowRating;

    // ---- Rajas (spendable action credits)
    mapping(address => uint256) public rajas;
    uint256 public totalRajas;

    // ---- gas rebates ("more reputation, less you pay")
    uint256 public gasRebateBase = 0.001 ether; // full-tier weekly rebate
    uint256 public gasRebatePeriod = 7 days;

    // ---- care pool
    mapping(uint256 => uint256) public carePoolOf;

    // ---- platform value index
    struct Epoch {
        uint256 id;
        uint256 ts;
        uint256 backing;
        uint256 rating;
        uint256 stasis;
        uint256 rajas;
        uint256 activeCows;
    }

    mapping(address => uint256) public lastGasClaim;
    Epoch[] public indexHistory;

    event RajasMinted(address indexed account, uint256 amount, bytes32 reason);
    event SattvaToRajas(address indexed account, uint256 amount);
    event RajasToSattva(address indexed account, uint256 amount);
    event GasRebateClaimed(address indexed account, uint256 amount);
    event CareAllocated(uint256 indexed tokenId, uint256 amount);
    event IndexSnapped(uint256 id, uint256 backing, uint256 rating, uint256 stasis, uint256 rajas, uint256 activeCows);

    error ZeroAmount();
    error InsufficientRajas();
    error AlreadyClaimed();
    error NoMomentum();
    error EmptyPool();

    constructor(address stasis_, address cowRating_) Ownable(msg.sender) {
        stasis = Stasis(stasis_);
        cowRating = CowRating(cowRating_);
    }

    receive() external payable {}

    function setGasRebate(uint256 base, uint256 period) external onlyOwner {
        gasRebateBase = base;
        gasRebatePeriod = period;
    }

    // ---------------------------------------------------------------- Rajas

    function mintRajas(address account, uint256 amount, bytes32 reason) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        rajas[account] += amount;
        totalRajas += amount;
        emit RajasMinted(account, amount, reason);
    }

    /// @notice Spend influence (Sattva) to obtain spendable action credits.
    function convertSattvaToRajas(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        stasis.spend(msg.sender, amount, "sattva->rajas");
        rajas[msg.sender] += amount;
        totalRajas += amount;
        emit SattvaToRajas(msg.sender, amount);
    }

    /// @notice Invest action credits back into influence. Gain-capped by Stasis
    ///         itself, so buying influence can only happen in steady small steps.
    function convertRajasToSattva(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (rajas[msg.sender] < amount) revert InsufficientRajas();
        rajas[msg.sender] -= amount;
        totalRajas -= amount;
        stasis.award(msg.sender, amount, "rajas->sattva");
        emit RajasToSattva(msg.sender, amount);
    }

    // -------------------------------------------------------- fee rebates

    /// @notice Weekly, capped refund of the pool's native balance, scaled by the
    ///         caller's ethical momentum — full tier at 1.5x momentum, nothing
    ///         for a rater who has not shown sustained activity.
    function claimGasRebate() external {
        uint256 minM = cowRating.momentumMinBps();
        uint256 maxM = cowRating.momentumMaxBps();
        uint256 m = cowRating.momentumBps(msg.sender);
        if (m <= minM) revert NoMomentum();
        if (block.timestamp < lastGasClaim[msg.sender] + gasRebatePeriod) revert AlreadyClaimed();

        uint256 frac = ((m - minM) * BPS) / (maxM - minM);
        uint256 rebate = (gasRebateBase * frac) / BPS;

        uint256 balance = address(this).balance;
        if (rebate == 0 || balance == 0) revert EmptyPool();
        if (rebate > balance) rebate = balance;

        lastGasClaim[msg.sender] = block.timestamp;
        (bool ok, ) = payable(msg.sender).call{value: rebate}("");
        require(ok, "transfer failed");
        emit GasRebateClaimed(msg.sender, rebate);
    }

    // ------------------------------------------------------------ care pool

    /// @notice Earmark native funds for a cow's real-world upkeep. Money only
    ///         ever leaves through the owner (who pays caretakers in reality);
    ///         the chain keeps the public commitment.
    function allocateCare(uint256 tokenId, uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        if (address(this).balance < amount) revert EmptyPool();
        carePoolOf[tokenId] += amount;
        emit CareAllocated(tokenId, amount);
    }

    /// @notice The native balance used for real-world disbursements.
    function withdraw(address to, uint256 amount) external onlyOwner {
        if (amount == 0 || address(this).balance < amount) revert EmptyPool();
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "transfer failed");
    }

    // ------------------------------------------------------ platform index

    function platformMetrics()
        public
        view
        returns (uint256 backing, uint256 rating, uint256 stasisTotal, uint256 rajas_, uint256 activeCows)
    {
        backing = cowRating.totalBacking();
        rating = cowRating.totalRatingPoints();
        stasisTotal = stasis.totalScore();
        rajas_ = totalRajas;
        activeCows = cowRating.activeCowCount();
    }

    /// @notice Simple composite "value of the whole platform" figure.
    function platformValue() public view returns (uint256) {
        (uint256 backing, uint256 rating, uint256 stasisTotal, uint256 rajas_, ) = platformMetrics();
        // Weights are illustrative; components are the honest signal.
        return backing + rating * 10 + stasisTotal + rajas_;
    }

    /// @notice Chess-window snapshot of the platform's health. Anyone may
    ///         call; each snapshot is cheap and history is immutable.
    function snapshotIndex() external {
        (uint256 backing, uint256 rating, uint256 stasisTotal, uint256 rajas_, uint256 activeCows) =
            platformMetrics();
        indexHistory.push(
            Epoch({
                id: indexHistory.length + 1,
                ts: block.timestamp,
                backing: backing,
                rating: rating,
                stasis: stasisTotal,
                rajas: rajas_,
                activeCows: activeCows
            })
        );
        emit IndexSnapped(indexHistory.length, backing, rating, stasisTotal, rajas_, activeCows);
    }

    function epochCount() external view returns (uint256) {
        return indexHistory.length;
    }
}
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Stasis} from "./Stasis.sol";
import {CowRating} from "./CowRating.sol";

/// @title GeneralPool — platform value index, Rajas ledger, care & gas pools,
///        charitable events, and the cyclical "field movement" credit
///
/// The "genesis pool" of the ecosystem: one place that (1) tracks the value
/// of the whole platform over time (the index), (2) holds the spendable
/// **Rajas** action-credits with Sattva<->Rajas conversion, (3) earmarks care
/// allowance per cow, (4) lets high-momentum raters claim fee rebates so
/// "more reputation means less you pay" is real — the pool covers the gas cost,
/// and (5) escrows GoFundMe-style **charitable events** whose backers earn
/// reputation only *cyclically*, sized by how much the whole field moved.
///
/// Money and reputation stay separate: Rajas buys perks and fee relief, never
/// votes. Influence (Sattva) can only be re-earned through activity, except a
/// gain-capped Rajas->Sattva conversion so creditable work can fund influence
/// without turning the ledger into a market.
///
/// ## Cycle credit ("the field moved — so its supporters are thanked")
///
/// `settleCycle()` (anyone may call, like `snapshotIndex`) compares the
/// platform's metrics against the previous settle and sizes a credit pool
/// from the *positive movement* of the whole field: growth in rated backing,
/// rating points, active cows and Rajas. The pool is split `backerShareBps`
/// (default 50/50) between
///   - the cycle's **backers** of charitable events, pro rata by contribution,
///   - the cycle's **active raters**, pro rata by activity gained in the window
///     (CowRating keeps a registry of activity-touched accounts for this).
///
/// Stasis applies its +10%/period gain cap on top, so no one can ever buy a
/// rank: a big donation only earns a share of a pool that only exists because
/// the ecosystem demonstrably moved, and even that share is gain-capped.
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

    // ---- charitable events (GoFundMe-style, escrowed here)
    struct FundEvent {
        uint256 id;
        address creator;
        string metadataCid; // where the prose/images of the cause live
        uint256 goal; // wei the cause is asking for
        uint256 raised; // wei contributed so far (escrowed in this pool)
        uint256 spent; // wei released toward the real-world goal
        bool closed;
    }

    uint256 public eventCount;
    mapping(uint256 => FundEvent) public events;

    // ---- cycle credit ("the field moved — so its supporters are thanked")
    uint256 public cyclePeriod = 6 hours; // short while testing; owner re-tunes
    /// Share of the credit pool reserved for backers (rest goes to raters).
    uint256 public backerShareBps = 5_000; // 50/50
    /// credit pool = positive field movement × this (BPS-scaled).
    uint256 public creditRatioBps = 5_000; // 0.5×
    /// Hard per-cycle cap on the pool (Stasis points).
    uint256 public maxCycleCredit = 5_000;

    uint256 public lastCycleAt; // when the last cycle settled
    uint256 public lastCycleMovement; // field movement the last settle measured
    uint256 public lastCycleCredit; // credit pool the last settle paid
    uint256 public lastCycleBackerShare;
    uint256 public lastCycleRaterShare;
    uint256 public lastCycleBackers; // distinct backers paid
    uint256 public lastCycleRaters; // distinct raters paid

    // Baseline of the field at the previous settle (priming settles set it).
    uint256 private _snapBacking;
    uint256 private _snapRating;
    uint256 private _snapActiveCows;
    uint256 private _snapRajas;
    bool private _cyclePrimed;

    // ---- current-cycle contributor ledger
    uint256 public cycleRaised; // wei contributed since the last settle
    mapping(address => uint256) public backerCycle; // per-backer contribution
    address[] private _cycleBackers;
    mapping(address => bool) private _isCycleBacker;

    // ---- per-rater activity snapshot at the previous settle
    mapping(address => uint256) public settledActivityAt;

    bytes32 private constant CYCLE_BACKER = "cycle:backer";
    bytes32 private constant CYCLE_RATER = "cycle:rater";

    event RajasMinted(address indexed account, uint256 amount, bytes32 reason);
    event SattvaToRajas(address indexed account, uint256 amount);
    event RajasToSattva(address indexed account, uint256 amount);
    event GasRebateClaimed(address indexed account, uint256 amount);
    event CareAllocated(uint256 indexed tokenId, uint256 amount);
    event IndexSnapped(uint256 id, uint256 backing, uint256 rating, uint256 stasis, uint256 rajas, uint256 activeCows);
    event FundEventCreated(uint256 indexed id, address indexed creator, string metadataCid, uint256 goal);
    event FundContributed(uint256 indexed id, address indexed backer, uint256 amount, uint256 raised);
    event FundSpent(uint256 indexed id, address indexed to_, uint256 amount, uint256 spent);
    event FundEventClosed(uint256 indexed id);
    event CycleSettled(
        uint256 at,
        uint256 movement,
        uint256 creditPool,
        uint256 backerShare,
        uint256 raterShare,
        uint256 backers,
        uint256 raters
    );

    error ZeroAmount();
    error InsufficientRajas();
    error AlreadyClaimed();
    error NoMomentum();
    error EmptyPool();
    error EmptyCid();
    error NoSuchEvent();
    error EventClosed();
    error NotEventCreator();
    error CannotSpend();
    error CycleNotElapsed();

    constructor(address stasis_, address cowRating_) Ownable(msg.sender) {
        stasis = Stasis(stasis_);
        cowRating = CowRating(cowRating_);
    }

    receive() external payable {}

    function setGasRebate(uint256 base, uint256 period) external onlyOwner {
        gasRebateBase = base;
        gasRebatePeriod = period;
    }

    /// @notice Owner tuning for the cycle. shareBps is the backer share of the
    ///         credit pool (the rest goes to active raters).
    function setCycle(uint256 period, uint256 shareBps, uint256 ratioBps, uint256 maxCredit) external onlyOwner {
        cyclePeriod = period;
        backerShareBps = shareBps > BPS ? BPS : shareBps;
        creditRatioBps = ratioBps;
        maxCycleCredit = maxCredit;
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

    // ------------------------------------------------- charitable events

    /// @notice Open a cause: "winter bedding", "new stable", "vet truck"…
    ///         Only the prose reference is stored here; the title, pictures
    ///         and story live at `metadataCid` (the agorá / IPFS).
    function createEvent(string calldata metadataCid, uint256 goal) external returns (uint256 id) {
        if (bytes(metadataCid).length == 0) revert EmptyCid();
        if (goal == 0) revert ZeroAmount();
        eventCount += 1;
        id = eventCount;
        events[id] = FundEvent({
            id: id,
            creator: msg.sender,
            metadataCid: metadataCid,
            goal: goal,
            raised: 0,
            spent: 0,
            closed: false
        });
        emit FundEventCreated(id, msg.sender, metadataCid, goal);
    }

    /// @notice Back a cause. The money is escrowed in this pool and is *not*
    ///         instant reputation — it only becomes a claim to a share of the
    ///         next cycle's credit, sized by whole-field movement.
    function contribute(uint256 eventId) external payable {
        FundEvent storage e = events[eventId];
        if (e.id == 0) revert NoSuchEvent();
        if (e.closed) revert EventClosed();
        if (msg.value == 0) revert ZeroAmount();

        e.raised += msg.value;
        backerCycle[msg.sender] += msg.value;
        if (!_isCycleBacker[msg.sender]) {
            _isCycleBacker[msg.sender] = true;
            _cycleBackers.push(msg.sender);
        }
        cycleRaised += msg.value;
        emit FundContributed(eventId, msg.sender, msg.value, e.raised);
    }

    /// @notice The event creator releases escrowed funds to a real-world wallet
    ///         (the bedding supplier, the vet, the stable owner). Spent funds
    ///         are capped by what was raised.
    function spend(uint256 eventId, uint256 amount, address to_) external {
        FundEvent storage e = events[eventId];
        if (e.id == 0) revert NoSuchEvent();
        if (msg.sender != e.creator) revert NotEventCreator();
        if (amount == 0) revert ZeroAmount();
        if (to_ == address(0)) revert NoSuchEvent();
        if (e.spent + amount > e.raised) revert CannotSpend();
        if (address(this).balance < amount) revert EmptyPool();

        e.spent += amount;
        (bool ok, ) = payable(to_).call{value: amount}("");
        require(ok, "transfer failed");
        emit FundSpent(eventId, to_, amount, e.spent);
    }

    /// @notice Close a cause (creator). After this no new contributions land.
    function closeEvent(uint256 eventId) external {
        FundEvent storage e = events[eventId];
        if (e.id == 0) revert NoSuchEvent();
        if (msg.sender != e.creator) revert NotEventCreator();
        e.closed = true;
        emit FundEventClosed(eventId);
    }

    // ----------------------------------------------------- cycle credit

    function cycleBackersCount() external view returns (uint256) {
        return _cycleBackers.length;
    }

    function cycleBackers(uint256 i) external view returns (address) {
        return _cycleBackers[i];
    }

    /// @notice Close one cycle: measure the field's positive movement since the
    ///         last settle and thank this cycle's contributors and raters out of
    ///         the credit pool. The first call only primes the baseline — credit
    ///         starts with the following cycle. Anyone may call it.
    ///
    ///         Movement is the sum of the *positive* deltas of the field's
    ///         honest signals: rated backing, rating points, active cows (±1000
    ///         per cow) and Rajas. Negative movement (e.g. Stasis decay) is
    ///         simply not a gift: the pool only exists when the field grew.
    function settleCycle() external {
        if (lastCycleAt != 0 && block.timestamp < lastCycleAt + cyclePeriod) revert CycleNotElapsed();

        (uint256 backing, uint256 rating, , uint256 rajas_, uint256 activeCows) = platformMetrics();

        // ---- first call prims the baseline (no credit yet)
        if (!_cyclePrimed) {
            _snapBacking = backing;
            _snapRating = rating;
            _snapActiveCows = activeCows;
            _snapRajas = rajas_;
            _cyclePrimed = true;
            _snapshotRaterActivity();
            lastCycleAt = block.timestamp;
            emit CycleSettled(block.timestamp, 0, 0, 0, 0, 0, 0);
            return;
        }

        uint256 movement;
        if (backing > _snapBacking) movement += backing - _snapBacking;
        if (rating > _snapRating) movement += rating - _snapRating;
        if (activeCows > _snapActiveCows) movement += (activeCows - _snapActiveCows) * 1_000;
        if (rajas_ > _snapRajas) movement += rajas_ - _snapRajas;

        uint256 creditPool = (movement * creditRatioBps) / BPS;
        if (creditPool > maxCycleCredit) creditPool = maxCycleCredit;

        uint256 backerPool = (creditPool * backerShareBps) / BPS;
        uint256 raterPool = creditPool - backerPool;

        // ---- pay backers pro rata by their contribution this cycle
        uint256 backers;
        if (cycleRaised > 0 && backerPool > 0) {
            for (uint256 i = 0; i < _cycleBackers.length; i++) {
                address b = _cycleBackers[i];
                uint256 share = (backerCycle[b] * backerPool) / cycleRaised;
                if (share > 0) {
                    stasis.award(b, share, CYCLE_BACKER);
                    backers += 1;
                }
                delete backerCycle[b];
                _isCycleBacker[b] = false;
            }
        } else {
            for (uint256 i = 0; i < _cycleBackers.length; i++) {
                delete backerCycle[_cycleBackers[i]];
                _isCycleBacker[_cycleBackers[i]] = false;
            }
        }
        delete _cycleBackers;
        cycleRaised = 0;

        // ---- pay active raters pro rata by activity gained since the last settle
        uint256 raters;
        uint256 count = cowRating.activeAccountCount();
        uint256[] memory deltas = new uint256[](count);
        uint256[] memory current = new uint256[](count);
        uint256 totalDelta;
        for (uint256 i = 0; i < count; i++) {
            address r = cowRating.activeAccounts(i);
            uint256 a = cowRating.activityPoints(r);
            current[i] = a;
            uint256 prev = settledActivityAt[r];
            if (a > prev) {
                deltas[i] = a - prev;
                totalDelta += deltas[i];
            }
        }
        if (raterPool > 0 && totalDelta > 0) {
            for (uint256 i = 0; i < count; i++) {
                address r = cowRating.activeAccounts(i);
                settledActivityAt[r] = current[i];
                uint256 share = (deltas[i] * raterPool) / totalDelta;
                if (share > 0) {
                    stasis.award(r, share, CYCLE_RATER);
                    raters += 1;
                }
            }
        } else {
            for (uint256 i = 0; i < count; i++) {
                settledActivityAt[cowRating.activeAccounts(i)] = current[i];
            }
        }

        // ---- store the new baseline for the next cycle
        _snapBacking = backing;
        _snapRating = rating;
        _snapActiveCows = activeCows;
        _snapRajas = rajas_;
        lastCycleAt = block.timestamp;
        lastCycleMovement = movement;
        lastCycleCredit = creditPool;
        lastCycleBackerShare = backerPool;
        lastCycleRaterShare = raterPool;
        lastCycleBackers = backers;
        lastCycleRaters = raters;

        emit CycleSettled(block.timestamp, movement, creditPool, backerPool, raterPool, backers, raters);
    }

    /// @dev Snapshot every known rater's activity so the first real settle only
    ///      thanks the activity that happened *after* the cycle started.
    function _snapshotRaterActivity() internal {
        uint256 count = cowRating.activeAccountCount();
        for (uint256 i = 0; i < count; i++) {
            settledActivityAt[cowRating.activeAccounts(i)] = cowRating.activityPoints(cowRating.activeAccounts(i));
        }
    }
}
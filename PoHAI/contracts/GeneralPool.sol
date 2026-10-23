// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Stasis} from "./Stasis.sol";
import {CowRating} from "./CowRating.sol";
import {Attestation} from "./Attestation.sol";
import {CowNFT} from "./CowNFT.sol";

/// @title GeneralPool — platform value index, Rajas ledger, care & gas pools,
///        charitable events, and the cyclical "field movement" credit
///
/// The "genesis pool" of the ecosystem: one place that (1) tracks the value
/// of the whole platform over time (the index), (2) holds the spendable
/// **Rajas** action-credits with Sattva<->Rajas conversion, (3) earmarks care
/// allowance per cow, (4) lets protection-active accounts claim fee rebates so
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
    address public immutable cowNFT;


    // ---- gas rebates ("more reputation, less you pay")
    uint256 public gasRebateBase = 0.001 ether; // full-tier weekly rebate
    uint256 public gasRebatePeriod = 7 days;

    // ---- care pool
    mapping(uint256 => uint256) public carePoolOf;
    /// @notice Sum of every `carePoolOf` balance. The care round spends only
    ///         the pool's *uncommitted* ETH, so this is subtracted first.
    uint256 public totalCarePool;

    // ---- automatic care round
    /// @notice Share of uncommitted pool ETH earmarked per round.
    uint256 public careTitheBps = 2_000; // 20%
    uint256 public carePeriod = 7 days;
    uint256 public lastCareAt;
    /// @notice Gas bound: never scan/allocate more than this many cows per round.
    uint256 public maxCareCows = 200;

    // ---- platform value index
    struct Epoch {
        uint256 id;
        uint256 ts;
        uint256 backing;
        uint256 rating;
        uint256 stasis;
        uint256 laborHours;
        uint256 careQuorums;
        uint256 covered;
        uint256 backedCows;
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
        uint256 linkedTokenId; // 0 = general cause; else the cow it serves
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
    uint256 private _snapBackedCows;
    uint256 private _snapLabor;
    uint256 private _snapCare;
    uint256 private _snapCovered;

    /// @notice Cycle movement weights (owner-tunable). Protection signals
    ///         dominate by default; raw backing is a minor term so a field
    ///         that trades without protecting moves ~zero.
    uint256 public weightBacking = 1;
    uint256 public weightRating = 1;
    uint256 public weightBackedCow = 1_000;
    uint256 public weightCareQuorum = 500;
    uint256 public weightLaborHour = 10;
    uint256 public weightCoveredCow = 2_000;

    /// @notice Releases above this must be approved in an earlier block
    ///         (deliberate two-step; multisig-ready).
    uint256 public largeSpendThreshold = 0.5 ether;
    mapping(bytes32 => uint256) public spendApproval; // key -> approval block

    /// @notice Gas rebates subsidise protectors: minimum cumulative protection
    ///         activity to claim.
    uint256 public minProtectionActivity = 1;

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

    event GasRebateClaimed(address indexed account, uint256 amount);
    event CareAllocated(uint256 indexed tokenId, uint256 amount);
    event IndexSnapped(uint256 id, uint256 backing, uint256 rating, uint256 stasis, uint256 backedCows);
    event CareRound(uint256 at, uint256 budget, uint256 distributed, uint256 cows);
    event FundEventCreated(uint256 indexed id, address indexed creator, string metadataCid, uint256 goal);
    event FundContributed(uint256 indexed id, address indexed backer, uint256 amount, uint256 raised);
    event FundSpent(uint256 indexed id, address indexed to_, uint256 amount, uint256 spent);
    event FundEventClosed(uint256 indexed id);
    event CareAllocatedWithProof(uint256 indexed tokenId, uint256 amount, uint256 claimRef);
    event FundsReleasedWithProof(uint256 indexed id, address indexed to_, uint256 amount, uint256 claimRef);
    event CycleSettled(
        uint256 at,
        uint256 movement,
        uint256 creditPool,
        uint256 backerShare,
        uint256 raterShare,
        uint256 backers,
        uint256 raters
    );

    event CareRedeemed(
        uint256 indexed tokenId,
        address indexed account,
        uint256 stasisBurned,
        uint256 ethReleased,
        uint256 claimRef
    );

    error ZeroAmount();

    error AlreadyClaimed();
    error EmptyPool();
    error EmptyCid();
    error NoSuchEvent();
    error EventClosed();
    error NotEventCreator();
    error CannotSpend();
    error CycleNotElapsed();
    error CareNotElapsed();
    error NoAnchor();
    error NoProtection();
    error NoProof();
    error ProofMismatch();
    error NotApproved();
    error AlreadyRedeemed();
    error CapExceeded();
    error NotCaller();
    error NotLivingCow();

    /// @notice ETH per Stasis point: 0.001 ETH = 1e15 wei.
    uint256 public careRateWei = 1e15;
    mapping(uint256 => bool) public careRedeemed;

    constructor(address stasis_, address cowRating_, address cowNFT_) Ownable(msg.sender) {
        stasis = Stasis(stasis_);
        cowRating = CowRating(cowRating_);
        cowNFT = cowNFT_;
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

    /// @notice Owner tuning for what counts as field movement (see weights).
    function setCycleWeights(
        uint256 backing,
        uint256 rating,
        uint256 backedCow,
        uint256 careQuorum,
        uint256 laborHour,
        uint256 coveredCow
    ) external onlyOwner {
        weightBacking = backing;
        weightRating = rating;
        weightBackedCow = backedCow;
        weightCareQuorum = careQuorum;
        weightLaborHour = laborHour;
        weightCoveredCow = coveredCow;
    }

    /// @notice Owner tuning for the automatic care round.
    function setCareRound(uint256 titheBps, uint256 period) external onlyOwner {
        if (titheBps > BPS || period == 0) revert ZeroAmount();
        careTitheBps = titheBps;
        carePeriod = period;
    }

    function setSpendPolicy(uint256 threshold, uint256 minProtection) external onlyOwner {
        largeSpendThreshold = threshold;
        minProtectionActivity = minProtection;
    }

    /// @notice First step of a large release: records intent in this block so
    ///         the spend itself must happen deliberately later.
    function approveSpend(uint256 eventId, uint256 amount, address to_, uint256 claimRef) external onlyOwner {
        spendApproval[keccak256(abi.encode(eventId, amount, to_, claimRef))] = block.number;
    }

    function _requireSpendApproval(uint256 eventId, uint256 amount, address to_, uint256 claimRef) internal {
        if (amount <= largeSpendThreshold) return;
        uint256 approvedAt = spendApproval[keccak256(abi.encode(eventId, amount, to_, claimRef))];
        if (approvedAt == 0 || approvedAt >= block.number) revert NotApproved();
        delete spendApproval[keccak256(abi.encode(eventId, amount, to_, claimRef))];
    }

    /// @notice Cite an executed protection claim as the proof behind a release.
    ///         Returns the cow the proof concerns (0 when the event is general).
    function _requireProof(uint256 eventId, uint256 claimRef) internal view returns (uint256 proofCow) {
        (bool executed, uint256 cow) = cowRating.attestationProof(claimRef);
        if (!executed) revert NoProof();
        uint256 linked = events[eventId].linkedTokenId;
        if (linked != 0 && cow != linked) revert ProofMismatch();
        proofCow = linked;
    }



    // -------------------------------------------------------- fee rebates

    /// @notice Weekly, capped refund of the pool's native balance, for raters who
    ///         have shown protection activity. Subsidises protectors.
    function claimGasRebate() external {
        if (cowRating.protectionActivity(msg.sender) < minProtectionActivity) revert NoProtection();
        if (block.timestamp < lastGasClaim[msg.sender] + gasRebatePeriod) revert AlreadyClaimed();

        uint256 rebate = gasRebateBase;

        uint256 balance = address(this).balance;
        uint256 uncommitted = balance > totalCarePool ? balance - totalCarePool : 0;
        if (rebate == 0 || uncommitted == 0) revert EmptyPool();
        if (rebate > uncommitted) rebate = uncommitted;

        lastGasClaim[msg.sender] = block.timestamp;
        (bool ok, ) = payable(msg.sender).call{value: rebate}("");
        require(ok, "transfer failed");
        emit GasRebateClaimed(msg.sender, rebate);
    }

    // ------------------------------------------------------------ care pool

    /// @notice Earmark native funds for a cow's real-world upkeep. Money only
    ///         ever leaves through the owner (who pays caretakers in reality);
    ///         the chain keeps the public commitment. Only for live protection
    ///         projects — no anchor, no earmark.
    /// @dev Care rails are open only to a record with proof of hoof whose real
    ///      animal is still alive. The rest of the rating economy stays open.
    function _requireLiving(uint256 tokenId) internal view {
        CowNFT nft = CowNFT(cowNFT);
        if (!nft.isVerified(tokenId) || nft.isDeceased(tokenId)) revert NotLivingCow();
    }

    function allocateCare(uint256 tokenId, uint256 amount, uint256 claimRef) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        if (address(this).balance < amount) revert EmptyPool();
        _requireLiving(tokenId);
        if (!cowRating.protectionAnchorLive(tokenId)) revert NoAnchor();
        (bool executed, uint256 cow) = cowRating.attestationProof(claimRef);
        if (!executed || cow != tokenId) revert NoProof();
        carePoolOf[tokenId] += amount;
        totalCarePool += amount;
        emit CareAllocated(tokenId, amount);
        emit CareAllocatedWithProof(tokenId, amount, claimRef);
    }

    /// @notice The automatic care round. Once per `carePeriod`, a fixed share
    ///         of the pool's *uncommitted* ETH is earmarked across the cows the
    ///         community rates highest, pro rata by rating. Need is a cap, not
    ///         a weight: a well-rated cow with a small need gets its small need,
    ///         and the rest stays in the pool for the next round. No floor, no
    ///         per-cow ceiling — rating is the only selector.
    ///
    ///         Permissionless: anyone may trigger it, but it can never run more
    ///         often than the period. ETH still only leaves through `redeemCare`.
    function runCareRound() external {
        if (lastCareAt != 0 && block.timestamp < lastCareAt + carePeriod) revert CareNotElapsed();
        lastCareAt = block.timestamp;

        uint256 balance = address(this).balance;
        uint256 uncommitted = balance > totalCarePool ? balance - totalCarePool : 0;
        uint256 budget = (uncommitted * careTitheBps) / BPS;
        if (budget == 0) {
            emit CareRound(block.timestamp, 0, 0, 0);
            return;
        }

        CowNFT nft = CowNFT(cowNFT);
        uint256 supply = nft.nextTokenId();
        uint256 cap = maxCareCows;
        uint256[] memory ids = new uint256[](cap);
        uint256[] memory weights = new uint256[](cap);
        uint256[] memory rooms = new uint256[](cap);
        uint256 n;
        uint256 totalWeight;

        for (uint256 id = 1; id < supply && n < cap; id++) {
            if (!nft.isVerified(id) || nft.isDeceased(id)) continue;
            (uint256 need, , , ) = cowRating.funding(id);
            if (need == 0) continue;
            // Need is denominated in Stasis points; convert it to the maximum
            // ETH it can ever release at the current care rate.
            uint256 needWei = need * careRateWei;
            uint256 already = carePoolOf[id];
            if (already >= needWei) continue;
            if (!cowRating.protectionAnchorLive(id)) continue;
            uint256 weight = cowRating.ratingOf(id);
            if (weight == 0) continue;
            ids[n] = id;
            weights[n] = weight;
            rooms[n] = needWei - already;
            totalWeight += weight;
            n++;
        }

        uint256 distributed;
        if (totalWeight > 0) {
            for (uint256 i = 0; i < n; i++) {
                uint256 share = (budget * weights[i]) / totalWeight;
                uint256 amount = share > rooms[i] ? rooms[i] : share;
                if (amount == 0) continue;
                carePoolOf[ids[i]] += amount;
                distributed += amount;
            }
        }
        totalCarePool += distributed;
        emit CareRound(block.timestamp, budget, distributed, n);
    }

    /// @notice The native balance used for real-world disbursements, always
    ///         citing the executed protection claim that justifies it.
    function withdraw(address to, uint256 amount, uint256 claimRef) external onlyOwner {
        if (amount == 0 || address(this).balance < amount) revert EmptyPool();
        (bool executed, ) = cowRating.attestationProof(claimRef);
        if (!executed) revert NoProof();
        _requireSpendApproval(0, amount, to, claimRef);
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "transfer failed");
        emit FundsReleasedWithProof(0, to, amount, claimRef);
    }

    /// @notice Owner tuning for the one-way care conversion.
    function setCarePolicy(uint256 rateWei) external onlyOwner {
        careRateWei = rateWei;
    }

    /// @notice Burn Stasis to release real care money. The caller (the claim's
    ///         worker or the cow's owner) burns their own voiced/free Stasis and
    ///         receives ETH from the cow's care pool, bounded by the recorded
    ///         need and by the cow's rating — its credit line. One redemption
    ///         per claim; **burned Stasis is gone for good**. Rebuilding
    ///         reputation is ordinary future voting, not a recovery function.
    function redeemCare(uint256 tokenId, uint256 stasisAmount, uint256 claimRef) external {
        if (stasisAmount == 0) revert ZeroAmount();
        if (careRedeemed[claimRef]) revert AlreadyRedeemed();

        (bool executed, uint256 cow) = cowRating.attestationProof(claimRef);
        if (!executed || cow != tokenId) revert NoProof();

        Attestation att = Attestation(cowRating.attestation());
        uint8 kind = att.claimKind(claimRef);
        if (kind != 1 && kind != 6) revert CannotSpend(); // Care or Labor only
        address subject = att.claimSubject(claimRef);
        if (msg.sender != subject && CowNFT(cowNFT).ownerOf(tokenId) != msg.sender) revert NotCaller();

        // Care money is verified-living-only: a project cannot hold or redeem it,
        // and death closes the care rail even though the record stays usable.
        _requireLiving(tokenId);
        if (!cowRating.protectionAnchorLive(tokenId)) revert NoAnchor();

        uint256 rating = cowRating.ratingOf(tokenId);
        (uint256 need, , , ) = cowRating.funding(tokenId);
        uint256 cap = need > 0 ? need : rating;
        if (cap > rating) cap = rating;
        if (stasisAmount > cap) revert CapExceeded();

        uint256 ethOut = stasisAmount * careRateWei;
        if (ethOut > carePoolOf[tokenId] || ethOut > address(this).balance) revert EmptyPool();

        careRedeemed[claimRef] = true;
        stasis.spend(msg.sender, stasisAmount, "care-redeem");
        carePoolOf[tokenId] -= ethOut;
        totalCarePool -= ethOut;
        _requireSpendApproval(0, ethOut, msg.sender, claimRef);

        (bool ok, ) = payable(msg.sender).call{value: ethOut}("");
        require(ok, "transfer failed");
        emit CareRedeemed(tokenId, msg.sender, stasisAmount, ethOut, claimRef);
    }

    // ------------------------------------------------------ platform index

    function platformMetrics()
        public
        view
        returns (uint256 backing, uint256 rating, uint256 stasisTotal, uint256 backedCows)
    {
        backing = cowRating.totalBacking();
        rating = cowRating.totalRatingPoints();
        stasisTotal = stasis.totalScore();
        backedCows = cowRating.backedCowCount();
    }

    /// @notice Protection-side aggregates: attested labor hours, executed care
    ///         quorums and cows that once needed help and reached zero.
    function protectionMetrics()
        public
        view
        returns (uint256 laborHours, uint256 careQuorums, uint256 covered)
    {
        laborHours = cowRating.totalLaborHours();
        careQuorums = cowRating.careQuorumCount();
        covered = cowRating.cowsEverCovered();
    }

    /// @notice Simple composite "value of the whole platform" figure.
    function platformValue() public view returns (uint256) {
        (uint256 backing, uint256 rating, uint256 stasisTotal, ) = platformMetrics();
        // Weights are illustrative; components are the honest signal.
        return backing + rating * 10 + stasisTotal;
    }

    /// @notice Chess-window snapshot of the platform's health. Anyone may
    ///         call; each snapshot is cheap and history is immutable.
    function snapshotIndex() external {
        (uint256 backing, uint256 rating, uint256 stasisTotal, uint256 backedCows) =
            platformMetrics();
        (uint256 laborHours, uint256 careQuorums, uint256 covered) = protectionMetrics();
        indexHistory.push(
            Epoch({
                id: indexHistory.length + 1,
                ts: block.timestamp,
                backing: backing,
                rating: rating,
                stasis: stasisTotal,
                laborHours: laborHours,
                careQuorums: careQuorums,
                covered: covered,
                backedCows: backedCows
            })
        );
        emit IndexSnapped(indexHistory.length, backing, rating, stasisTotal, backedCows);
    }

    function epochCount() external view returns (uint256) {
        return indexHistory.length;
    }

    // ------------------------------------------------- charitable events

    /// @notice Open a cause: "winter bedding", "new stable", "vet truck"…
    ///         Only the prose reference is stored here; the title, pictures
    ///         and story live at `metadataCid` (the agorá / IPFS).
    function createEvent(string calldata metadataCid, uint256 goal) external returns (uint256 id) {
        return _createEvent(metadataCid, goal, 0);
    }

    /// @notice Open a cause serving one cow: releases later require that cow's
    ///         protection anchor to be live (see `spend`).
    function createEventForCow(string calldata metadataCid, uint256 goal, uint256 tokenId) external returns (uint256 id) {
        return _createEvent(metadataCid, goal, tokenId);
    }

    function _createEvent(string calldata metadataCid, uint256 goal, uint256 tokenId) internal returns (uint256 id) {
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
            closed: false,
            linkedTokenId: tokenId
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
    ///         are capped by what was raised. Every release cites the executed
    ///         protection claim that justifies it; cow-linked causes additionally
    ///         require that cow's anchor to be live, and large releases need a
    ///         prior `approveSpend` in an earlier block.
    function spend(uint256 eventId, uint256 amount, address to_, uint256 claimRef) external {
        FundEvent storage e = events[eventId];
        if (e.id == 0) revert NoSuchEvent();
        if (msg.sender != e.creator) revert NotEventCreator();
        if (amount == 0) revert ZeroAmount();
        if (to_ == address(0)) revert NoSuchEvent();
        if (e.spent + amount > e.raised) revert CannotSpend();
        if (address(this).balance < amount) revert EmptyPool();

        uint256 proofCow = _requireProof(eventId, claimRef);
        if (proofCow != 0 && !cowRating.protectionAnchorLive(proofCow)) revert NoAnchor();
        _requireSpendApproval(eventId, amount, to_, claimRef);

        e.spent += amount;
        (bool ok, ) = payable(to_).call{value: amount}("");
        require(ok, "transfer failed");
        emit FundSpent(eventId, to_, amount, e.spent);
        emit FundsReleasedWithProof(eventId, to_, amount, claimRef);
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
    ///         Movement is protection-weighted: executed care quorums, attested
    ///         labor hours and cows ever covered dominate; raw backing is a minor
    ///         term. A field that trades without protecting moves ~zero, so no
    ///         credit exists to thank anyone with.
    function settleCycle() external {
        if (lastCycleAt != 0 && block.timestamp < lastCycleAt + cyclePeriod) revert CycleNotElapsed();

        (uint256 backing, uint256 rating, , uint256 backedCows) = platformMetrics();
        (uint256 laborHours, uint256 careQuorums, uint256 covered) = protectionMetrics();

        // ---- first call prims the baseline (no credit yet)
        if (!_cyclePrimed) {
            _snapBacking = backing;
            _snapRating = rating;
            _snapBackedCows = backedCows;
            _snapLabor = laborHours;
            _snapCare = careQuorums;
            _snapCovered = covered;
            _cyclePrimed = true;
            _snapshotRaterActivity();
            lastCycleAt = block.timestamp;
            emit CycleSettled(block.timestamp, 0, 0, 0, 0, 0, 0);
            return;
        }

        uint256 movement;
        if (backing > _snapBacking) movement += (backing - _snapBacking) * weightBacking;
        if (rating > _snapRating) movement += (rating - _snapRating) * weightRating;
        if (backedCows > _snapBackedCows) movement += (backedCows - _snapBackedCows) * weightBackedCow;
        if (careQuorums > _snapCare) movement += (careQuorums - _snapCare) * weightCareQuorum;
        if (laborHours > _snapLabor) movement += (laborHours - _snapLabor) * weightLaborHour;
        if (covered > _snapCovered) movement += (covered - _snapCovered) * weightCoveredCow;

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
        _snapBackedCows = backedCows;
        _snapLabor = laborHours;
        _snapCare = careQuorums;
        _snapCovered = covered;
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
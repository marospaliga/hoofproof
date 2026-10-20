// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Stasis — non-transferable reputation ledger for Proof of a Hoof
///
/// Design rules (from the architecture blueprint):
///  1. Stasis is a *score*, never a token. There is no `transfer`, no approval,
///     no balance-of-allowance. It cannot be bought or sold. Score may be
///     encumbered as **collateral** (`bonded`) or as **voice** (`voiced`) — the
///     latter is what a cow's rating is made of.
///  2. Gains are capped per period so that **steady progress** beats spikes.
///     Losses are uncapped — punishment should be immediate and total.
///  3. Genesis (founder) allocations decay linearly so the bootstrap set cannot
///     become a permanent oligarchy.
///  4. Idle accounts decay lazily. Nothing ticks on its own; every decay is
///     computed at read time and persisted only when the account acts.
///
/// Only authorised modules (CowRating, Attestation) may change scores, and only
/// the owner may grant genesis or enrol a module.
contract Stasis is Ownable {
    uint256 public constant BPS = 10_000;

    /// Gains may not exceed this share of the current score in one step.
    uint256 public constant GAIN_CAP_BPS = 1_000; // 10%
    /// Floor on the gain cap so a brand-new account can bootstrap at all.
    uint256 public constant MIN_GAIN = 100;
    /// Genesis scores decay to zero over this long.
    uint256 public constant GENESIS_LIFE = 365 days;
    /// Idle accounts are immune to decay for this long first.
    uint256 public constant IDLE_GRACE = 180 days;
    /// After the grace period, decay reaches IDLE_DECAY_BPS over this window.
    uint256 public constant IDLE_DECAY_WINDOW = 365 days;
    uint256 public constant IDLE_DECAY_BPS = 2_000; // up to -20%

    struct Genesis {
        uint256 granted;
        uint256 grantedAt;
        uint256 decayed;
    }

    /// Raw score. After `_settle` this equals `effectiveScore`.
    mapping(address => uint256) public score;
    /// Portion of `score` locked as collateral (cannot be spent or staked away).
    mapping(address => uint256) public bonded;
    /// Portion of `score` committed as **voice** — a lien backing a rating.
    /// Voiced Stasis is still the account's score (it keeps its voting weight),
    /// but it cannot be spent, staked or double-committed. This is what makes
    /// rating and Stasis the same substance: a cow's rating is exactly the
    /// voiced score pointed at it.
    mapping(address => uint256) public voiced;
    mapping(address => uint256) public lastActive;
    mapping(address => Genesis) public genesisOf;
    mapping(address => bool) public isModule;

    /// Sum of every raw score — used for supply-level statistics.
    uint256 public totalScore;
    /// Sum of every voiced lien — the share of totalScore backing ratings.
    uint256 public totalVoiced;

    event ModuleSet(address indexed module, bool allowed);
    event ScoreChanged(address indexed account, int256 delta, bytes32 reason);
    event Bonded(address indexed account, uint256 amount);
    event Unbonded(address indexed account, uint256 amount);
    event Voiced(address indexed account, uint256 amount);
    event Unvoiced(address indexed account, uint256 amount);
    event VoicedTransferred(address indexed from, address indexed to, uint256 amount);
    event VoicedBurned(address indexed account, uint256 amount, bytes32 reason);
    event GenesisGranted(address indexed account, uint256 amount);

    error NotModule();
    error InsufficientFree();
    error InsufficientBonded();
    error InsufficientVoiced();
    error ZeroAddress();

    modifier onlyModule() {
        if (!isModule[msg.sender]) revert NotModule();
        _;
    }

    constructor() Ownable(msg.sender) {}

    // ---------------------------------------------------------------- admin

    function setModule(address module, bool allowed) external onlyOwner {
        if (module == address(0)) revert ZeroAddress();
        isModule[module] = allowed;
        emit ModuleSet(module, allowed);
    }

    /// @notice Bootstrap allocation for the founding wallets. Decays over GENESIS_LIFE.
    function grantGenesis(address account, uint256 amount) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        Genesis storage g = genesisOf[account];
        if (g.granted == 0) {
            g.grantedAt = block.timestamp;
        }
        g.granted += amount;
        score[account] += amount;
        totalScore += amount;
        lastActive[account] = block.timestamp;
        emit GenesisGranted(account, amount);
        emit ScoreChanged(account, int256(amount), "genesis");
    }

    // ------------------------------------------------------- views (no state)

    function _pendingGenesisDecay(address account) internal view returns (uint256) {
        Genesis storage g = genesisOf[account];
        if (g.granted == 0) return 0;
        uint256 elapsed = block.timestamp - g.grantedAt;
        if (elapsed >= GENESIS_LIFE) return g.granted - g.decayed;
        uint256 totalDecay = (g.granted * elapsed) / GENESIS_LIFE;
        if (totalDecay <= g.decayed) return 0;
        return totalDecay - g.decayed;
    }

    function _idleTime(address account) internal view returns (uint256) {
        uint256 last = lastActive[account];
        if (last == 0 || block.timestamp <= last) return 0;
        return block.timestamp - last;
    }

    /// @notice Total score currently encumbered by a lien (collateral or voice).
    function lockedOf(address account) public view returns (uint256) {
        return bonded[account] + voiced[account];
    }

    /// @notice The score an account actually has right now, with pending decay applied.
    function effectiveScore(address account) public view returns (uint256) {
        uint256 s = score[account];
        if (s == 0) return 0;

        uint256 genesisDecay = _pendingGenesisDecay(account);
        if (genesisDecay > s) genesisDecay = s;
        s -= genesisDecay;

        uint256 idle = _idleTime(account);
        if (idle > IDLE_GRACE) {
            uint256 over = idle - IDLE_GRACE;
            uint256 decay;
            if (over >= IDLE_DECAY_WINDOW) {
                decay = (s * IDLE_DECAY_BPS) / BPS;
            } else {
                decay = (s * IDLE_DECAY_BPS * over) / (BPS * IDLE_DECAY_WINDOW);
            }
            if (decay > s) decay = s;
            s -= decay;
        }

        // Bonded collateral and voiced liens are protected from decay: locking
        // rating must never make it impossible to unlock again. Only explicit
        // slashing (slashBonded / burnVoiced) can consume them.
        uint256 floor_ = lockedOf(account);
        if (s < floor_) s = floor_;
        return s;
    }

    /// @notice Free (unencumbered) Stasis available to spend or stake.
    function freeScore(address account) public view returns (uint256) {
        uint256 e = effectiveScore(account);
        uint256 l = lockedOf(account);
        return e > l ? e - l : 0;
    }

    function hasFree(address account, uint256 amount) external view returns (bool) {
        return freeScore(account) >= amount;
    }

    // ------------------------------------------------------------ settlement

    /// @dev Persist all pending decay and refresh the activity clock.
    function _settle(address account) internal {
        uint256 before = score[account];
        uint256 s = before;

        if (s > 0) {
            uint256 genesisDecay = _pendingGenesisDecay(account);
            if (genesisDecay > s) genesisDecay = s;
            if (genesisDecay > 0) {
                s -= genesisDecay;
                Genesis storage g = genesisOf[account];
                g.decayed += genesisDecay;
                if (g.decayed >= g.granted) {
                    g.granted = 0;
                    g.decayed = 0;
                }
            }

            uint256 idle = _idleTime(account);
            if (idle > IDLE_GRACE) {
                uint256 over = idle - IDLE_GRACE;
                uint256 decay;
                if (over >= IDLE_DECAY_WINDOW) {
                    decay = (s * IDLE_DECAY_BPS) / BPS;
                } else {
                    decay = (s * IDLE_DECAY_BPS * over) / (BPS * IDLE_DECAY_WINDOW);
                }
                if (decay > s) decay = s;
                s -= decay;
            }

            // Never let decay eat into bonded collateral or voiced liens.
            uint256 floor_ = lockedOf(account);
            if (s < floor_) s = floor_;
        }

        if (s != before) {
            if (s > before) totalScore += s - before;
            else totalScore -= before - s;
            score[account] = s;
        }
        lastActive[account] = block.timestamp;
    }

    /// @dev Apply a signed change, enforcing the gain cap. Losses are uncapped.
    function _applyDelta(address account, int256 requested, bytes32 reason) internal returns (int256 applied) {
        _settle(account);
        uint256 current = score[account];

        if (requested >= 0) {
            uint256 value = uint256(requested);
            uint256 cap = (current * GAIN_CAP_BPS) / BPS;
            if (cap < MIN_GAIN) cap = MIN_GAIN;
            if (value > cap) value = cap;
            if (value > 0) {
                score[account] += value;
                totalScore += value;
                applied = int256(value);
            }
        } else {
            uint256 value = uint256(-requested);
            // General punishment can only consume *free* score. Bonded and
            // voiced score are consumed by their dedicated paths
            // (`slashBonded`, `burnVoiced`) so the lien invariant survives.
            uint256 locked = lockedOf(account);
            uint256 free_;
            if (current > locked) free_ = current - locked;
            if (value > free_) value = free_;
            if (value > 0) {
                score[account] -= value;
                totalScore -= value;
                applied = -int256(value);
            }
        }
        emit ScoreChanged(account, applied, reason);
    }

    // --------------------------------------------------------------- modules

    /// @notice Grant reputation. Gain-capped: you cannot spike your score.
    function award(address account, uint256 amount, bytes32 reason) external onlyModule returns (uint256) {
        int256 applied = _applyDelta(account, int256(amount), reason);
        return applied > 0 ? uint256(applied) : 0;
    }

    /// @notice Punish. Uncapped — fraud should hurt immediately.
    function slash(address account, uint256 amount, bytes32 reason) external onlyModule returns (uint256) {
        int256 applied = _applyDelta(account, -int256(amount), reason);
        return applied < 0 ? uint256(-applied) : 0;
    }

    /// @notice Voluntary exit cost. Uncapped; requires free balance.
    function spend(address account, uint256 amount, bytes32 reason) external onlyModule {
        _settle(account);
        uint256 locked = lockedOf(account);
        if (score[account] < locked || score[account] - locked < amount) revert InsufficientFree();
        score[account] -= amount;
        totalScore -= amount;
        emit ScoreChanged(account, -int256(amount), reason);
    }

    /// @notice Lock score as collateral. Bonded score cannot be spent or staked away.
    function bond(address account, uint256 amount) external onlyModule {
        _settle(account);
        uint256 locked = lockedOf(account);
        if (score[account] < locked || score[account] - locked < amount) revert InsufficientFree();
        bonded[account] += amount;
        emit Bonded(account, amount);
    }

    // ----------------------------------------------------------------- voice

    /// @notice Commit score as a lien backing a rating. The score keeps its
    ///         weight but can no longer be spent, staked or voiced elsewhere.
    function voice(address account, uint256 amount) external onlyModule {
        _settle(account);
        uint256 locked = lockedOf(account);
        if (score[account] < locked || score[account] - locked < amount) revert InsufficientFree();
        voiced[account] += amount;
        totalVoiced += amount;
        emit Voiced(account, amount);
    }

    /// @notice Release a lien (unvote / dilution / stale reap). The score
    ///         returns to the free pool; it is not minted or burned.
    function unvoice(address account, uint256 amount) external onlyModule {
        if (voiced[account] < amount) revert InsufficientVoiced();
        voiced[account] -= amount;
        totalVoiced -= amount;
        emit Unvoiced(account, amount);
    }

    /// @notice Move part of a voicer's lien to another account as a real
    ///         transfer of score (the author award). Zero-sum: totalScore is
    ///         unchanged and the recipient's gain is not capped, because this
    ///         is earned score changing hands, not new issuance.
    function transferVoiced(address from, address to, uint256 amount) external onlyModule {
        if (to == address(0)) revert ZeroAddress();
        if (voiced[from] < amount) revert InsufficientVoiced();
        _settle(from);
        _settle(to);
        if (score[from] < amount) revert InsufficientVoiced();

        voiced[from] -= amount;
        totalVoiced -= amount;
        score[from] -= amount;
        score[to] += amount;
        lastActive[to] = block.timestamp;

        emit VoicedTransferred(from, to, amount);
        emit ScoreChanged(from, -int256(amount), "voice-transfer");
        emit ScoreChanged(to, int256(amount), "voice-transfer");
    }

    /// @notice Destroy part of a lien (moderation slash). The score disappears
    ///         with the rating it backed — this is the one-way cost of fraud.
    function burnVoiced(address account, uint256 amount, bytes32 reason) external onlyModule {
        _settle(account);
        if (voiced[account] < amount || score[account] < amount) revert InsufficientVoiced();
        voiced[account] -= amount;
        totalVoiced -= amount;
        score[account] -= amount;
        totalScore -= amount;
        emit VoicedBurned(account, amount, reason);
        emit ScoreChanged(account, -int256(amount), reason);
    }

    function unbond(address account, uint256 amount) external onlyModule {
        _settle(account);
        if (bonded[account] < amount) revert InsufficientBonded();
        bonded[account] -= amount;
        emit Unbonded(account, amount);
    }

    /// @notice Seize bonded collateral (dispute loss). Full deduction, no cap.
    function slashBonded(address account, uint256 amount, bytes32 reason) external onlyModule {
        _settle(account);
        if (bonded[account] < amount) revert InsufficientBonded();
        if (score[account] < amount) revert InsufficientBonded();
        bonded[account] -= amount;
        score[account] -= amount;
        totalScore -= amount;
        emit ScoreChanged(account, -int256(amount), reason);
    }

    /// @notice Convenience for modules: how much free score an account has.
    function free(address account) external view returns (uint256) {
        return freeScore(account);
    }
}

// The clock: every deadline in the system, in one table, in two flavours.
//
// Two profiles, same rules:
//
//   production — the real ruler. A month is a month.
//   beta       — the same ruler, shortened 30x. One beta day is one
//                production month, so a tester can walk the whole
//                lifecycle (conviction, need periods, dormancy,
//                corroboration, moderation windows) in an afternoon.
//
// Only the *numbers* change. Every comparison in every contract stays
// exactly as it was: the chain still enforces the same rules, it just
// counts in a smaller unit. That is the whole trick — no branch, no
// "if beta" anywhere in the contracts.
//
// Floor rule: nothing drops below one hour, so no window can collapse
// into "instant" and no rule becomes unreachable in a demo.

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const production = {
  name: "production",
  label: "Production clock",
  blurb: "Real time. A month is a month.",
  cowRating: {
    lockPeriod: 30 * DAY,
    needPeriod: 30 * DAY,
    careWindow: 90 * DAY,
    laborWindow: 90 * DAY,
    needWindow: 90 * DAY,
    headStartWindow: 30 * DAY,
    laborLockPeriod: 30 * DAY,
    tierCommit1: 90 * DAY,
    tierCommit2: 180 * DAY,
    momentumDecay: 90 * DAY,
    contentDormantWindow: 180 * DAY,
  },
  stasis: {
    genesisLife: 365 * DAY,
    idleGrace: 180 * DAY,
    idleDecayWindow: 365 * DAY,
  },
  generalPool: {
    cyclePeriod: 6 * HOUR,
    gasRebatePeriod: 7 * DAY,
    carePeriod: 7 * DAY,
  },
  moderation: {
    fastPathDelay: 48 * HOUR,
    challengeWindow: 3 * DAY,
  },
  herdCouncil: {
    minDuration: 1 * DAY,
    maxDuration: 30 * DAY,
  },
};

const beta = {
  name: "beta",
  label: "Beta clock",
  blurb: "One beta day is one production month.",
  cowRating: {
    lockPeriod: 1 * DAY, //        30d
    needPeriod: 1 * DAY, //        30d
    careWindow: 3 * DAY, //        90d
    laborWindow: 3 * DAY, //       90d
    needWindow: 3 * DAY, //        90d
    headStartWindow: 1 * DAY, //   30d
    laborLockPeriod: 1 * DAY, //   30d
    tierCommit1: 3 * DAY, //       90d
    tierCommit2: 6 * DAY, //      180d
    momentumDecay: 3 * DAY, //     90d
    contentDormantWindow: 6 * DAY, // 180d
  },
  stasis: {
    genesisLife: 12 * DAY + 4 * HOUR, // 365d
    idleGrace: 6 * DAY, //               180d
    idleDecayWindow: 12 * DAY + 4 * HOUR, // 365d
  },
  generalPool: {
    cyclePeriod: 12 * MINUTE, //  6h
    gasRebatePeriod: 5 * HOUR + 36 * MINUTE, // 7d
    carePeriod: 5 * HOUR + 36 * MINUTE, // 7d
  },
  moderation: {
    fastPathDelay: 1 * HOUR + 36 * MINUTE, // 48h
    challengeWindow: 2 * HOUR + 24 * MINUTE, // 3d
  },
  herdCouncil: {
    minDuration: 48 * MINUTE, // 1d
    maxDuration: 1 * DAY, //   30d
  },
};

const PROFILES = { production, beta };

// Every window, flattened, so a script can read them all off the chain and
// print one honest table. Keys match the contract getters.
function flatWindows(profile) {
  return {
    ...profile.cowRating,
    ...profile.stasis,
    cyclePeriod: profile.generalPool.cyclePeriod,
    gasRebatePeriod: profile.generalPool.gasRebatePeriod,
    carePeriod: profile.generalPool.carePeriod,
    fastPathDelay: profile.moderation.fastPathDelay,
    challengeWindow: profile.moderation.challengeWindow,
    minDuration: profile.herdCouncil.minDuration,
    maxDuration: profile.herdCouncil.maxDuration,
  };
}

// Human-readable window: "30d", "5h 36m", "48m". Used by the CLI tables and
// (mirrored) by the frontend, so the same phrase shows up in both places.
function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds)));
  if (s === 0) return "0m";
  const d = Math.floor(s / DAY);
  const h = Math.floor((s % DAY) / HOUR);
  const m = Math.floor((s % HOUR) / MINUTE);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// Which profile a given set of live windows matches, or null if it matches
// neither (someone hand-tuned the clock).
function identifyProfile(live) {
  for (const p of Object.values(PROFILES)) {
    const want = flatWindows(p);
    const keys = Object.keys(want);
    if (keys.every((k) => Number(live[k]) === Number(want[k]))) return p.name;
  }
  return null;
}

// Which profile a network should start on. The beta lives on a private
// chain; public testnets keep the real ruler.
function defaultProfileFor(network) {
  const wanted = process.env.POHAI_TIMINGS || process.env.PROFILE;
  if (wanted) {
    const p = String(wanted).toLowerCase();
    if (PROFILES[p]) return p;
    throw new Error(
      `"${wanted}" is not a known profile (${Object.keys(PROFILES).join(", ")})`
    );
  }
  return network === "localhost" || network === "hardhat" ? "beta" : "production";
}

module.exports = {
  MINUTE,
  HOUR,
  DAY,
  PROFILES,
  flatWindows,
  fmtDuration,
  identifyProfile,
  defaultProfileFor,
};

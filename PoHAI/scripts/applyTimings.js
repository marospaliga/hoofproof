// Moves the clock. Run it against a deployed stack:
//
//   npm run timings                     -> follow the network (local = beta)
//   PROFILE=production npm run timings  -> put the real ruler back
//   PROFILE=beta npm run timings        -> switch to the short ruler
//
// (Hardhat does not forward CLI flags to scripts, so the profile travels in
// the environment.)
//
// The chain stays the single source of truth: this script is just the
// owner's pen. It reads the live windows, writes the profile, then reads
// them back so you can see the before and after side by side.
//
//   npm run timings:beta        -> switch the local chain to the beta clock
//   npm run timings:production  -> put the real ruler back
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const {
  PROFILES,
  fmtDuration,
  identifyProfile,
  defaultProfileFor,
} = require("./timings");

// The order here must match `CowRating.Timings` exactly.
const COW_RATING_FIELDS = [
  "lockPeriod",
  "needPeriod",
  "careWindow",
  "laborWindow",
  "needWindow",
  "headStartWindow",
  "laborLockPeriod",
  "tierCommit1",
  "tierCommit2",
  "momentumDecay",
  "contentDormantWindow",
  "zeroStreakRequired",
];

async function attach(deploy) {
  const { ethers } = hre;
  return {
    cowRating: await ethers.getContractAt("CowRating", deploy.cowRating),
    stasis: await ethers.getContractAt("Stasis", deploy.stasis),
    generalPool: await ethers.getContractAt("GeneralPool", deploy.generalPool),
    moderation: await ethers.getContractAt("Moderation", deploy.moderation),
    herdCouncil: await ethers.getContractAt("HerdCouncil", deploy.herdCouncil),
  };
}

/// Read every live window off the chain.
async function readWindows(c) {
  const out = {};
  for (const f of COW_RATING_FIELDS) out[f] = Number(await c.cowRating[f]());
  out.genesisLife = Number(await c.stasis.genesisLife());
  out.idleGrace = Number(await c.stasis.idleGrace());
  out.idleDecayWindow = Number(await c.stasis.idleDecayWindow());
  out.cyclePeriod = Number(await c.generalPool.cyclePeriod());
  out.gasRebatePeriod = Number(await c.generalPool.gasRebatePeriod());
  out.fastPathDelay = Number(await c.moderation.fastPathDelay());
  out.challengeWindow = Number(await c.moderation.challengeWindow());
  out.minDuration = Number(await c.herdCouncil.minDuration());
  out.maxDuration = Number(await c.herdCouncil.maxDuration());
  return out;
}

/// Write a profile onto the chain. Setters that take more than a duration
/// (cycle weights, rebate base, moderation dominance) are passed their own
/// current values back, so only the clock moves.
async function applyProfile(name, c, deployer) {
  const p = PROFILES[name];
  if (!p) throw new Error(`Unknown profile "${name}" (${Object.keys(PROFILES).join(", ")})`);

  const ratingStruct = COW_RATING_FIELDS.map((f) => p.cowRating[f]);
  await (await c.cowRating.connect(deployer).setTimings(ratingStruct)).wait();

  await (
    await c.stasis
      .connect(deployer)
      .setDecayWindows(p.stasis.genesisLife, p.stasis.idleGrace, p.stasis.idleDecayWindow)
  ).wait();

  const [shareBps, ratioBps, maxCredit] = await Promise.all([
    c.generalPool.backerShareBps(),
    c.generalPool.creditRatioBps(),
    c.generalPool.maxCycleCredit(),
  ]);
  await (
    await c.generalPool
      .connect(deployer)
      .setCycle(p.generalPool.cyclePeriod, shareBps, ratioBps, maxCredit)
  ).wait();

  const rebateBase = await c.generalPool.gasRebateBase();
  await (
    await c.generalPool
      .connect(deployer)
      .setGasRebate(rebateBase, p.generalPool.gasRebatePeriod)
  ).wait();

  const [dominance, minVoters] = await Promise.all([
    c.moderation.dominanceBps(),
    c.moderation.minDistinctVoters(),
  ]);
  await (
    await c.moderation
      .connect(deployer)
      .setPolicy(dominance, p.moderation.fastPathDelay, p.moderation.challengeWindow, minVoters)
  ).wait();

  await (
    await c.herdCouncil.connect(deployer).setDurationLimits(p.herdCouncil.minDuration, p.herdCouncil.maxDuration)
  ).wait();

  return p;
}

/// Print the live clock as a table, next to the profile it was compared against.
function printTable(before, after, profileName) {
  const rows = Object.keys(after);
  const width = Math.max(...rows.map((r) => r.length));
  const show = (v, key) => (key === "zeroStreakRequired" ? `${v} periods` : fmtDuration(v));
  console.log("");
  console.log(`  ${"window".padEnd(width)}  ${"before".padStart(10)}  ${"after".padStart(10)}`);
  console.log(`  ${"-".repeat(width)}  ${"-".repeat(10)}  ${"-".repeat(10)}`);
  for (const r of rows) {
    const b = show(before[r], r);
    const a = show(after[r], r);
    const mark = b === a ? " " : "*";
    console.log(`  ${r.padEnd(width)}  ${b.padStart(10)}  ${a.padStart(10)} ${mark}`);
  }
  console.log("");
  const matched = identifyProfile(after);
  console.log(
    matched === profileName
      ? `  Clock is now: ${PROFILES[profileName].label} — ${PROFILES[profileName].blurb}`
      : `  Clock is now: ${matched ? PROFILES[matched].label : "custom (hand-tuned)"}`
  );
  if (matched !== profileName) {
    console.log(`  (asked for ${profileName})`);
  }
}

async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  const deployFile = path.join(__dirname, "..", "deployed.json");
  if (!fs.existsSync(deployFile)) {
    console.error("No deployed.json — run `npm run deploy:local` first.");
    process.exitCode = 1;
    return;
  }
  const deploy = JSON.parse(fs.readFileSync(deployFile, "utf8"));

  // PROFILE wins; a --profile flag is accepted too for anyone running this
  // outside hardhat; otherwise the network decides (local = beta).
  const argv = process.argv.slice(2);
  const idx = argv.indexOf("--profile");
  const chosen =
    process.env.PROFILE ||
    process.env.POHAI_PROFILE ||
    (idx >= 0 && argv[idx + 1] ? argv[idx + 1] : null);
  const name = (chosen || defaultProfileFor(hre.network.name)).toLowerCase();

  const c = await attach(deploy);
  const before = await readWindows(c);
  await applyProfile(name, c, deployer);
  const after = await readWindows(c);

  printTable(before, after, name);
  console.log(`  Applied on ${hre.network.name} by ${deployer.address}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { applyProfile, readWindows, attach, printTable, COW_RATING_FIELDS };

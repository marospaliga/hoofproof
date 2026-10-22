// Warp the chain clock. On a private beta chain this is the difference
// between "wait a month" and "wait a coffee break".
//
//   WARP=2d    npm run warp
//   WARP=26h   npm run warp
//   WARP_DAYS=2 npm run warp
//   WARP_HOURS=26 npm run warp
//
// (Hardhat does not forward CLI flags to scripts, so the amount travels in
// the environment.)
//
// Hardhat's `evm_increaseTime` moves the block timestamp forward and mines a
// block, so every deadline in the contracts re-evaluates against the new
// clock. This is a *private chain* tool: it is refused on any network that
// is not a local one, so it can never touch a shared testnet.

const hre = require("hardhat");

const LOCAL = new Set(["hardhat", "localhost", "127.0.0.1"]);

const UNITS = { s: 1, m: 60, h: 3600, d: 86400 };

/// How far to move: one WARP string ("2d") and/or one WARP_<UNIT> number.
function parseAmount(argv = process.argv.slice(2), env = process.env) {
  let seconds = 0;
  let said = [];

  const raw = env.WARP || env.POHAI_WARP;
  if (raw) {
    const m = String(raw).trim().match(/^(\d+(?:\.\d+)?)\s*([smhd])?$/i);
    if (!m) throw new Error(`WARP="${raw}" — write it like 2d, 26h, 30m or 90s`);
    const mult = UNITS[(m[2] || "d").toLowerCase()];
    seconds += Math.round(Number(m[1]) * mult);
    said.push(raw);
  }

  for (const [key, mult] of [
    ["WARP_SECONDS", 1],
    ["WARP_MINUTES", 60],
    ["WARP_HOURS", 3600],
    ["WARP_DAYS", 86400],
  ]) {
    if (env[key] === undefined) continue;
    const v = Number(env[key]);
    if (!Number.isFinite(v)) throw new Error(`${key} must be a number`);
    seconds += v * mult;
    said.push(`${v * mult}s`);
  }

  // Fallback: allow flags too, for anyone running this with plain node.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = a.match(/^--(\w+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const mult = UNITS[key[key.length - 1]] && key.length === 1 ? UNITS[key] : undefined;
    if (mult) {
      seconds += Number(argv[++i]) * mult;
      continue;
    }
    const v = String(argv[++i] || "");
    const m2 = v.match(/^(\d+(?:\.\d+)?)([smhd])$/i);
    if (m2) seconds += Math.round(Number(m2[1]) * UNITS[m2[2].toLowerCase()]);
  }

  return { seconds, said };
}

function fmt(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(" ") || "0s";
}

async function main() {
  const { seconds } = parseAmount();
  if (!LOCAL.has(hre.network.name)) {
    console.error(
      `Refusing to warp "${hre.network.name}". Time travel is only for a private chain.`
    );
    process.exitCode = 1;
    return;
  }
  if (seconds <= 0) {
    console.error("Nothing to warp. Try:  WARP=2d npm run warp   (or WARP_HOURS=26)");
    process.exitCode = 1;
    return;
  }

  const before = await hre.ethers.provider.getBlock("latest");
  await hre.network.provider.send("evm_increaseTime", [seconds]);
  await hre.network.provider.send("evm_mine", []);
  const after = await hre.ethers.provider.getBlock("latest");

  console.log(`Clock moved forward ${fmt(seconds)}.`);
  console.log(
    `  ${new Date(before.timestamp * 1000).toISOString()}  ->  ${new Date(after.timestamp * 1000).toISOString()}`
  );
  console.log(`  Chain time is now ${new Date(after.timestamp * 1000).toUTCString()}.`);
  console.log("");
  console.log("  Anything that was waiting on a deadline has re-evaluated against the new clock.");
  console.log("  (a block was mined, so lazy accrual — conviction ramp, decay — has settled too)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// Re-pin the curriculum on-chain.
//
// The Academy contract stores one hash per lesson, so the curriculum is
// auditable and versioned on-chain: the hash says "these are the bytes of
// lesson N". Editing a lesson file changes its hash, and the pin goes stale
// until this script commits the new bytes.
//
//   npm run pin-lessons
//
// The owner (deployer) is the only account that can write a pin. Lessons that
// are already pinned correctly are left alone, so the script is safe to run
// any time.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { LESSONS, loadLesson } = require("../server/curriculum");

const DEPLOYED = path.join(__dirname, "..", "deployed.json");

function short(hash) {
  if (!hash || hash === "0x" + "0".repeat(64)) return "(unset)";
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

async function main() {
  const [signer] = await hre.ethers.getSigners();
  let deployed = {};
  try {
    deployed = JSON.parse(fs.readFileSync(DEPLOYED, "utf8"));
  } catch {
    // no deployment yet
  }
  if (!deployed.academy) {
    console.error("No Academy contract in deployed.json — deploy first.");
    process.exitCode = 1;
    return;
  }

  const academy = await hre.ethers.getContractAt("Academy", deployed.academy, signer);
  console.log(`Pinning the curriculum on ${hre.network.name} as ${signer.address}`);
  console.log(`  Academy: ${deployed.academy}`);
  console.log("");

  let changed = 0;
  for (const entry of LESSONS) {
    const lesson = loadLesson(entry.id);
    const [current, reward, exists] = await academy.lessonInfo(entry.id);
    if (exists && current === lesson.hash) {
      console.log(`  lesson ${entry.id}  already pinned  ${short(current)}  +${reward} Stasis`);
      continue;
    }
    const tx = await academy.setLesson(entry.id, lesson.hash, lesson.reward, lesson.cert);
    await tx.wait();
    changed += 1;
    console.log(
      `  lesson ${entry.id}  pinned ${short(current)} → ${short(lesson.hash)}  ` +
        `+${lesson.reward} Stasis${lesson.cert ? "  (cert)" : ""}`
    );
  }

  console.log("");
  console.log(
    changed === 0
      ? "Everything already matched — nothing to write."
      : `${changed} lesson${changed === 1 ? "" : "s"} re-pinned.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

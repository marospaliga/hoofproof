// Deterministic recompute of the rating index from chain logs.
// Usage: npx hardhat run scripts/recomputeRatings.js --network localhost [tokenId]
// Prints the same breakdown the server serves, straight from events — if the
// server ever disagrees with this output, the server is wrong.
const { ethers } = require("hardhat");

async function main() {
  const tokenArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
  const [deployer] = await ethers.getSigners();
  console.log("reader:", deployer.address);

  const d = require("../deployed.json");
  const rating = await ethers.getContractAt("CowRating", d.cowRating);
  const pool = await ethers.getContractAt("GeneralPool", d.generalPool);

  const [labor, care, solved] = await pool.protectionMetrics();
  console.log(`field: laborHours=${labor} careQuorums=${care} solved=${solved} totalRating=${await rating.totalRatingPoints()}`);

  const next = Number(await (await ethers.getContractAt("CowNFT", d.cowNFT)).nextTokenId());
  const ids = tokenArg ? [Number(tokenArg)] : Array.from({ length: next - 1 }, (_, i) => i + 1);

  const voted = await rating.queryFilter(rating.filters.Voted());
  const boosted = await rating.queryFilter(rating.filters.Boosted());
  const staked = await rating.queryFilter(rating.filters.Staked());
  const rewarded = await rating.queryFilter(rating.filters.ContentRewarded());
  const laborEv = await rating.queryFilter(rating.filters.LaborRewarded());

  for (const tid of ids) {
    let stakeTotal = 0n;
    let voteWeight = 0n;
    let votes = 0;
    let earned = 0n;
    for (const e of staked) if (Number(e.args.tokenId) === tid) stakeTotal += e.args.amount;
    for (const e of voted) if (Number(e.args.tokenId) === tid) { voteWeight += e.args.weight; votes++; }
    for (const e of boosted) if (Number(e.args.tokenId) === tid) { voteWeight += e.args.weight; votes++; }
    for (const e of rewarded) if (Number(e.args.tokenId) === tid) earned += e.args.award;
    let hours = 0n;
    for (const e of laborEv) if (Number(e.args.tokenId) === tid) hours += e.args.attestedHours;
    const [live, onChain] = await Promise.all([
      rating.protectionAnchorLive(tid),
      rating.cowRating(tid),
    ]);
    console.log(
      `#${tid} anchor=${live} onChain=${onChain} loggedVotes=${votes}x weight=${voteWeight} ` +
        `staked=${stakeTotal} labor=${hours}h authorMinted=${earned}`
    );
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});

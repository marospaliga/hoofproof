// Quick on-chain health check for the demos stack.
// Usage: npx hardhat run scripts/checkDemo.js --network localhost
// Prints the live block height, deployed addresses, seeded scores and the
// state of a couple of demo cows so you can see at a glance whether the
// running node actually has the contracts + seed the frontend expects.
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

function abiOf(sol) {
  return require(path.join(__dirname, "..", "artifacts", "contracts", sol + ".sol", sol + ".json")).abi;
}

async function main() {
  const deployFile = path.join(__dirname, "..", "deployed.json");
  if (!fs.existsSync(deployFile)) {
    console.log("No deployed.json — run `npm run deploy:local` first.");
    return;
  }
  const deploy = JSON.parse(fs.readFileSync(deployFile, "utf8"));

  const block = await ethers.provider.getBlockNumber();
  const stasis = await ethers.getContractAt(abiOf("Stasis"), deploy.stasis);
  const cowNFT = await ethers.getContractAt(abiOf("CowNFT"), deploy.cowNFT);
  const cowRating = await ethers.getContractAt(abiOf("CowRating"), deploy.cowRating);
  const generalPool = await ethers.getContractAt(abiOf("GeneralPool"), deploy.generalPool);

  console.log(`chain block: ${block}`);
  console.log(
    `addrs: stasis=${deploy.stasis} cowNFT=${deploy.cowNFT} cowRating=${deploy.cowRating} ` +
      `attestation=${deploy.attestation} generalPool=${deploy.generalPool} herdCouncil=${deploy.herdCouncil}`
  );

  const [deployer, r1, r2] = await ethers.getSigners();
  const scores = [
    ["deployer (acct #0)", deployer.address],
    ["r1 (acct #1)", r1.address],
    ["r2 (acct #2)", r2.address],
  ];
  for (const [label, addr] of scores) {
    const [s, b, vp, mom] = await Promise.all([
      stasis.effectiveScore(addr),
      stasis.bonded(addr),
      cowRating.votingPowerOf(addr),
      cowRating.momentumBps(addr),
    ]);
    console.log(
      `score  ${label}: effective=${s} bonded=${b} votePower=${vp} momentum=${mom}`
    );
  }

  const rajas = [["r1 (acct #1)", r1.address]];
  for (const [label, addr] of rajas) {
    console.log(`rajas  ${label}: ${await generalPool.rajas(addr)}`);
  }
  const [careHans, epochs, platformValue] = await Promise.all([
    generalPool.carePoolOf(4),
    generalPool.epochCount(),
    generalPool.platformValue(),
  ]);
  console.log(
    `pool: nativeBalance=${await ethers.provider.getBalance(deploy.generalPool)} carePool[Hans]=${careHans} ` +
      `epochs=${epochs} platformValue=${platformValue}`
  );

  const next = Number(await cowNFT.nextTokenId());
  console.log(`cows on chain: ${next - 1}`);
  for (let id = 1; id < next; id++) {
    const [status, owner, rating] = await Promise.all([
      cowNFT.statusOf(id),
      cowNFT.ownerOf(id),
      cowRating.ratingOf(id),
    ]);
    let note = `  #${id} ${["Inert", "Active", "SelfSustaining", "Memorial", "Retired"][Number(status)]} rating=${Number(rating)} owner=${owner.slice(0, 8)}…`;
    if (id === 4) {
      // Hans — has attested funding need + a 2-rater herd with the +5% bonus.
      const [fund, backing] = await Promise.all([cowRating.funding(id), cowRating.totalStaked(id)]);
      note += ` backing=${backing} fundingNeed=${fund.need}`;
    }
    console.log(note);
  }
  console.log("Chain is healthy — if the frontend still errors, check MetaMask's RPC URL is http://127.0.0.1:8545 and reload.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
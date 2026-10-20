// Deploys and wires the whole PoH system in dependency order, then prints an
// address summary. Run with:
//
//   npx hardhat run scripts/deploy.js
//   npx hardhat run scripts/deploy.js --network sepolia
//
// The deployer becomes the owner of every contract. Zero-start economy:
// nobody receives genesis score — every account (including the pilot) earns
// its way in via the Academy course and protection work.
//
// Pilot wiring is done *after* deployment, one place, no circular constructors:
//
//   Stasis.setModule(CowRating)  -- CowRating may change scores
//   Stasis.setModule(Attestation) -- Attestation may bond/slash
//   CowNFT.setRatingEngine(CowRating) -- CowRating validates transfers
//   CowRating.setWiring(CowNFT, Attestation) -- who CowRating trusts

const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with", deployer.address);

  const Stasis = await ethers.getContractFactory("Stasis");
  const stasis = await Stasis.deploy();
  await stasis.waitForDeployment();

  const CowNFT = await ethers.getContractFactory("CowNFT");
  const cowNFT = await CowNFT.deploy();
  await cowNFT.waitForDeployment();

  const CowRating = await ethers.getContractFactory("CowRating");
  const cowRating = await CowRating.deploy(await stasis.getAddress());
  await cowRating.waitForDeployment();

  const Attestation = await ethers.getContractFactory("Attestation");
  const attestation = await Attestation.deploy(
    await stasis.getAddress(),
    await cowNFT.getAddress(),
    await cowRating.getAddress()
  );
  await attestation.waitForDeployment();

  const GeneralPool = await ethers.getContractFactory("GeneralPool");
  const generalPool = await GeneralPool.deploy(
    await stasis.getAddress(),
    await cowRating.getAddress(),
    await cowNFT.getAddress()
  );
  await generalPool.waitForDeployment();

  const HerdCouncil = await ethers.getContractFactory("HerdCouncil");
  const herdCouncil = await HerdCouncil.deploy(
    await cowNFT.getAddress(),
    await cowRating.getAddress()
  );
  await herdCouncil.waitForDeployment();

  // Academy pays course completions from Stasis, so it must be a module.
  // The grader (quiz signer) defaults to the deployer; production should set
  // it to the server key via setGrader.
  const Academy = await ethers.getContractFactory("Academy");
  const academy = await Academy.deploy(await stasis.getAddress());
  await academy.waitForDeployment();

  // Moderation reads scores/ratings only (snapshots, no score changes), so it
  // needs no Stasis module enrollment — the server enforces visibility off its
  // execution record.
  const Moderation = await ethers.getContractFactory("Moderation");
  const moderation = await Moderation.deploy(
    await stasis.getAddress(),
    await cowRating.getAddress()
  );
  await moderation.waitForDeployment();

  // ---- wire everything (owner-only, one-time) ------------------------------
  await stasis.setModule(await cowRating.getAddress(), true);
  await stasis.setModule(await attestation.getAddress(), true);
  await stasis.setModule(await generalPool.getAddress(), true);
  await stasis.setModule(await academy.getAddress(), true);
  await cowNFT.setRatingEngine(await cowRating.getAddress());
  await cowRating.setWiring(await cowNFT.getAddress(), await attestation.getAddress());
  await cowRating.setModeration(await moderation.getAddress(), 5_000);
  // Flat kind weights (discussion 40%, evidence/cow 100%), 30d labor lock,
  // 50% max moderation slash, and 0.001 ETH per burned Stasis.
  await cowRating.setRatingPolicy(4_000, 10_000, 10_000, 0, 1_000, 30 * 24 * 3600, 5_000);
  await generalPool.setCarePolicy(1e15);
  await academy.setGrader(deployer.address);

  const summary = {
    network: hre.network.name,
    stasis: await stasis.getAddress(),
    cowNFT: await cowNFT.getAddress(),
    cowRating: await cowRating.getAddress(),
    attestation: await attestation.getAddress(),
    generalPool: await generalPool.getAddress(),
    herdCouncil: await herdCouncil.getAddress(),
    moderation: await moderation.getAddress(),
    academy: await academy.getAddress(),
  };
  fs.writeFileSync(
    path.join(__dirname, "..", "deployed.json"),
    JSON.stringify(summary, null, 2)
  );

  console.log("Stasis      ", summary.stasis);
  console.log("CowNFT      ", summary.cowNFT);
  console.log("CowRating   ", summary.cowRating);
  console.log("Attestation ", summary.attestation);
  console.log("GeneralPool ", summary.generalPool);
  console.log("HerdCouncil ", summary.herdCouncil);
  console.log("Moderation  ", summary.moderation);
  console.log("Academy     ", summary.academy);
  console.log("Zero-start: no genesis granted — everyone (including the pilot) earns their way in.");
  console.log("Wrote deployed.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
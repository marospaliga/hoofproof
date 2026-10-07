// Deploys and wires the whole PoH system in dependency order, then prints an
// address summary. Run with:
//
//   npx hardhat run scripts/deploy.js
//   npx hardhat run scripts/deploy.js --network sepolia
//
// The deployer becomes the owner of every contract and inherits a genesis
// score (so the pilot can immediately stake/boost).
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

const GENESIS = 10_000n;

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

  // ---- wire everything (owner-only, one-time) ------------------------------
  await stasis.setModule(await cowRating.getAddress(), true);
  await stasis.setModule(await attestation.getAddress(), true);
  await cowNFT.setRatingEngine(await cowRating.getAddress());
  await cowRating.setWiring(await cowNFT.getAddress(), await attestation.getAddress());

  // ---- bootstrap the pilot operator ---------------------------------------
  await stasis.grantGenesis(deployer.address, GENESIS);

  const summary = {
    network: hre.network.name,
    stasis: await stasis.getAddress(),
    cowNFT: await cowNFT.getAddress(),
    cowRating: await cowRating.getAddress(),
    attestation: await attestation.getAddress(),
  };
  fs.writeFileSync(
    path.join(__dirname, "..", "deployed.json"),
    JSON.stringify(summary, null, 2)
  );

  console.log("Stasis      ", summary.stasis);
  console.log("CowNFT      ", summary.cowNFT);
  console.log("CowRating   ", summary.cowRating);
  console.log("Attestation ", summary.attestation);
  console.log("Deployer genesis:", GENESIS.toString());
  console.log("Wrote deployed.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
const { ethers } = require("hardhat");

const GENESIS = 10_000n;

/**
 * Deploys and wires the whole system in dependency order:
 *
 *   Stasis -> CowNFT -> CowRating -> Attestation
 *   then enrols the modules with Stasis, points CowNFT at its rating
 *   engine, gives CowRating its cow + attestation addresses, and wires the
 *   Phase B layer (GeneralPool as a Stasis module, HerdCouncil on top of the
 *   rating engine).
 */
async function deploySystem() {
  const signers = await ethers.getSigners();
  const [owner, alice, bob, carol, dave, erin, frank, buyer, stranger] = signers;

  const Stasis = await ethers.getContractFactory("Stasis");
  const stasis = await Stasis.deploy();

  const CowNFT = await ethers.getContractFactory("CowNFT");
  const cowNFT = await CowNFT.deploy();

  const CowRating = await ethers.getContractFactory("CowRating");
  const cowRating = await CowRating.deploy(await stasis.getAddress());

  const Attestation = await ethers.getContractFactory("Attestation");
  const attestation = await Attestation.deploy(
    await stasis.getAddress(),
    await cowNFT.getAddress(),
    await cowRating.getAddress()
  );

  const GeneralPool = await ethers.getContractFactory("GeneralPool");
  const generalPool = await GeneralPool.deploy(
    await stasis.getAddress(),
    await cowRating.getAddress()
  );

  const HerdCouncil = await ethers.getContractFactory("HerdCouncil");
  const herdCouncil = await HerdCouncil.deploy(
    await cowNFT.getAddress(),
    await cowRating.getAddress()
  );

  await stasis.setModule(await cowRating.getAddress(), true);
  await stasis.setModule(await attestation.getAddress(), true);
  await stasis.setModule(await generalPool.getAddress(), true);
  await cowNFT.setRatingEngine(await cowRating.getAddress());
  await cowRating.setWiring(await cowNFT.getAddress(), await attestation.getAddress());

  const raters = [alice, bob, carol, dave, erin, frank];

  return {
    stasis,
    cowNFT,
    cowRating,
    attestation,
    generalPool,
    herdCouncil,
    owner,
    raters,
    alice,
    bob,
    carol,
    dave,
    erin,
    frank,
    buyer,
    stranger,
  };
}

/** Grant the founding score to a set of accounts (owner-only, uncapped). */
async function grantGenesis(stasis, accounts, amount = GENESIS) {
  for (const account of accounts) {
    await stasis.grantGenesis(account.address ?? account, amount);
  }
}

/** Mint a cow and fund every rater, the standard starting state for a test. */
async function withFundedRaters() {
  const sys = await deploySystem();
  await grantGenesis(sys.stasis, [...sys.raters, sys.buyer]);
  const tokenId = await mint(sys.cowNFT, sys.alice, "ipfs://cow-metadata");
  return { ...sys, tokenId };
}

/** `mintCow` returns a transaction, so read the ID first via staticCall. */
async function mint(cowNFT, signer, cid) {
  const tokenId = await cowNFT.connect(signer).mintCow.staticCall(cid);
  await cowNFT.connect(signer).mintCow(cid);
  return tokenId;
}

module.exports = { deploySystem, grantGenesis, withFundedRaters, mint, GENESIS };

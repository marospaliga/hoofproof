const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySystem, grantGenesis, mint } = require("./fixtures");

const Status = { Inert: 0n, Active: 1n, SelfSustaining: 2n, Memorial: 3n };

describe("CowNFT", function () {
  async function fixture() {
    const sys = await deploySystem();
    await grantGenesis(sys.stasis, [...sys.raters, sys.buyer]);
    return sys;
  }

  it("is permissionless: anyone can mint, and it starts Inert", async function () {
    const { cowNFT, stranger } = await loadFixture(fixture);

    const tokenId = await mint(cowNFT, stranger, "ipfs://meta");

    expect(await cowNFT.ownerOf(tokenId)).to.equal(stranger.address);
    expect(await cowNFT.statusOf(tokenId)).to.equal(Status.Inert);
  });

  it("keeps descriptive data correctable rather than frozen forever", async function () {
    const { cowNFT, alice, stranger } = await loadFixture(fixture);
    const tokenId = await mint(cowNFT, alice, "ipfs://v1");

    await expect(
      cowNFT.connect(stranger).setMetadataCID(tokenId, "ipfs://spoof")
    ).to.be.revertedWithCustomError(cowNFT, "NotTokenOwner");

    await cowNFT.connect(alice).setMetadataCID(tokenId, "ipfs://v2");
    const cow = await cowNFT.cows(tokenId);
    expect(cow.metadataCID).to.equal("ipfs://v2");
  });

  it("only the rating engine can move status", async function () {
    const { cowNFT, stranger } = await loadFixture(fixture);
    const tokenId = await mint(cowNFT, stranger, "ipfs://meta");

    await expect(
      cowNFT.connect(stranger).markActive(tokenId)
    ).to.be.revertedWithCustomError(cowNFT, "OnlyRatingEngine");
    expect(await cowNFT.statusOf(tokenId)).to.equal(Status.Inert);
  });

  it("tracks herd membership", async function () {
    const { cowNFT, alice } = await loadFixture(fixture);
    const a = await mint(cowNFT, alice, "ipfs://a");
    const b = await mint(cowNFT, alice, "ipfs://b");

    await cowNFT.connect(alice).setHerd(a, 1);
    await cowNFT.connect(alice).setHerd(b, 1);

    expect(await cowNFT.herdCount(1)).to.equal(2);
    expect((await cowNFT.cows(a)).herdId).to.equal(1);
  });

  it("blocks a transfer when the buyer has no rating — money alone cannot move a cow", async function () {
    const { cowNFT, stasis, alice, stranger } = await loadFixture(fixture);
    const tokenId = await mint(cowNFT, alice, "ipfs://meta");

    await expect(
      cowNFT.connect(alice).transferFrom(alice.address, stranger.address, tokenId)
    ).to.be.revertedWithCustomError(stasis, "InsufficientFree");
  });

  it("charges the buyer in Stasis when they do have rating", async function () {
    const { cowNFT, stasis, alice, buyer } = await loadFixture(fixture);
    const tokenId = await mint(cowNFT, alice, "ipfs://meta");

    const before = await stasis.effectiveScore(buyer.address);
    await cowNFT.connect(alice).transferFrom(alice.address, buyer.address, tokenId);

    expect(await cowNFT.ownerOf(tokenId)).to.equal(buyer.address);
    // Base cost 454, halved by the buyer's 50% high-rating discount -> 227.
    expect(before - (await stasis.effectiveScore(buyer.address))).to.equal(227);
  });

  it("refuses to move a Memorial cow", async function () {
    const { cowNFT, owner, alice, buyer } = await loadFixture(fixture);
    const tokenId = await mint(cowNFT, alice, "ipfs://meta");

    // The operator records the real cow's death.
    await cowNFT.connect(owner).markMemorial(tokenId);
    expect(await cowNFT.statusOf(tokenId)).to.equal(Status.Memorial);

    await expect(
      cowNFT.connect(alice).transferFrom(alice.address, buyer.address, tokenId)
    ).to.be.revertedWithCustomError(cowNFT, "IsMemorial");
  });

  it("pins the rating engine so it cannot be swapped after launch", async function () {
    const { cowNFT, owner, stranger } = await loadFixture(fixture);

    await expect(
      cowNFT.connect(owner).setRatingEngine(stranger.address)
    ).to.be.revertedWithCustomError(cowNFT, "RatingEngineAlreadySet");
  });
});

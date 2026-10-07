const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { withFundedRaters, mint, GENESIS } = require("./fixtures");

const DAY = 86_400;
const ACTIVATION = 1_000n;
const PIGS = ethers.encodeBytes32String("pigs");

const Status = { Inert: 0n, Active: 1n, SelfSustaining: 2n, Memorial: 3n };

describe("CowRating", function () {
  async function fixture() {
    return withFundedRaters();
  }

  describe("staking and activation", function () {
    it("stops one account from activating a cow alone", async function () {
      const { cowRating, stasis, alice, tokenId } = await loadFixture(fixture);

      // Concentration cap = 20% of the activation threshold, so a single
      // account can never be the one that flips a cow to Active.
      await expect(
        cowRating.connect(alice).stakeRating(tokenId, ACTIVATION)
      ).to.be.revertedWithCustomError(cowRating, "ConcentrationCap");

      expect(await cowRating.totalStaked(tokenId)).to.equal(0);
      expect(await stasis.bonded(alice.address)).to.equal(0);
    });

    it("activates only once several distinct raters back it", async function () {
      const { cowNFT, cowRating, raters, tokenId } = await loadFixture(fixture);

      for (const rater of raters.slice(0, 4)) {
        await cowRating.connect(rater).stakeRating(tokenId, 200);
        expect(await cowNFT.statusOf(tokenId)).to.equal(Status.Inert);
      }

      await cowRating.connect(raters[4]).stakeRating(tokenId, 200);
      expect(await cowNFT.statusOf(tokenId)).to.equal(Status.Active);
      expect(await cowRating.totalStaked(tokenId)).to.equal(ACTIVATION);
    });

    it("requires free score to stake", async function () {
      const { cowRating, stranger, tokenId } = await loadFixture(fixture);
      await expect(
        cowRating.connect(stranger).stakeRating(tokenId, 100)
      ).to.be.reverted;
    });
  });

  describe("boosting", function () {
    it("weights a boost by the booster's own score", async function () {
      const { cowRating, alice, tokenId } = await loadFixture(fixture);

      await cowRating.connect(alice).boost(tokenId, PIGS, 1_000);
      // 10_000 score * 10% = 1_000 weight.
      expect(await cowRating.cowRating(tokenId)).to.equal(1_000);
    });

    it("rate-limits boosts so brigading is expensive", async function () {
      const { cowRating, alice, tokenId } = await loadFixture(fixture);
      const category = PIGS;

      await cowRating.connect(alice).boost(tokenId, category, 1_000);
      await expect(
        cowRating.connect(alice).boost(tokenId, category, 1_000)
      ).to.be.revertedWithCustomError(cowRating, "CooldownActive");

      await time.increase(DAY);
      await cowRating.connect(alice).boost(tokenId, category, 1_000);
      const total = await cowRating.cowRating(tokenId);
      // ~2x the single-boost weight; genesis decay shaves a little off.
      expect(total).to.be.greaterThan(1_900n);
      expect(total).to.be.lessThan(2_001n);
    });

    it("multiplies weight by the governance need-parameter", async function () {
      const { cowRating, owner, alice, tokenId } = await loadFixture(fixture);
      const category = PIGS;

      await cowRating.connect(owner).setParameter(category, 20_000); // 2x (BPS-scaled)
      await cowRating.connect(alice).boost(tokenId, category, 1_000);

      expect(await cowRating.cowRating(tokenId)).to.equal(2_000);
    });
  });

  describe("herds", function () {
    it("adds a bonus when cows share a herd", async function () {
      const { cowNFT, cowRating, alice, tokenId } = await loadFixture(fixture);
      const second = await mint(cowNFT, alice, "ipfs://second");

      await cowRating.connect(alice).boost(tokenId, PIGS, 1_000);
      expect(await cowRating.ratingOf(tokenId)).to.equal(1_000);

      await cowNFT.connect(alice).setHerd(tokenId, 1);
      await cowNFT.connect(alice).setHerd(second, 1);

      // Two members => +5%.
      expect(await cowRating.ratingOf(tokenId)).to.equal(1_050);
    });
  });

  describe("withdrawing rating", function () {
    it("charges a penalty for leaving before the lock period", async function () {
      const { cowRating, stasis, alice, tokenId } = await loadFixture(fixture);

      await cowRating.connect(alice).stakeRating(tokenId, 100);
      await cowRating.connect(alice).unstakeRating(tokenId, 100);

      // Left immediately: the full 50% early-exit penalty applies (a block or
      // two of elapsed time shaves a unit off, hence the tolerance).
      const spent = GENESIS - (await stasis.effectiveScore(alice.address));
      expect(spent).to.be.greaterThan(48n);
      expect(spent).to.be.lessThan(51n);
      expect(await cowRating.totalStaked(tokenId)).to.equal(0);
    });

    it("returns everything once the lock period has passed", async function () {
      const { cowRating, stasis, alice, bob, tokenId } = await loadFixture(fixture);

      await cowRating.connect(alice).stakeRating(tokenId, 100);
      await cowRating.connect(bob).stakeRating(tokenId, 100);

      await time.increase(31 * DAY);
      await cowRating.connect(alice).unstakeRating(tokenId, 100);

      // Bob never staked, but waited the same amount of time. Any difference
      // between them is exactly the early-exit penalty.
      expect(await stasis.effectiveScore(alice.address)).to.equal(
        await stasis.effectiveScore(bob.address)
      );
      expect(await stasis.bonded(alice.address)).to.equal(0);
    });
  });

  describe("transfer pricing", function () {
    it("costs more when the cow is highly rated", async function () {
      const { cowRating, alice, stranger, tokenId } = await loadFixture(fixture);

      const plain = await cowRating.transferCost(tokenId, stranger.address);
      await cowRating.connect(alice).boost(tokenId, PIGS, 1_000);
      const rated = await cowRating.transferCost(tokenId, stranger.address);

      expect(rated).to.be.greaterThan(plain);
      expect(plain).to.equal(454);
      expect(rated).to.equal(500);
    });

    it("costs less when the cow is well backed", async function () {
      const { cowRating, raters, stranger, tokenId } = await loadFixture(fixture);

      const before = await cowRating.transferCost(tokenId, stranger.address);
      for (const rater of raters.slice(0, 6)) {
        await cowRating.connect(rater).stakeRating(tokenId, 200);
      }
      const after = await cowRating.transferCost(tokenId, stranger.address);

      expect(after).to.be.lessThan(before);
      expect(after).to.equal(446);
    });

    it("gives a discount to a high-rating buyer", async function () {
      const { cowRating, alice, buyer, stranger, tokenId } = await loadFixture(fixture);

      const strangerCost = await cowRating.transferCost(tokenId, stranger.address);
      const buyerCost = await cowRating.transferCost(tokenId, buyer.address);

      expect(buyerCost).to.be.lessThan(strangerCost);
      expect(buyerCost).to.equal(227);
      expect(strangerCost).to.equal(454);
    });
  });
});

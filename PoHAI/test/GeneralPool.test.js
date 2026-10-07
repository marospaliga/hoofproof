const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { withFundedRaters } = require("./fixtures");

const DAY = 86_400;
const PIGS = ethers.encodeBytes32String("pigs");

describe("GeneralPool", function () {
  async function fixture() {
    return withFundedRaters();
  }

  describe("Rajas flow", function () {
    it("converts Sattva to Rajas and back", async function () {
      const { generalPool, stasis, alice } = await loadFixture(fixture);

      const before = await stasis.effectiveScore(alice.address);
      await generalPool.connect(alice).convertSattvaToRajas(500);
      expect(await generalPool.rajas(alice.address)).to.equal(500);
      expect(await stasis.effectiveScore(alice.address)).to.equal(before - 500n);

      // 500 is under the 10% gain cap, so the round trip is exact.
      await generalPool.connect(alice).convertRajasToSattva(500);
      expect(await generalPool.rajas(alice.address)).to.equal(0);
      expect(await stasis.effectiveScore(alice.address)).to.equal(before);
    });

    it("rejects conversions beyond the balance", async function () {
      const { generalPool, alice } = await loadFixture(fixture);
      await expect(
        generalPool.connect(alice).convertRajasToSattva(1)
      ).to.be.revertedWithCustomError(generalPool, "InsufficientRajas");
    });
  });

  describe("gas rebates", function () {
    it("pays nothing to a rater without momentum", async function () {
      const { generalPool, stranger, owner } = await loadFixture(fixture);
      await owner.sendTransaction({
        to: await generalPool.getAddress(),
        value: ethers.parseEther("1"),
      });
      await expect(
        generalPool.connect(stranger).claimGasRebate()
      ).to.be.revertedWithCustomError(generalPool, "NoMomentum");
    });

    it("pays a momentum-scaled rebate once per period", async function () {
      const { generalPool, cowRating, alice, owner, tokenId } = await loadFixture(fixture);

      // A generous base so the rebate outweighs the tx gas in this test.
      await generalPool.connect(owner).setGasRebate(ethers.parseEther("0.1"), 7 * DAY);
      await owner.sendTransaction({
        to: await generalPool.getAddress(),
        value: ethers.parseEther("1"),
      });

      // One boost earns momentum (2 activity points → 1.02x).
      await cowRating.connect(alice).boost(tokenId, PIGS, 1_000);
      expect(await cowRating.momentumBps(alice.address)).to.equal(10_020);

      const before = await ethers.provider.getBalance(alice.address);
      await generalPool.connect(alice).claimGasRebate();
      const after = await ethers.provider.getBalance(alice.address);
      expect(after - before).to.be.greaterThan(0n);

      await expect(
        generalPool.connect(alice).claimGasRebate()
      ).to.be.revertedWithCustomError(generalPool, "AlreadyClaimed");
    });
  });

  describe("care pool", function () {
    it("earmarks donated funds for a specific cow", async function () {
      const { generalPool, owner, tokenId } = await loadFixture(fixture);
      await owner.sendTransaction({
        to: await generalPool.getAddress(),
        value: ethers.parseEther("1"),
      });

      const amount = ethers.parseEther("0.5");
      await generalPool.connect(owner).allocateCare(tokenId, amount);
      expect(await generalPool.carePoolOf(tokenId)).to.equal(amount);
    });
  });

  describe("platform value index", function () {
    it("snapshots the platform's components per epoch", async function () {
      const { generalPool, stasis, cowRating, alice, tokenId } = await loadFixture(fixture);

      await cowRating.connect(alice).stakeRating(tokenId, 200);
      await cowRating.connect(alice).boost(tokenId, PIGS, 1_000);

      await generalPool.snapshotIndex();
      expect(await generalPool.epochCount()).to.equal(1);

      const epoch = await generalPool.indexHistory(0);
      expect(epoch.backing).to.equal(200);
      expect(epoch.rating).to.be.greaterThan(0);
      expect(epoch.stasis).to.equal(await stasis.totalScore());
      expect(epoch.rajas).to.equal(0);

      const [, , , , activeCows] = await generalPool.platformMetrics();
      expect(activeCows).to.equal(0); // 200 staked has not activated the cow
      expect(await generalPool.platformValue()).to.be.greaterThan(0);
    });
  });
});
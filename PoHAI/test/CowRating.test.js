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

  describe("boosting and voting power", function () {
    it("weights a boost by the booster's own score", async function () {
      const { cowRating, alice, tokenId } = await loadFixture(fixture);

      await cowRating.connect(alice).boost(tokenId, PIGS, 1_000);
      // 10_000 score * 10% = 1_000 weight (fresh account: 1x momentum).
      expect(await cowRating.cowRating(tokenId)).to.equal(1_000);
    });

    it("multiplies weight by the governance need-parameter", async function () {
      const { cowRating, owner, alice, tokenId } = await loadFixture(fixture);
      const category = PIGS;

      await cowRating.connect(owner).setParameter(category, 20_000); // 2x (BPS-scaled)
      await cowRating.connect(alice).boost(tokenId, category, 1_000);

      expect(await cowRating.cowRating(tokenId)).to.equal(2_000);
    });

    it("spends voting power and refills it over a day", async function () {
      const { cowRating, alice, tokenId } = await loadFixture(fixture);

      expect(await cowRating.votingPowerOf(alice.address)).to.equal(10_000);

      // Each boost spends 20% of voting power: five fit, the sixth does not.
      for (let i = 0; i < 5; i++) {
        await cowRating.connect(alice).boost(tokenId, PIGS, 1_000);
        expect(await cowRating.votingPowerOf(alice.address)).to.equal(
          BigInt(10_000 - (i + 1) * 2_000)
        );
      }

      await expect(
        cowRating.connect(alice).boost(tokenId, PIGS, 1_000)
      ).to.be.revertedWithCustomError(cowRating, "NoVotingPower");

      // Power recovers continuously — a day later the meter is full again.
      await time.increase(DAY);
      expect(await cowRating.votingPowerOf(alice.address)).to.equal(10_000);
      await cowRating.connect(alice).boost(tokenId, PIGS, 1_000); // no revert
    });

    it("rejects nonsense votes and weightless voters", async function () {
      const { cowRating, alice, stranger, tokenId } = await loadFixture(fixture);
      const hash = ethers.ZeroHash;

      await expect(
        cowRating.connect(stranger).vote(tokenId, 2, hash, 1_000)
      ).to.be.revertedWithCustomError(cowRating, "WeightTooLow");

      await expect(
        cowRating.connect(alice).vote(tokenId, 3, hash, 1_000)
      ).to.be.revertedWithCustomError(cowRating, "InvalidBoost");

      await expect(
        cowRating.connect(alice).vote(tokenId, 2, hash, 0)
      ).to.be.revertedWithCustomError(cowRating, "InvalidBoost");
    });
  });

  describe("content voting", function () {
    it("rates images and posts and folds them into the cow", async function () {
      const { cowRating, alice, bob, tokenId } = await loadFixture(fixture);

      const post = ethers.keccak256(ethers.toUtf8Bytes("post-a"));
      await cowRating.connect(alice).vote(tokenId, 2, post, 1_000);
      expect(await cowRating.contentRatingOf(tokenId, 2, post)).to.equal(1_000);

      const image = ethers.keccak256(ethers.toUtf8Bytes("img-a"));
      await cowRating.connect(bob).vote(tokenId, 1, image, 500);
      expect(await cowRating.contentRatingOf(tokenId, 1, image)).to.equal(500);

      // Content votes also prove the cow's authenticity.
      expect(await cowRating.cowRating(tokenId)).to.equal(1_500);
      expect(await cowRating.ratingOf(tokenId)).to.equal(1_500);
    });
  });

  describe("ethical momentum", function () {
    it("accumulates with activity and decays to 1x", async function () {
      const { cowRating, alice, tokenId } = await loadFixture(fixture);

      expect(await cowRating.momentumBps(alice.address)).to.equal(10_000);

      // Each boost adds 2 activity points; bonus = points/500 of the headroom.
      for (let i = 0; i < 5; i++) {
        await cowRating.connect(alice).boost(tokenId, PIGS, 1_000);
      }
      expect(await cowRating.momentumBps(alice.address)).to.equal(10_100);

      // Half the decay window passes: half the accumulated points remain.
      await time.increase(45 * DAY);
      expect(await cowRating.momentumBps(alice.address)).to.equal(10_050);

      // Past the full window: back to a flat 1x.
      await time.increase(46 * DAY);
      expect(await cowRating.momentumBps(alice.address)).to.equal(10_000);
    });

    it("counts momentum-weighted stakes toward activation", async function () {
      const { cowNFT, cowRating, raters, alice, tokenId } = await loadFixture(fixture);

      // Alice builds momentum, so her stake pushes the cow further.
      for (let i = 0; i < 5; i++) {
        await cowRating.connect(alice).boost(tokenId, PIGS, 1_000);
      }
      await cowRating.connect(alice).stakeRating(tokenId, 200);
      expect(await cowRating.totalWeightedStaked(tokenId)).to.equal(202);

      // Two-hundred-weight stakes from fresh raters stay flat 1x.
      // (raters[0] is alice, who already staked.)
      for (const rater of raters.slice(1, 4)) {
        await cowRating.connect(rater).stakeRating(tokenId, 200);
      }
      // 202 + 600 = 802 weighted → still Inert despite 800 raw.
      expect(await cowNFT.statusOf(tokenId)).to.equal(Status.Inert);

      await cowRating.connect(raters[4]).stakeRating(tokenId, 200);
      // 1002 weighted crosses the 1000 threshold with only 1000 raw.
      expect(await cowNFT.statusOf(tokenId)).to.equal(Status.Active);
      expect(await cowRating.totalStaked(tokenId)).to.equal(1_000);
    });
  });

  describe("sweat equity", function () {
    const LABOR = 6;

    async function attestLabor(attestation, supporters, tokenId, hours, worker) {
      const args = [tokenId, LABOR, "ipfs://labor", hours, worker, 100n];
      for (const signer of supporters) {
        await attestation.connect(signer).attest(...args);
      }
    }

    it("only lets the attestation module reward labor", async function () {
      const { cowRating, alice, tokenId } = await loadFixture(fixture);
      await expect(
        cowRating.connect(alice).rewardLabor(tokenId, alice.address, 10)
      ).to.be.revertedWithCustomError(cowRating, "OnlyAttestation");
    });

    it("pays the same hours more on a well-rated project", async function () {
      const { cowRating, attestation, stasis, alice, bob, carol, tokenId } = await loadFixture(fixture);

      // Cow unboosted: the floor factor (0.2x) applies → 100h × 1 × 0.2 = 20.
      const before = await stasis.effectiveScore(alice.address);
      await attestLabor(attestation, [bob, carol], tokenId, 100n, alice.address);
      expect(await stasis.effectiveScore(alice.address)).to.equal(before + 20n);

      // Rate the cow to the reference → factor 1.0x → the same 100h = 100.
      await cowRating.connect(bob).boost(tokenId, PIGS, 1_000);
      const beforeRated = await stasis.effectiveScore(alice.address);
      await attestLabor(attestation, [bob, carol], tokenId, 100n, alice.address);
      expect(await stasis.effectiveScore(alice.address)).to.equal(beforeRated + 100n);
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

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { withFundedRaters, mint, GENESIS } = require("./fixtures");

const DAY = 86_400;
const PIGS = ethers.encodeBytes32String("pigs");

describe("CowRating", function () {
  async function fixture() {
    return withFundedRaters();
  }

  describe("staking and backing", function () {
    it("lets one account back a cow with all its free rating", async function () {
      const { cowRating, stasis, alice, tokenId } = await loadFixture(fixture);

      // There is no concentration cap: if the community wants one account to
      // back a cow, that is its choice. Bonding still prevents spending rating
      // the account does not have.
      await cowRating.connect(alice).stakeRating(tokenId, 5_000);

      expect(await cowRating.totalStaked(tokenId)).to.equal(5_000);
      expect(await stasis.bonded(alice.address)).to.equal(5_000);
    });

    it("counts a cow as backed on the first stake or vote, once", async function () {
      const { cowRating, raters, alice, tokenId } = await loadFixture(fixture);

      expect(await cowRating.backedCowCount()).to.equal(0);
      await cowRating.connect(alice).stakeRating(tokenId, 200);
      expect(await cowRating.backedCowCount()).to.equal(1);
      expect(await cowRating.cowBacked(tokenId)).to.equal(true);

      for (const rater of raters.slice(1, 4)) {
        await cowRating.connect(rater).stakeRating(tokenId, 200);
      }
      // More backing on the same cow does not inflate the count.
      expect(await cowRating.backedCowCount()).to.equal(1);
    });

    it("requires free score to stake", async function () {
      const { cowRating, stranger, tokenId } = await loadFixture(fixture);
      await expect(
        cowRating.connect(stranger).stakeRating(tokenId, 100)
      ).to.be.reverted;
    });
  });

  describe("boosting", function () {
    it("adds the amount given straight to the cow's rating", async function () {
      const { cowRating, alice, tokenId } = await loadFixture(fixture);

      await cowRating.connect(alice).boost(tokenId, PIGS, 1_000);
      // The amount *is* the rating: 1_000 spent → 1_000 gained.
      expect(await cowRating.cowRating(tokenId)).to.equal(1_000);
    });

    it("multiplies the amount by the governance need-parameter", async function () {
      const { cowRating, owner, alice, tokenId } = await loadFixture(fixture);
      const category = PIGS;

      await cowRating.connect(owner).setParameter(category, 20_000); // 2x (BPS-scaled)
      await cowRating.connect(alice).boost(tokenId, category, 1_000);

      expect(await cowRating.cowRating(tokenId)).to.equal(2_000);
    });

    it("spends rating directly: the amount is the weight", async function () {
      const { cowRating, alice, tokenId } = await loadFixture(fixture);

      expect(await cowRating.voiceLocked(alice.address)).to.equal(0);

      // One voice, one amount. Committing 250 puts exactly 250 on the cow and
      // locks exactly 250 of the voter's rating — there is no ladder.
      await cowRating.connect(alice).boost(tokenId, PIGS, 250);
      expect(await cowRating.cowRating(tokenId)).to.equal(250);
      expect(await cowRating.voiceLocked(alice.address)).to.equal(250);

      // Voting more means spending more: the second vote adds its own amount.
      await cowRating.connect(alice).boost(tokenId, PIGS, 100);
      expect(await cowRating.cowRating(tokenId)).to.equal(350);
      expect(await cowRating.voiceLocked(alice.address)).to.equal(350);

      // The voice budget *is* the account's rating (kept for the ABI).
      expect(await cowRating.voterLocks(alice.address)).to.have.length(4);
    });

    it("rejects nonsense votes and weightless voters", async function () {
      const { cowRating, stasis, alice, stranger, tokenId } = await loadFixture(fixture);
      const hash = ethers.ZeroHash;

      await expect(
        cowRating.connect(stranger).vote(tokenId, 2, hash, 1_000)
      ).to.be.revertedWithCustomError(stasis, "InsufficientFree");

      await expect(
        cowRating.connect(alice).vote(tokenId, 3, hash, 1_000)
      ).to.be.revertedWithCustomError(cowRating, "InvalidBoost");

      await expect(
        cowRating.connect(alice).vote(tokenId, 2, hash, 0)
      ).to.be.revertedWithCustomError(cowRating, "WeightTooLow");
    });
  });

  describe("content voting", function () {
    it("rates images and posts and folds them into the cow", async function () {
      const { cowRating, alice, bob, tokenId } = await loadFixture(fixture);

      const post = ethers.keccak256(ethers.toUtf8Bytes("post-a"));
      await cowRating.connect(alice).vote(tokenId, 2, post, 1_000);
      // No kind weighting any more: a voice is rating, whatever it targets.
      expect(await cowRating.contentRatingOf(tokenId, 2, post)).to.equal(1_000);

      const image = ethers.keccak256(ethers.toUtf8Bytes("img-a"));
      await cowRating.connect(bob).vote(tokenId, 1, image, 500);
      expect(await cowRating.contentRatingOf(tokenId, 1, image)).to.equal(500);

      // Content votes also prove the cow's authenticity.
      expect(await cowRating.cowRating(tokenId)).to.equal(1_500);
      expect(await cowRating.ratingOf(tokenId)).to.equal(1_500);
    });
  });

  describe("activity ledger", function () {
    it("accumulates with activity and decays to zero", async function () {
      const { cowRating, alice, tokenId } = await loadFixture(fixture);

      expect(await cowRating.activityPoints(alice.address)).to.equal(0);

      // Each boost adds 2 activity points.
      for (let i = 0; i < 5; i++) {
        await cowRating.connect(alice).boost(tokenId, PIGS, 100);
      }
      expect(await cowRating.activityPoints(alice.address)).to.equal(10);

      // Half the decay window passes: half the accumulated points remain.
      await time.increase(45 * DAY);
      expect(await cowRating.activityPoints(alice.address)).to.equal(5);

      // Past the full window the ledger reads zero.
      await time.increase(46 * DAY);
      expect(await cowRating.activityPoints(alice.address)).to.equal(0);
    });

    it("accrues conviction weight without gating anything", async function () {
      const { cowRating, alice, tokenId } = await loadFixture(fixture);

      // A flexible stake counts at 1.00x and is visible in the conviction
      // ledger, but there is no threshold to cross and no rank to reach.
      await cowRating.connect(alice).stakeRating(tokenId, 200);
      expect(await cowRating.totalWeightedStaked(tokenId)).to.equal(200);

      await cowRating.connect(alice).stakeRating(tokenId, 800);
      expect(await cowRating.totalWeightedStaked(tokenId)).to.equal(1_000);
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

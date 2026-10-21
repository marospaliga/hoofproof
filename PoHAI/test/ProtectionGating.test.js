const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { withFundedRaters } = require("./fixtures");

const DAY = 86_400;
const ZERO = ethers.ZeroAddress;

const VOTE_5 = "vote(uint256,uint8,bytes32,uint256,address)";

async function activate(cowRating, raters, tokenId) {
  for (const rater of raters.slice(0, 5)) {
    await cowRating.connect(rater).stakeRating(tokenId, 200);
  }
}

async function careQuorum(attestation, a, b, tokenId) {
  const args = [tokenId, 1, "ipfs://care", 0, ZERO, 100n];
  const id = await attestation.connect(a).attest.staticCall(...args);
  await attestation.connect(a).attest(...args);
  await attestation.connect(b).attest(...args);
  return id;
}

function hash(s) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

describe("Protection-gated rating (P1)", function () {
  async function fixture() {
    return withFundedRaters();
  }

  describe("content registry", function () {
    it("records the author and blocks hostile re-registration", async function () {
      const { cowRating, alice, bob, tokenId } = await loadFixture(fixture);
      const post = hash("thread-1");

      await cowRating.connect(alice).registerContent(tokenId, 2, post, true);
      expect(await cowRating.contentAuthor(await cowRating.contentKeyOf(tokenId, 2, post))).to.equal(alice.address);

      await expect(
        cowRating.connect(bob).registerContent(tokenId, 2, post, false)
      ).to.be.revertedWithCustomError(cowRating, "AlreadyRegistered");
    });

    it("rejects attributed votes that name the wrong author", async function () {
      const { cowRating, alice, bob, tokenId } = await loadFixture(fixture);
      const post = hash("thread-2");
      await cowRating.connect(alice).registerContent(tokenId, 2, post, false);

      await expect(
        cowRating.connect(bob)[VOTE_5](tokenId, 2, post, 1_000, bob.address)
      ).to.be.revertedWithCustomError(cowRating, "AuthorMismatch");

      // Correct attribution works and locks voice.
      await cowRating.connect(bob)[VOTE_5](tokenId, 2, post, 1_000, alice.address);
      expect(await cowRating.contentRatingOf(tokenId, 2, post)).to.be.greaterThan(0);
    });

    it("auto-claims authorship on first legacy vote", async function () {
      const { cowRating, alice, tokenId } = await loadFixture(fixture);
      const post = hash("thread-3");
      await cowRating.connect(alice).vote(tokenId, 2, post, 1_000);
      const key = await cowRating.contentKeyOf(tokenId, 2, post);
      expect(await cowRating.contentAuthor(key)).to.equal(alice.address);
    });
  });

  describe("rating is the budget", function () {
    it("lets a rater commit rating down to their free balance, then stops", async function () {
      const { cowRating, stasis, alice, tokenId } = await loadFixture(fixture);

      // Alice holds 10_000 Stasis. Committing voices it one-for-one.
      expect(await stasis.freeScore(alice.address)).to.equal(10_000);

      const a = hash("post-a");
      const b = hash("post-b");
      await cowRating.connect(alice).vote(tokenId, 1, a, 4_000);
      await cowRating.connect(alice).vote(tokenId, 1, b, 4_000);
      expect(await cowRating.voiceLocked(alice.address)).to.equal(8_000);
      expect(await stasis.freeScore(alice.address)).to.equal(2_000);

      // Two thousand left: 2_001 is refused, and nothing was diluted.
      await expect(
        cowRating.connect(alice).vote(tokenId, 1, hash("post-c"), 2_001)
      ).to.be.revertedWithCustomError(stasis, "InsufficientFree");
      expect(await cowRating.contentRatingOf(tokenId, 1, a)).to.equal(4_000);
      expect(await cowRating.contentRatingOf(tokenId, 1, b)).to.equal(4_000);

      // ...but exactly 2_000 fits.
      await cowRating.connect(alice).vote(tokenId, 1, hash("post-c"), 2_000);
      expect(await stasis.freeScore(alice.address)).to.equal(0);
    });

    it("frees rating immediately on unvote", async function () {
      const { cowRating, stasis, alice, tokenId } = await loadFixture(fixture);
      const a = hash("post-unvote");
      await cowRating.connect(alice).vote(tokenId, 2, a, 1_000);
      const locked = await cowRating.voiceLocked(alice.address);
      expect(locked).to.equal(1_000);

      const key = await cowRating.contentKeyOf(tokenId, 2, a);
      await cowRating.connect(alice).unvote(key);
      expect(await cowRating.voiceLocked(alice.address)).to.equal(0);
      expect(await cowRating.contentRatingOf(tokenId, 2, a)).to.equal(0);
      expect(await stasis.freeScore(alice.address)).to.equal(10_000);
    });
  });

  describe("dormancy", function () {
    it("freezes votes on stale content but allows reaping", async function () {
      const { cowRating, owner, alice, bob, tokenId } = await loadFixture(fixture);
      await cowRating.connect(owner).setContentDormantWindow(DAY);

      const post = hash("stale-post");
      await cowRating.connect(alice).registerContent(tokenId, 2, post, false);
      await cowRating.connect(alice).vote(tokenId, 2, post, 100);
      const key = await cowRating.contentKeyOf(tokenId, 2, post);
      expect(await cowRating.voiceLocked(alice.address)).to.be.greaterThan(0);

      await time.increase(2 * DAY);
      await expect(
        cowRating.connect(bob).vote(tokenId, 2, post, 100)
      ).to.be.revertedWithCustomError(cowRating, "DormantContent");

      await cowRating.reapStale(alice.address, [key]);
      expect(await cowRating.voiceLocked(alice.address)).to.equal(0);
    });
  });

  describe("dynamic author awards", function () {
    it("damps whale votes more than minnow votes", async function () {
      const { cowRating, alice, tokenId } = await loadFixture(fixture);
      // Seed some field total first.
      await cowRating.connect(alice).boost(tokenId, ethers.encodeBytes32String("g"), 1_000);

      const small = await cowRating.authorAwardPreview(100);
      const whale = await cowRating.authorAwardPreview(10_000);
      // Under the 10% headline rate, and relatively more damped for whales.
      expect(small).to.be.lessThan(10n);
      expect(whale * 100n).to.be.lessThan(small * 10000n);
    });

    it("mints to the author only on anchored, protection-linked content", async function () {
      const { cowRating, attestation, stasis, raters, alice, bob, tokenId } = await loadFixture(fixture);

      const post = hash("care-report");
      await cowRating.connect(bob).registerContent(tokenId, 1, post, true);

      // No anchor yet: vote counts, nobody is paid.
      const bobBefore = await stasis.effectiveScore(bob.address);
      await cowRating.connect(alice)[VOTE_5](tokenId, 1, post, 1_000, bob.address);
      expect(await cowRating.contentRatingOf(tokenId, 1, post)).to.be.greaterThan(0);
      expect(await stasis.effectiveScore(bob.address)).to.equal(bobBefore);

      // Anchor the cow, then curate again: the author earns.
      await activate(cowRating, raters, tokenId);
      await careQuorum(attestation, raters[0], raters[1], tokenId);
      expect(await cowRating.protectionAnchorLive(tokenId)).to.equal(true);

      const post2 = hash("care-report-2");
      await cowRating.connect(bob).registerContent(tokenId, 1, post2, true);
      const before2 = await stasis.effectiveScore(bob.address);
      await cowRating.connect(alice)[VOTE_5](tokenId, 1, post2, 500, bob.address);
      expect(await stasis.effectiveScore(bob.address)).to.be.greaterThan(before2);
    });

    it("lets authors vote their own content (logged self-support)", async function () {
      const { cowRating, alice, tokenId } = await loadFixture(fixture);
      const post = hash("my-own-post");
      await cowRating.connect(alice).registerContent(tokenId, 2, post, false);
      await expect(cowRating.connect(alice)[VOTE_5](tokenId, 2, post, 500, alice.address))
        .to.emit(cowRating, "ContentRewarded");
      expect(await cowRating.contentRatingOf(tokenId, 2, post)).to.be.greaterThan(0);
    });
  });

  describe("conviction staking", function () {
    it("ramps tier-2 weight toward 1.5x over 180 days", async function () {
      const { cowRating, alice, tokenId } = await loadFixture(fixture);
      await cowRating.connect(alice).stakeRatingTiered(tokenId, 200, 2);
      expect(await cowRating.totalWeightedStaked(tokenId)).to.equal(200);

      await time.increase(90 * DAY);
      await cowRating.pokeStake(tokenId, alice.address);
      // 1.0 + 0.5 x 90/180 = 1.25x.
      expect(await cowRating.totalWeightedStaked(tokenId)).to.equal(250);

      await time.increase(90 * DAY);
      await cowRating.pokeStake(tokenId, alice.address);
      expect(await cowRating.totalWeightedStaked(tokenId)).to.equal(300);
    });

    it("rejects tier changes on top-up and exits tier-2 harsher", async function () {
      const { cowRating, stasis, alice, tokenId } = await loadFixture(fixture);
      const GENESIS = 10_000n;

      await cowRating.connect(alice).stakeRating(tokenId, 100);
      await expect(
        cowRating.connect(alice).stakeRatingTiered(tokenId, 100, 1)
      ).to.be.revertedWithCustomError(cowRating, "TierMismatch");
      await cowRating.connect(alice).unstakeRating(tokenId, 100);
      const spentFlex = GENESIS - (await stasis.effectiveScore(alice.address));

      // Tier-2 exits hurt 1.5x the base curve (~75 vs ~50 on 100).
      const sys2 = await withFundedRaters();
      await sys2.cowRating.connect(sys2.alice).stakeRatingTiered(sys2.tokenId, 100, 2);
      await sys2.cowRating.connect(sys2.alice).unstakeRating(sys2.tokenId, 100);
      const spentT2 = GENESIS - (await sys2.stasis.effectiveScore(sys2.alice.address));
      expect(spentT2).to.be.greaterThan(spentFlex);
      expect(spentT2).to.be.lessThan(80n);
    });
  });

  describe("protection anchor", function () {
    it("is dead on fresh cows and live after activation plus care quorum", async function () {
      const { cowRating, attestation, raters, tokenId } = await loadFixture(fixture);
      expect(await cowRating.protectionAnchorLive(tokenId)).to.equal(false);
      await activate(cowRating, raters, tokenId);
      expect(await cowRating.protectionAnchorLive(tokenId)).to.equal(false);
      await careQuorum(attestation, raters[0], raters[1], tokenId);
      expect(await cowRating.protectionAnchorLive(tokenId)).to.equal(true);
    });
  });

  describe("oracle credibility", function () {
    // Bob documents protection work; Alice primes the field total with a boost
    // (first-ever votes mint nothing) and then curates Bob's doc with attribution.
    async function earnCred(ctx, author, curator) {
      const { cowRating, attestation, raters, tokenId } = ctx;
      await activate(cowRating, raters, tokenId);
      await careQuorum(attestation, raters[0], raters[1], tokenId);
      await cowRating.connect(curator).boost(tokenId, ethers.encodeBytes32String("g"), 1_000);
      const doc = hash("cred-doc");
      await cowRating.connect(author).registerContent(tokenId, 1, doc, true);
      await cowRating.connect(curator)[VOTE_5](tokenId, 1, doc, 1_000, author.address);
      return doc;
    }

    it("grants newcomers zero head start", async function () {
      const { cowRating, alice, tokenId } = await loadFixture(fixture);
      const doc = hash("newbie-doc");
      await cowRating.connect(alice).registerContent(tokenId, 1, doc, true);
      const key = await cowRating.contentKeyOf(tokenId, 1, doc);
      expect(await cowRating.oracleCred(alice.address)).to.equal(0);
      expect(await cowRating.contentProvisional(key)).to.equal(0);
      expect(await cowRating.contentRatingOf(tokenId, 1, doc)).to.equal(0);
    });

    it("grants proven documenters a capped head start", async function () {
      const ctx = await loadFixture(fixture);
      const { cowRating, alice, bob, tokenId } = ctx;
      await earnCred(ctx, bob, alice);
      expect(await cowRating.oracleCred(bob.address)).to.be.greaterThan(0);

      const doc2 = hash("cred-doc-2");
      const before = await cowRating.cowRating(tokenId);
      await cowRating.connect(bob).registerContent(tokenId, 1, doc2, true);
      const key2 = await cowRating.contentKeyOf(tokenId, 1, doc2);
      const provisional = await cowRating.contentProvisional(key2);
      expect(provisional).to.be.greaterThan(0);
      expect(provisional).to.be.lte(await cowRating.maxHeadStart());
      expect(await cowRating.contentRatingOf(tokenId, 1, doc2)).to.equal(provisional);
      expect(await cowRating.cowRating(tokenId)).to.equal(before + provisional);
    });

    it("locks head starts in on independent corroboration", async function () {
      const ctx = await loadFixture(fixture);
      const { cowRating, alice, bob, carol, tokenId } = ctx;
      await earnCred(ctx, bob, alice);

      const doc2 = hash("cred-doc-3");
      await cowRating.connect(bob).registerContent(tokenId, 1, doc2, true);
      const key2 = await cowRating.contentKeyOf(tokenId, 1, doc2);
      expect(await cowRating.contentProvisional(key2)).to.be.greaterThan(0);

      await cowRating.connect(carol)[VOTE_5](tokenId, 1, doc2, 500, bob.address);
      expect(await cowRating.contentProvisional(key2)).to.equal(0);
      await expect(cowRating.reapProvisional(key2)).to.be.revertedWithCustomError(
        cowRating,
        "NothingProvisional"
      );
    });

    it("reaps lonely head starts past the window", async function () {
      const ctx = await loadFixture(fixture);
      const { cowRating, alice, bob, tokenId } = ctx;
      await earnCred(ctx, bob, alice);

      const doc2 = hash("cred-doc-4");
      await cowRating.connect(bob).registerContent(tokenId, 1, doc2, true);
      const key2 = await cowRating.contentKeyOf(tokenId, 1, doc2);
      const provisional = await cowRating.contentProvisional(key2);
      expect(provisional).to.be.greaterThan(0);

      await expect(cowRating.reapProvisional(key2)).to.be.revertedWithCustomError(
        cowRating,
        "ProvisionalLocked"
      );
      await time.increase(31 * DAY);
      const cowBefore = await cowRating.cowRating(tokenId);
      await cowRating.reapProvisional(key2);
      expect(await cowRating.contentProvisional(key2)).to.equal(0);
      expect(await cowRating.contentRatingOf(tokenId, 1, doc2)).to.equal(0);
      expect(await cowRating.cowRating(tokenId)).to.equal(cowBefore - provisional);
    });
  });
});

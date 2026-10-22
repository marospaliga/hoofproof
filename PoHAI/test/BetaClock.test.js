// The beta clock.
//
// A beta tester should be able to walk the whole lifecycle — conviction
// locks, funding-need periods, dormancy, corroboration — in an afternoon
// instead of a season. The way we get there is deliberately boring: the
// contracts keep enforcing exactly the same rules, they just compare them
// against a shorter ruler.
//
// These tests pin down two things:
//   1. the beta ruler is exactly the production ruler divided by 30
//      (one beta day = one production month), and
//   2. a deadline that has been shortened actually fires on the short
//      clock — the behaviour is real, not cosmetic.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { withFundedRaters, deploySystem } = require("./fixtures");
const { PROFILES } = require("../scripts/timings");

const DAY = 86_400;
const ZERO = ethers.ZeroAddress;

const BETA = PROFILES.beta;
const PROD = PROFILES.production;

const Kind = { FundingNeed: 5 };
const Status = { Inert: 0n, Active: 1n, SelfSustaining: 2n, Memorial: 3n };

// Field order must match `CowRating.Timings` exactly.
function ratingStruct(p) {
  return [
    p.cowRating.lockPeriod,
    p.cowRating.needPeriod,
    p.cowRating.careWindow,
    p.cowRating.laborWindow,
    p.cowRating.needWindow,
    p.cowRating.headStartWindow,
    p.cowRating.laborLockPeriod,
    p.cowRating.tierCommit1,
    p.cowRating.tierCommit2,
    p.cowRating.momentumDecay,
    p.cowRating.contentDormantWindow,
    p.cowRating.zeroStreakRequired,
  ];
}

/// Move every window on every contract to the given profile. The setters that
/// take more than a duration (cycle weights, rebate base, moderation
/// dominance) get their own current values back, so only the clock moves.
async function setClock(sys, profile) {
  await sys.cowRating.setTimings(ratingStruct(profile));
  await sys.stasis.setDecayWindows(
    profile.stasis.genesisLife,
    profile.stasis.idleGrace,
    profile.stasis.idleDecayWindow
  );
  await sys.generalPool.setCycle(
    profile.generalPool.cyclePeriod,
    await sys.generalPool.backerShareBps(),
    await sys.generalPool.creditRatioBps(),
    await sys.generalPool.maxCycleCredit()
  );
  await sys.generalPool.setGasRebate(
    await sys.generalPool.gasRebateBase(),
    profile.generalPool.gasRebatePeriod
  );
  await sys.moderation.setPolicy(
    await sys.moderation.dominanceBps(),
    profile.moderation.fastPathDelay,
    profile.moderation.challengeWindow,
    await sys.moderation.minDistinctVoters()
  );
  await sys.herdCouncil.setDurationLimits(
    profile.herdCouncil.minDuration,
    profile.herdCouncil.maxDuration
  );
}

async function post(attestation, signer, tokenId, kind, value, subject, bond = 100) {
  const args = [tokenId, kind, "ipfs://evidence", value, subject, bond];
  const id = await attestation.connect(signer).attest.staticCall(...args);
  await attestation.connect(signer).attest(...args);
  return id;
}

async function activate(cowRating, raters, tokenId) {
  for (const rater of raters.slice(0, 5)) {
    await cowRating.connect(rater).stakeRating(tokenId, 200);
  }
}

describe("the beta clock", function () {
  async function fixture() {
    return withFundedRaters();
  }

  describe("the ruler", function () {
    it("shortens every production window by exactly 30x", function () {
      // One beta day is one production month. No window is exempt, so the
      // shape of the lifecycle is identical — only its length changes.
      const pairs = [
        [PROD.cowRating.lockPeriod, BETA.cowRating.lockPeriod],
        [PROD.cowRating.needPeriod, BETA.cowRating.needPeriod],
        [PROD.cowRating.careWindow, BETA.cowRating.careWindow],
        [PROD.cowRating.laborWindow, BETA.cowRating.laborWindow],
        [PROD.cowRating.needWindow, BETA.cowRating.needWindow],
        [PROD.cowRating.headStartWindow, BETA.cowRating.headStartWindow],
        [PROD.cowRating.laborLockPeriod, BETA.cowRating.laborLockPeriod],
        [PROD.cowRating.tierCommit1, BETA.cowRating.tierCommit1],
        [PROD.cowRating.tierCommit2, BETA.cowRating.tierCommit2],
        [PROD.cowRating.momentumDecay, BETA.cowRating.momentumDecay],
        [PROD.cowRating.contentDormantWindow, BETA.cowRating.contentDormantWindow],
        [PROD.stasis.genesisLife, BETA.stasis.genesisLife],
        [PROD.stasis.idleGrace, BETA.stasis.idleGrace],
        [PROD.stasis.idleDecayWindow, BETA.stasis.idleDecayWindow],
        [PROD.generalPool.cyclePeriod, BETA.generalPool.cyclePeriod],
        [PROD.generalPool.gasRebatePeriod, BETA.generalPool.gasRebatePeriod],
        [PROD.moderation.fastPathDelay, BETA.moderation.fastPathDelay],
        [PROD.moderation.challengeWindow, BETA.moderation.challengeWindow],
        [PROD.herdCouncil.minDuration, BETA.herdCouncil.minDuration],
        [PROD.herdCouncil.maxDuration, BETA.herdCouncil.maxDuration],
      ];
      for (const [prod, beta] of pairs) {
        expect(beta).to.equal(prod / 30);
      }
    });

    it("leaves counts alone — a period count is not a duration", function () {
      expect(BETA.cowRating.zeroStreakRequired).to.equal(PROD.cowRating.zeroStreakRequired);
    });

    it("reads back exactly what it was given", async function () {
      const sys = await loadFixture(fixture);
      await setClock(sys, BETA);

      expect(await sys.cowRating.lockPeriod()).to.equal(BETA.cowRating.lockPeriod);
      expect(await sys.cowRating.needPeriod()).to.equal(BETA.cowRating.needPeriod);
      expect(await sys.cowRating.careWindow()).to.equal(BETA.cowRating.careWindow);
      expect(await sys.cowRating.contentDormantWindow()).to.equal(BETA.cowRating.contentDormantWindow);
      expect(await sys.cowRating.zeroStreakRequired()).to.equal(BETA.cowRating.zeroStreakRequired);
      expect(await sys.stasis.idleGrace()).to.equal(BETA.stasis.idleGrace);
      expect(await sys.generalPool.cyclePeriod()).to.equal(BETA.generalPool.cyclePeriod);
      expect(await sys.generalPool.gasRebatePeriod()).to.equal(BETA.generalPool.gasRebatePeriod);
      expect(await sys.moderation.challengeWindow()).to.equal(BETA.moderation.challengeWindow);
      expect(await sys.herdCouncil.maxDuration()).to.equal(BETA.herdCouncil.maxDuration);
    });

    it("puts the production ruler back", async function () {
      const sys = await loadFixture(fixture);
      await setClock(sys, BETA);
      await setClock(sys, PROD);

      expect(await sys.cowRating.lockPeriod()).to.equal(PROD.cowRating.lockPeriod);
      expect(await sys.cowRating.needPeriod()).to.equal(PROD.cowRating.needPeriod);
      expect(await sys.stasis.idleGrace()).to.equal(PROD.stasis.idleGrace);
      expect(await sys.moderation.fastPathDelay()).to.equal(PROD.moderation.fastPathDelay);
    });

    it("refuses a window of zero", async function () {
      const sys = await loadFixture(fixture);
      const broken = ratingStruct(BETA);
      broken[0] = 0; // lockPeriod
      await expect(sys.cowRating.setTimings(broken)).to.be.revertedWithCustomError(
        sys.cowRating,
        "ZeroAmount"
      );
      await expect(
        sys.stasis.setDecayWindows(PROD.stasis.genesisLife, 0, PROD.stasis.idleDecayWindow)
      ).to.be.revertedWithCustomError(sys.stasis, "ZeroAmount");
    });

    it("lets only the owner move the clock", async function () {
      const sys = await loadFixture(fixture);
      await expect(sys.cowRating.connect(sys.alice).setTimings(ratingStruct(BETA)))
        .to.be.revertedWithCustomError(sys.cowRating, "OwnableUnauthorizedAccount");
      await expect(
        sys.stasis.connect(sys.alice).setDecayWindows(1, 1, 1)
      ).to.be.revertedWithCustomError(sys.stasis, "OwnableUnauthorizedAccount");
    });
  });

  describe("the shortened deadlines actually fire", function () {
    it("releases a stake after a day instead of a month", async function () {
      const sys = await loadFixture(fixture);
      const { cowRating, stasis, alice, bob, tokenId } = sys;
      await setClock(sys, BETA);

      await cowRating.connect(alice).stakeRating(tokenId, 100);
      await cowRating.connect(bob).stakeRating(tokenId, 100);

      // On the production clock this would still be locked for another 29
      // days and leaving now would burn half the rating.
      await time.increase(BETA.cowRating.lockPeriod + 60);
      await cowRating.connect(alice).unstakeRating(tokenId, 100);

      // Alice gave back exactly what she put in — no early-exit penalty.
      expect(await stasis.effectiveScore(alice.address)).to.equal(
        await stasis.effectiveScore(bob.address)
      );
      expect(await stasis.bonded(alice.address)).to.equal(0);
    });

    it("still burns rating for leaving early on the short clock", async function () {
      const sys = await loadFixture(fixture);
      const { cowRating, stasis, alice, tokenId } = sys;
      await setClock(sys, BETA);

      await cowRating.connect(alice).stakeRating(tokenId, 100);
      await cowRating.connect(alice).unstakeRating(tokenId, 100);

      // Same rule as production: the penalty scales with the time remaining,
      // and the whole window is only a day long now.
      const spent = 10_000n - (await stasis.effectiveScore(alice.address));
      expect(spent).to.be.greaterThan(45n);
      expect(spent).to.be.lessThan(51n);
    });

    it("lets the funding need be re-recorded after a day", async function () {
      const sys = await loadFixture(fixture);
      const { attestation, cowRating, raters, alice, tokenId } = sys;
      await setClock(sys, BETA);
      await activate(cowRating, raters, tokenId);

      await post(attestation, raters[0], tokenId, Kind.FundingNeed, 500, alice.address);
      await post(attestation, raters[1], tokenId, Kind.FundingNeed, 500, alice.address);
      expect((await cowRating.funding(tokenId)).need).to.equal(500);

      // Still inside the period: a second claim is opened, but the moment it
      // reaches quorum and tries to record, the contract refuses.
      await post(attestation, raters[0], tokenId, Kind.FundingNeed, 0, alice.address);
      await expect(
        post(attestation, raters[1], tokenId, Kind.FundingNeed, 0, alice.address)
      ).to.be.revertedWithCustomError(cowRating, "PeriodNotElapsed");

      // One day later the need can be re-recorded. The refused claim is still
      // open (the execution reverted, so it never left quorum), so the
      // corroboration comes from two fresh raters.
      await time.increase(BETA.cowRating.needPeriod + 60);
      await post(attestation, raters[2], tokenId, Kind.FundingNeed, 0, alice.address);
      await post(attestation, raters[3], tokenId, Kind.FundingNeed, 0, alice.address);
      expect((await cowRating.funding(tokenId)).need).to.equal(0);
    });

    it("reaches SelfSustaining in three days instead of three months", async function () {
      const sys = await loadFixture(fixture);
      const { attestation, cowNFT, cowRating, raters, alice, tokenId } = sys;
      await setClock(sys, BETA);
      await activate(cowRating, raters, tokenId);

      await post(attestation, raters[0], tokenId, Kind.FundingNeed, 500, alice.address);
      await post(attestation, raters[1], tokenId, Kind.FundingNeed, 500, alice.address);

      for (let period = 0; period < BETA.cowRating.zeroStreakRequired; period++) {
        await time.increase(BETA.cowRating.needPeriod + 60);
        await post(attestation, raters[0], tokenId, Kind.FundingNeed, 0, alice.address);
        await post(attestation, raters[1], tokenId, Kind.FundingNeed, 0, alice.address);
      }

      expect(await cowNFT.statusOf(tokenId)).to.equal(Status.SelfSustaining);
    });

    it("starts fading an idle rating after six idle days", async function () {
      const sys = await loadFixture(fixture);
      const { stasis, alice } = sys;
      // Keep the genesis fade at production length so this test measures the
      // idle slide on its own.
      await setClock(sys, {
        ...BETA,
        stasis: { ...BETA.stasis, genesisLife: PROD.stasis.genesisLife },
      });

      const before = await stasis.effectiveScore(alice.address);
      expect(before).to.equal(10_000n);

      // Past the (now six-day) grace period the rating starts sliding.
      await time.increase(BETA.stasis.idleGrace + DAY);
      const after = await stasis.effectiveScore(alice.address);
      expect(after).to.be.lessThan(before);
      expect(after).to.be.greaterThan(9_000n);
    });
  });

  describe("what the clock does not touch", function () {
    it("leaves the money alone", async function () {
      const sys = await loadFixture(fixture);
      const { generalPool, stasis, alice } = sys;
      await setClock(sys, BETA);

      // Rate windows move; the payout rate never does.
      expect(await generalPool.careRateWei()).to.equal(1_000_000_000_000_000n);
      // Nor does the reputation ledger stop being reputation.
      expect(await stasis.effectiveScore(alice.address)).to.equal(10_000n);
    });

    it("keeps the rules identical — only the numbers move", async function () {
      const sys = await loadFixture(fixture);
      const { cowRating, generalPool, moderation } = sys;
      await setClock(sys, BETA);

      // Caps, ratios and quorums are policy, not calendar.
      expect(await cowRating.activationThreshold()).to.equal(1_000n);
      expect(await cowRating.concentrationCapBps()).to.equal(2_000n);
      expect(await cowRating.earlyUnlockPenaltyBps()).to.equal(5_000n);
      expect(await generalPool.backerShareBps()).to.equal(5_000n);
      expect(await moderation.dominanceBps()).to.equal(6_600n);
    });
  });
});

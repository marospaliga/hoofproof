const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { withFundedRaters, mint } = require("./fixtures");

const DAY = 86_400;
const PIGS = ethers.encodeBytes32String("pigs");
const ZERO = ethers.ZeroAddress;

// Quorum an executed Care claim and return its id (anchor + spend proof).
async function careProof(attestation, a, b, tokenId) {
  const args = [tokenId, 1, "ipfs://care", 0, ZERO, 100n];
  const id = await attestation.connect(a).attest.staticCall(...args);
  await attestation.connect(a).attest(...args);
  await attestation.connect(b).attest(...args);
  return id;
}

// Quorum an executed Labor claim and return its id (spend proof).
async function laborProof(attestation, a, b, tokenId, worker, hours = 40n) {
  const args = [tokenId, 6, "ipfs://labor", hours, worker, 100n];
  const id = await attestation.connect(a).attest.staticCall(...args);
  await attestation.connect(a).attest(...args);
  await attestation.connect(b).attest(...args);
  return id;
}

async function needProof(attestation, a, b, tokenId, value, solver) {
  const args = [tokenId, 5, "ipfs://need", value, solver, 100n];
  const id = await attestation.connect(a).attest.staticCall(...args);
  await attestation.connect(a).attest(...args);
  await attestation.connect(b).attest(...args);
  return id;
}

async function activate(cowRating, raters, tokenId) {
  for (const rater of raters.slice(0, 5)) {
    await cowRating.connect(rater).stakeRating(tokenId, 200);
  }
}

describe("GeneralPool", function () {
  async function fixture() {
    return withFundedRaters();
  }



  describe("gas rebates", function () {
    it("pays nothing to a rater without protection activity", async function () {
      const { generalPool, stranger, owner } = await loadFixture(fixture);
      await owner.sendTransaction({
        to: await generalPool.getAddress(),
        value: ethers.parseEther("1"),
      });
      await expect(
        generalPool.connect(stranger).claimGasRebate()
      ).to.be.revertedWithCustomError(generalPool, "NoProtection");
    });

    it("pays a fixed rebate once per period", async function () {
      const { generalPool, cowRating, alice, owner, tokenId } = await loadFixture(fixture);

      // A generous base so the rebate outweighs the tx gas in this test.
      await generalPool.connect(owner).setGasRebate(ethers.parseEther("0.1"), 7 * DAY);
      await owner.sendTransaction({
        to: await generalPool.getAddress(),
        value: ethers.parseEther("1"),
      });

      // Alice curates protection-linked content, which is what qualifies.
      const img = ethers.keccak256(ethers.toUtf8Bytes("care-photo"));
      await cowRating.connect(alice).registerContent(tokenId, 1, img, true);
      await cowRating.connect(alice)["vote(uint256,uint8,bytes32,uint256,address)"](tokenId, 1, img, 1_000, alice.address);
      expect(await cowRating.protectionActivity(alice.address)).to.be.greaterThan(0);

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
    it("earmarks donated funds for a live protection project", async function () {
      const { generalPool, attestation, cowNFT, cowRating, owner, raters, tokenId } = await loadFixture(fixture);
      await activate(cowRating, raters, tokenId);
      const proof = await careProof(attestation, raters[0], raters[1], tokenId);

      await owner.sendTransaction({
        to: await generalPool.getAddress(),
        value: ethers.parseEther("1"),
      });

      const amount = ethers.parseEther("0.5");
      await generalPool.connect(owner).allocateCare(tokenId, amount, proof);
      expect(await generalPool.carePoolOf(tokenId)).to.equal(amount);
    });

    it("refuses earmarks without a live anchor or proof", async function () {
      const { generalPool, attestation, cowNFT, cowRating, owner, raters, alice, tokenId } = await loadFixture(fixture);
      const { mint } = require("./fixtures");
      const fresh = await mint(cowNFT, alice, "ipfs://fresh");

      await owner.sendTransaction({
        to: await generalPool.getAddress(),
        value: ethers.parseEther("1"),
      });

      // Fresh cow is still a project: care money is verified-living-only.
      await expect(
        generalPool.connect(owner).allocateCare(fresh, 1, 0)
      ).to.be.revertedWithCustomError(generalPool, "NotLivingCow");

      // Anchor live but no proof cited still fails.
      await activate(cowRating, raters, tokenId);
      await careProof(attestation, raters[0], raters[1], tokenId);
      await expect(
        generalPool.connect(owner).allocateCare(tokenId, 1, 0)
      ).to.be.revertedWithCustomError(generalPool, "NoProof");
    });

    it("closes the care rail when the real cow dies", async function () {
      const { generalPool, attestation, cowNFT, cowRating, owner, raters, tokenId } = await loadFixture(fixture);
      await activate(cowRating, raters, tokenId);
      const proof = await careProof(attestation, raters[0], raters[1], tokenId);

      await owner.sendTransaction({
        to: await generalPool.getAddress(),
        value: ethers.parseEther("1"),
      });
      await generalPool.connect(owner).allocateCare(tokenId, ethers.parseEther("0.25"), proof);

      // Three bonded attestors record the death. The record keeps working, but
      // care money can no longer be earmarked for it.
      const death = [tokenId, 3, "ipfs://death", 0, ZERO, 100n];
      for (const r of raters.slice(0, 3)) await attestation.connect(r).attest(...death);
      expect(await cowNFT.isDeceased(tokenId)).to.equal(true);

      await expect(
        generalPool.connect(owner).allocateCare(tokenId, 1, proof)
      ).to.be.revertedWithCustomError(generalPool, "NotLivingCow");
    });
  });

  describe("automatic care round", function () {
    it("allocates pro rata to rating and caps at attested need", async function () {
      const {
        generalPool, cowRating, attestation, cowNFT, owner, alice, bob, raters, tokenId,
      } = await loadFixture(fixture);
      const second = await mint(cowNFT, alice, "ipfs://second");

      // Both are real cows with a fresh care proof and a recorded need.
      await careProof(attestation, raters[0], raters[1], tokenId);
      await careProof(attestation, raters[0], raters[1], second);
      await needProof(attestation, raters[0], raters[1], tokenId, 500, alice.address);
      await needProof(attestation, raters[0], raters[1], second, 1_000, alice.address);

      // Cow 1 has three times the rating but a smaller need.
      await cowRating.connect(alice).boost(tokenId, PIGS, 300);
      await cowRating.connect(bob).boost(second, PIGS, 100);

      await owner.sendTransaction({
        to: await generalPool.getAddress(),
        value: ethers.parseEther("10"),
      });

      // Default tithe: 20% of 10 ETH = 2 ETH. Cow 1's pro-rata share is 1.5
      // ETH but its need caps it at 0.5; cow 2 receives its 0.5 share.
      await generalPool.runCareRound();
      expect(await generalPool.carePoolOf(tokenId)).to.equal(ethers.parseEther("0.5"));
      expect(await generalPool.carePoolOf(second)).to.equal(ethers.parseEther("0.5"));
      expect(await generalPool.totalCarePool()).to.equal(ethers.parseEther("1"));

      // The round is periodic, even when called permissionlessly.
      await expect(generalPool.runCareRound()).to.be.revertedWithCustomError(
        generalPool,
        "CareNotElapsed"
      );
    });

    it("skips unverified projects and carries the leftover forward", async function () {
      const {
        generalPool, cowRating, attestation, cowNFT, owner, alice, raters, tokenId,
      } = await loadFixture(fixture);
      const project = await mint(cowNFT, alice, "ipfs://project");

      // The project has a need, an anchor and rating, but no proof of hoof.
      await needProof(attestation, raters[0], raters[1], project, 1_000, alice.address);
      await cowRating.connect(alice).boost(project, PIGS, 1_000);

      await careProof(attestation, raters[0], raters[1], tokenId);
      await needProof(attestation, raters[0], raters[1], tokenId, 500, alice.address);
      await cowRating.connect(alice).boost(tokenId, PIGS, 100);

      await owner.sendTransaction({
        to: await generalPool.getAddress(),
        value: ethers.parseEther("5"),
      });

      // Budget = 1 ETH; only the verified cow is eligible, so only 0.5 ETH
      // (its need) is earmarked and the rest stays uncommitted.
      await generalPool.runCareRound();
      expect(await generalPool.carePoolOf(project)).to.equal(0);
      expect(await generalPool.carePoolOf(tokenId)).to.equal(ethers.parseEther("0.5"));
      expect(await generalPool.totalCarePool()).to.equal(ethers.parseEther("0.5"));
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
      const [, , , backedCows] = await generalPool.platformMetrics();
      expect(backedCows).to.equal(1); // a stake backs the cow immediately
      expect(await generalPool.platformValue()).to.be.greaterThan(0);
    });
  });

  describe("charitable events", function () {
    it("creates an event and escrows contributions", async function () {
      const { generalPool, alice, bob } = await loadFixture(fixture);

      await generalPool.connect(alice).createEvent("ipfs://event-bedding", ethers.parseEther("2"));
      const id = await generalPool.eventCount();
      expect(id).to.equal(1n);

      const created = await generalPool.events(id);
      expect(created.creator).to.equal(alice.address);
      expect(created.goal).to.equal(ethers.parseEther("2"));

      await generalPool.connect(bob).contribute(id, { value: ethers.parseEther("1") });
      expect(await generalPool.cycleRaised()).to.equal(ethers.parseEther("1"));
      expect((await generalPool.events(id)).raised).to.equal(ethers.parseEther("1"));
      expect(await generalPool.backerCycle(bob.address)).to.equal(ethers.parseEther("1"));
    });

    it("rejects empty metadata, unknown events and zero contributions", async function () {
      const { generalPool, alice } = await loadFixture(fixture);
      await expect(generalPool.connect(alice).createEvent("", 1)).to.be.revertedWithCustomError(
        generalPool,
        "EmptyCid"
      );
      await expect(generalPool.connect(alice).createEvent("ipfs://e", 0)).to.be.revertedWithCustomError(
        generalPool,
        "ZeroAmount"
      );
      await expect(generalPool.connect(alice).contribute(1, { value: 1 })).to.be.revertedWithCustomError(
        generalPool,
        "NoSuchEvent"
      );
    });

    it("only the creator spends escrow, and never more than was raised", async function () {
      const { generalPool, attestation, owner, alice, bob, tokenId } = await loadFixture(fixture);
      await generalPool.connect(alice).createEvent("ipfs://stable", ethers.parseEther("1"));
      const id = await generalPool.eventCount();
      await generalPool.connect(bob).contribute(id, { value: ethers.parseEther("1") });
      const proof = await laborProof(attestation, alice, bob, tokenId, alice.address);

      await expect(
        generalPool.connect(bob).spend(id, ethers.parseEther("1"), bob.address, proof)
      ).to.be.revertedWithCustomError(generalPool, "NotEventCreator");

      // Releases cite executed protection work.
      await expect(
        generalPool.connect(alice).spend(id, ethers.parseEther("1"), alice.address, 0)
      ).to.be.revertedWithCustomError(generalPool, "NoProof");

      // 1 ETH exceeds the 0.5 ETH large-spend threshold: deliberate two-step.
      await generalPool.connect(owner).approveSpend(id, ethers.parseEther("1"), alice.address, proof);
      const before = await ethers.provider.getBalance(alice.address);
      await generalPool.connect(alice).spend(id, ethers.parseEther("1"), alice.address, proof);
      expect(await ethers.provider.getBalance(alice.address)).to.be.greaterThan(before);
      expect((await generalPool.events(id)).spent).to.equal(ethers.parseEther("1"));

      await expect(generalPool.connect(alice).spend(id, 1, alice.address, proof)).to.be.revertedWithCustomError(
        generalPool,
        "CannotSpend"
      );
    });

    it("releases small amounts without prior approval", async function () {
      const { generalPool, attestation, owner, alice, bob, tokenId } = await loadFixture(fixture);
      await generalPool.connect(alice).createEvent("ipfs://small", ethers.parseEther("1"));
      const id = await generalPool.eventCount();
      await generalPool.connect(bob).contribute(id, { value: ethers.parseEther("0.1") });
      const proof = await laborProof(attestation, alice, bob, tokenId, alice.address);

      await owner.sendTransaction({ to: await generalPool.getAddress(), value: ethers.parseEther("1") });
      await generalPool.connect(alice).spend(id, ethers.parseEther("0.1"), alice.address, proof);
      expect((await generalPool.events(id)).spent).to.equal(ethers.parseEther("0.1"));
    });

    it("closing an event blocks further contributions", async function () {
      const { generalPool, alice, bob } = await loadFixture(fixture);
      await generalPool.connect(alice).createEvent("ipfs://e", ethers.parseEther("1"));
      const id = await generalPool.eventCount();
      await generalPool.connect(alice).closeEvent(id);
      await expect(
        generalPool.connect(bob).contribute(id, { value: 1 })
      ).to.be.revertedWithCustomError(generalPool, "EventClosed");
    });
  });

  describe("cycle credit", function () {
    async function advance(seconds) {
      await ethers.provider.send("evm_increaseTime", [seconds]);
      await ethers.provider.send("evm_mine", []);
    }

    it("primes the baseline on the first settle and pays nothing", async function () {
      const { generalPool } = await loadFixture(fixture);
      await generalPool.settleCycle();
      expect(await generalPool.lastCycleMovement()).to.equal(0);
      expect(await generalPool.lastCycleCredit()).to.equal(0);
      expect(await generalPool.lastCycleAt()).to.be.greaterThan(0);
    });

    it("pays backers and active raters from whole-field movement", async function () {
      const { generalPool, cowRating, stasis, alice, bob, tokenId } = await loadFixture(fixture);

      await generalPool.connect(alice).createEvent("ipfs://event-bedding", ethers.parseEther("2"));
      const id = await generalPool.eventCount();
      await generalPool.connect(alice).contribute(id, { value: ethers.parseEther("0.5") });
      await generalPool.connect(bob).contribute(id, { value: ethers.parseEther("0.5") });

      // Prime the baseline.
      await generalPool.settleCycle();

      // The field moves: alice stakes rating and thumbs the cow (activity too).
      await cowRating.connect(alice).stakeRating(tokenId, 200);
      await cowRating.connect(alice).boost(tokenId, PIGS, 1_000);

      await advance(7 * 3600); // one full 6h cycle

      const beforeAlice = await stasis.effectiveScore(alice.address);
      const beforeBob = await stasis.effectiveScore(bob.address);

      await generalPool.settleCycle();

      // Both are backers (50/50 share split), so both gained credit.
      expect(await stasis.effectiveScore(alice.address)).to.be.greaterThan(beforeAlice);
      expect(await stasis.effectiveScore(bob.address)).to.be.greaterThan(beforeBob);
      // Alice also moved the field (rating + backing), so movement was real.
      expect(await generalPool.lastCycleMovement()).to.be.greaterThan(0);
      expect(await generalPool.lastCycleCredit()).to.be.greaterThan(0);
      expect(await generalPool.lastCycleBackers()).to.equal(2);
      expect(await generalPool.lastCycleRaters()).to.be.greaterThan(0);
      // The cycle ledger resets for the next window.
      expect(await generalPool.cycleRaised()).to.equal(0);
    });

    it("only pays out again after the cycle period elapses", async function () {
      const { generalPool, cowRating, alice, tokenId } = await loadFixture(fixture);
      await generalPool.connect(alice).createEvent("ipfs://e", ethers.parseEther("1"));
      await generalPool.connect(alice).contribute(1, { value: 1 });
      await generalPool.settleCycle();

      await cowRating.connect(alice).boost(tokenId, PIGS, 1_000);
      await advance(2 * 3600); // inside the 6h window

      await expect(generalPool.settleCycle()).to.be.revertedWithCustomError(generalPool, "CycleNotElapsed");
    });

    it("caps the credit pool and respects the backer share split", async function () {
      const { generalPool, cowRating, stasis, alice, bob, tokenId, owner } = await loadFixture(fixture);

      // A huge ratio and a tiny cap make the cap the binding constraint.
      await generalPool
        .connect(owner)
        .setCycle(6 * 3600, 5_000, 100_000 /* pool = 10x movement */, 100 /* pool cap */);

      await generalPool.connect(alice).createEvent("ipfs://e", ethers.parseEther("2"));
      await generalPool.connect(alice).contribute(1, { value: 1 });
      await generalPool.connect(bob).contribute(1, { value: 1 });
      await generalPool.settleCycle();

      await cowRating.connect(alice).boost(tokenId, PIGS, 1_000);
      await advance(7 * 3600);

      const beforeAlice = await stasis.effectiveScore(alice.address);
      const beforeBob = await stasis.effectiveScore(bob.address);
      await generalPool.settleCycle();

      // Pool capped at 100 → backer pool 50 split equally between the backers.
      expect(await generalPool.lastCycleCredit()).to.equal(100);
      expect(await generalPool.lastCycleBackerShare()).to.equal(50);
      expect((await stasis.effectiveScore(alice.address)) - beforeAlice).to.be.greaterThan(0n);
      // Bob (backer only): +25 from the backer pool, nothing from raters.
      expect((await stasis.effectiveScore(bob.address)) - beforeBob).to.equal(25n);
    });
  });
});
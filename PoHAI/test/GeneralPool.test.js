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
      const { generalPool, alice, bob } = await loadFixture(fixture);
      await generalPool.connect(alice).createEvent("ipfs://stable", ethers.parseEther("1"));
      const id = await generalPool.eventCount();
      await generalPool.connect(bob).contribute(id, { value: ethers.parseEther("1") });

      await expect(
        generalPool.connect(bob).spend(id, ethers.parseEther("1"), bob.address)
      ).to.be.revertedWithCustomError(generalPool, "NotEventCreator");

      const before = await ethers.provider.getBalance(alice.address);
      await generalPool.connect(alice).spend(id, ethers.parseEther("1"), alice.address);
      expect(await ethers.provider.getBalance(alice.address)).to.be.greaterThan(before);
      expect((await generalPool.events(id)).spent).to.equal(ethers.parseEther("1"));

      await expect(generalPool.connect(alice).spend(id, 1, alice.address)).to.be.revertedWithCustomError(
        generalPool,
        "CannotSpend"
      );
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
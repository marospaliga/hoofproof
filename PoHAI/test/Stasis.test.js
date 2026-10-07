const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySystem, GENESIS } = require("./fixtures");

const BPS = 10_000n;
const DAY = 86_400;
const why = (text) => ethers.encodeBytes32String(text);

describe("Stasis", function () {
  async function fixture() {
    const sys = await deploySystem();
    // The owner doubles as a test module so Stasis can be exercised on its own.
    await sys.stasis.setModule(sys.owner.address, true);
    return sys;
  }

  it("only the owner can grant genesis score", async function () {
    const { stasis, alice } = await loadFixture(fixture);

    await expect(
      stasis.connect(alice).grantGenesis(alice.address, 100)
    ).to.be.revertedWithCustomError(stasis, "OwnableUnauthorizedAccount");

    await stasis.grantGenesis(alice.address, GENESIS);
    expect(await stasis.effectiveScore(alice.address)).to.equal(GENESIS);
  });

  it("refuses calls from addresses that are not enrolled modules", async function () {
    const { stasis, alice, stranger } = await loadFixture(fixture);

    expect(await stasis.isModule(stranger.address)).to.equal(false);
    await expect(
      stasis.connect(stranger).award(alice.address, 100, why("test"))
    ).to.be.revertedWithCustomError(stasis, "NotModule");
  });

  it("caps gains at 10% so spikes are impossible", async function () {
    const { stasis, alice } = await loadFixture(fixture);
    await stasis.grantGenesis(alice.address, 1000);

    const before = await stasis.effectiveScore(alice.address);
    await stasis.award(alice.address, 500, why("big award"));
    const after = await stasis.effectiveScore(alice.address);

    // Asked for 500, received only the 10% cap.
    expect(after - before).to.equal(before / 10n);
  });

  it("lets a zero-score account bootstrap by a fixed floor", async function () {
    const { stasis, alice } = await loadFixture(fixture);

    await stasis.award(alice.address, 10_000, why("bootstrap"));
    expect(await stasis.effectiveScore(alice.address)).to.equal(100); // MIN_GAIN
  });

  it("bonding locks score so it can no longer be spent", async function () {
    const { stasis, alice } = await loadFixture(fixture);
    await stasis.grantGenesis(alice.address, GENESIS);

    await stasis.bond(alice.address, 4_000);
    expect(await stasis.free(alice.address)).to.equal(GENESIS - 4_000n);
    expect(await stasis.bonded(alice.address)).to.equal(4_000);

    await expect(
      stasis.spend(alice.address, 7_000, why("too much"))
    ).to.be.revertedWithCustomError(stasis, "InsufficientFree");

    await stasis.spend(alice.address, 6_000, why("within free balance"));
    expect(await stasis.free(alice.address)).to.equal(0);
  });

  it("never lets decay eat into bonded collateral", async function () {
    const { stasis, alice } = await loadFixture(fixture);
    await stasis.grantGenesis(alice.address, GENESIS);
    await stasis.bond(alice.address, GENESIS);

    // Far past both the genesis lifetime and the idle-decay window.
    await time.increase(400 * DAY);

    expect(await stasis.effectiveScore(alice.address)).to.equal(GENESIS);
    expect(await stasis.free(alice.address)).to.equal(0);
  });

  it("decays genesis linearly over a year", async function () {
    const { stasis, alice } = await loadFixture(fixture);
    await stasis.grantGenesis(alice.address, GENESIS);

    await time.increase(182 * DAY);

    const score = await stasis.effectiveScore(alice.address);
    // ~half the year gone; small tolerance for idle decay.
    expect(score).to.be.lessThan(GENESIS / 2n + 10n);
    expect(score).to.be.greaterThan(GENESIS / 2n - 10n);
  });

  it("decays idle accounts after the grace period", async function () {
    const { stasis, alice } = await loadFixture(fixture);

    // Build a non-genesis score so the two decay rules don't overlap:
    // repeated capped awards, each after a period passes.
    for (let i = 0; i < 5; i++) {
      await stasis.award(alice.address, 1_000, why("work"));
      await time.increase(7 * DAY);
    }
    const working = await stasis.effectiveScore(alice.address);
    expect(working).to.be.greaterThan(100n);

    // Grace (180d) + full decay window (365d) with no further activity.
    await time.increase(545 * DAY);

    const decayed = await stasis.effectiveScore(alice.address);
    // IDLE_DECAY_BPS caps the loss at 20%.
    expect(decayed).to.equal((working * (BPS - 2_000n)) / BPS);
    expect(decayed).to.be.lessThan(working);
  });

  it("slashes without a cap — punishment is immediate", async function () {
    const { stasis, alice } = await loadFixture(fixture);
    await stasis.grantGenesis(alice.address, 1000);

    await stasis.slash(alice.address, 900, why("fraud"));
    expect(await stasis.effectiveScore(alice.address)).to.equal(100);
  });
});

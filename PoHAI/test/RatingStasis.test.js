const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySystem, withFundedRaters, grantGenesis, mint, GENESIS } = require("./fixtures");

const DAY = 86_400;
const ZERO = ethers.ZeroAddress;
const ZERO32 = ethers.ZeroHash;
const PIGS = ethers.encodeBytes32String("pigs");

function hash(s) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

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

async function laborProof(attestation, a, b, tokenId, worker, hours = 40n) {
  const args = [tokenId, 6, "ipfs://labor", hours, worker, 100n];
  const id = await attestation.connect(a).attest.staticCall(...args);
  await attestation.connect(a).attest(...args);
  await attestation.connect(b).attest(...args);
  return id;
}

describe("rating = voiced Stasis (unification)", function () {
  async function fixture() {
    return withFundedRaters();
  }

  describe("Stasis voiced liens", function () {
    async function stasisFixture() {
      const sys = await deploySystem();
      await sys.stasis.setModule(sys.owner.address, true);
      await grantGenesis(sys.stasis, [sys.alice]);
      return sys;
    }

    it("keeps voting weight but removes free score", async function () {
      const { stasis, alice } = await loadFixture(stasisFixture);

      await stasis.voice(alice.address, 200);
      expect(await stasis.effectiveScore(alice.address)).to.equal(GENESIS); // weight intact
      expect(await stasis.voiced(alice.address)).to.equal(200);
      expect(await stasis.freeScore(alice.address)).to.equal(GENESIS - 200n);
      expect(await stasis.totalVoiced()).to.equal(200);
    });

    it("will not let spend or bond touch voiced score", async function () {
      const { stasis, alice } = await loadFixture(stasisFixture);
      await stasis.voice(alice.address, 200);

      await expect(stasis.bond(alice.address, GENESIS)).to.be.revertedWithCustomError(
        stasis,
        "InsufficientFree"
      );
      await stasis.spend(alice.address, GENESIS - 200n, ethers.encodeBytes32String("exit"));
      expect(await stasis.score(alice.address)).to.equal(200);
      expect(await stasis.freeScore(alice.address)).to.equal(0);
      await expect(stasis.voice(alice.address, 1)).to.be.revertedWithCustomError(
        stasis,
        "InsufficientFree"
      );
    });

    it("transfers voiced score without minting", async function () {
      const { stasis, alice, bob } = await loadFixture(stasisFixture);
      await stasis.voice(alice.address, 100);
      const supply = await stasis.totalScore();

      await stasis.transferVoiced(alice.address, bob.address, 100);
      expect(await stasis.score(alice.address)).to.equal(GENESIS - 100n);
      expect(await stasis.voiced(alice.address)).to.equal(0);
      expect(await stasis.score(bob.address)).to.equal(100);
      expect(await stasis.totalScore()).to.equal(supply); // zero-sum
    });

    it("burns voiced score and shrinks supply", async function () {
      const { stasis, alice } = await loadFixture(stasisFixture);
      await stasis.voice(alice.address, 100);
      const supply = await stasis.totalScore();

      await stasis.burnVoiced(alice.address, 100, ethers.encodeBytes32String("moderation"));
      expect(await stasis.score(alice.address)).to.equal(GENESIS - 100n);
      expect(await stasis.totalVoiced()).to.equal(0);
      expect(await stasis.totalScore()).to.equal(supply - 100n);
    });

    it("protects voiced score from decay", async function () {
      const { stasis, alice } = await loadFixture(stasisFixture);
      await stasis.voice(alice.address, 500);
      await time.increase(2 * 365 * DAY);
      // Genesis decayed away, but the lien floor survives.
      expect(await stasis.effectiveScore(alice.address)).to.equal(500);
    });
  });

  describe("min-bond edge", function () {
    it("a fully-voiced account must unvote before bonding a claim", async function () {
      const { cowRating, attestation, stasis, owner, stranger, tokenId } = await loadFixture(fixture);
      await grantGenesis(stasis, [stranger], 100);

      // Voice the whole 100-Stasis score with two amounts.
      await cowRating.connect(stranger).boost(tokenId, PIGS, 50);
      await cowRating.connect(stranger).boost(tokenId, PIGS, 50);
      expect(await stasis.freeScore(stranger.address)).to.equal(0);

      // The 100-Stasis bond requirement no longer fits in free score.
      await expect(
        attestation.connect(stranger).attest(tokenId, 1, "ipfs://care", 0, ZERO, 100)
      ).to.be.revertedWithCustomError(stasis, "InsufficientFree");

      // Releasing the voice makes room.
      const key = await cowRating.cowKeyOf(tokenId);
      await cowRating.connect(stranger).unvote(key);
      expect(await stasis.freeScore(stranger.address)).to.equal(100);
      await expect(
        attestation.connect(stranger).attest(tokenId, 1, "ipfs://care", 0, ZERO, 100)
      ).to.emit(attestation, "Attested");
    });
  });

  describe("author award is a transfer, not a mint", function () {
    it("moves score from voter to author with fixed supply", async function () {
      const { cowRating, stasis, attestation, raters, alice, bob, tokenId } = await loadFixture(fixture);
      await activate(cowRating, raters, tokenId);
      await careQuorum(attestation, raters[0], raters[1], tokenId);

      const h = hash("bob-doc");
      await cowRating.connect(bob).registerContent(tokenId, 1, h, true);

      const supply = await stasis.totalScore();
      const aliceBefore = await stasis.effectiveScore(alice.address);
      const bobBefore = await stasis.effectiveScore(bob.address);

      await cowRating.connect(alice).vote(tokenId, 1, h, 1_000);

      expect(await stasis.effectiveScore(bob.address)).to.be.greaterThan(bobBefore);
      expect(await stasis.effectiveScore(alice.address)).to.be.lessThan(aliceBefore);
      expect(await stasis.totalScore()).to.equal(supply); // zero-sum transfer
    });
  });

  describe("the one invariant", function () {
    it("keeps total voiced Stasis equal to total cow rating", async function () {
      const { cowRating, stasis, attestation, raters, alice, tokenId } = await loadFixture(fixture);
      await activate(cowRating, raters, tokenId);
      await careQuorum(attestation, raters[0], raters[1], tokenId);

      await cowRating.connect(alice).boost(tokenId, PIGS, 1_000);
      await cowRating.connect(alice).vote(tokenId, 2, hash("a-thread"), 1_000);
      await cowRating.connect(raters[0]).vote(tokenId, 1, hash("a-photo"), 1_000);

      // Rating is not a shadow counter: it *is* the voiced Stasis, exactly.
      expect(await stasis.totalVoiced()).to.equal(await cowRating.totalRatingPoints());
    });
  });

  describe("labor becomes rating", function () {
    it("commits the worker's chosen share as a locked cow lien", async function () {
      const { cowRating, stasis, attestation, raters, alice, tokenId } = await loadFixture(fixture);
      await cowRating.connect(alice).setLaborCommitBps(10_000);

      const before = await cowRating.cowRating(tokenId);
      await laborProof(attestation, raters[0], raters[1], tokenId, alice.address, 40n);

      const after = await cowRating.cowRating(tokenId);
      expect(after).to.be.greaterThan(before);
      expect(await stasis.voiced(alice.address)).to.be.greaterThan(0);

      const [keys] = await cowRating.voterLocks(alice.address);
      const laborKey = keys[0];

      await expect(cowRating.connect(alice).unvote(laborKey)).to.be.revertedWithCustomError(
        cowRating,
        "LockedUntil"
      );

      await time.increase(31 * DAY);
      await cowRating.connect(alice).unvote(laborKey);
      expect(await cowRating.cowRating(tokenId)).to.equal(before);
    });
  });

  describe("moderation slashes the lien", function () {
    it("burns a capped share and freezes the content", async function () {
      const { cowRating, moderation, stasis, alice, bob, tokenId } = await loadFixture(fixture);
      const h = hash("slashed-photo");
      await cowRating.connect(alice).registerContent(tokenId, 1, h, true);
      const key = await cowRating.contentKeyOf(tokenId, 1, h);

      await cowRating.connect(bob).vote(tokenId, 1, h, 1_000);
      const lien = await cowRating.lockOf(bob.address, key);
      const ratingBefore = await cowRating.cowRating(tokenId);

      const id = await moderation.connect(alice).propose.staticCall(tokenId, key, 0);
      await moderation.connect(alice).propose(tokenId, key, 0);
      await time.increase(49 * 3600);
      await moderation.execute(id);
      expect(await cowRating.contentHidden(key)).to.equal(true);

      await expect(cowRating.connect(bob).unvote(key)).to.be.revertedWithCustomError(
        cowRating,
        "ContentHidden"
      );

      await cowRating.slashContent(key, 10);
      const burned = lien - (await cowRating.lockOf(bob.address, key));
      expect(burned).to.equal(lien / 2n); // 50% cap
      expect(await cowRating.cowRating(tokenId)).to.equal(ratingBefore - burned);
      expect(await stasis.voiced(bob.address)).to.equal(lien - burned);

      // A second batch cannot slash the same voter twice.
      await expect(cowRating.slashContent(key, 10)).to.be.revertedWithCustomError(
        cowRating,
        "NothingToSlash"
      );
    });
  });

  describe("care redemption burns Stasis for real ETH", function () {
    it("releases care money one way and cannot be repeated", async function () {
      const { cowRating, generalPool, stasis, attestation, raters, alice, owner, tokenId } =
        await loadFixture(fixture);
      await activate(cowRating, raters, tokenId);
      const proof = await careQuorum(attestation, raters[0], raters[1], tokenId);
      await cowRating.connect(alice).boost(tokenId, PIGS, 1_000);

      await owner.sendTransaction({ to: await generalPool.getAddress(), value: ethers.parseEther("2") });
      await generalPool.connect(owner).allocateCare(tokenId, ethers.parseEther("2"), proof);

      const scoreBefore = await stasis.effectiveScore(alice.address);
      const ethBefore = await ethers.provider.getBalance(alice.address);
      const poolBefore = await generalPool.carePoolOf(tokenId);

      const tx = await generalPool.connect(alice).redeemCare(tokenId, 100, proof);
      const receipt = await tx.wait();
      const gas = receipt.gasUsed * receipt.gasPrice;

      expect(await stasis.effectiveScore(alice.address)).to.equal(scoreBefore - 100n);
      expect(await generalPool.carePoolOf(tokenId)).to.equal(poolBefore - ethers.parseEther("0.1"));
      const ethAfter = await ethers.provider.getBalance(alice.address);
      expect(ethAfter).to.equal(ethBefore + ethers.parseEther("0.1") - gas);

      await expect(
        generalPool.connect(alice).redeemCare(tokenId, 100, proof)
      ).to.be.revertedWithCustomError(generalPool, "AlreadyRedeemed");
    });
  });
});

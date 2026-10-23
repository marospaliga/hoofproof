const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { withFundedRaters, grantGenesis, mint, GENESIS } = require("./fixtures");

const DAY = 86_400;
const ZERO = ethers.ZeroAddress;

const Kind = {
  Existence: 0,
  Care: 1,
  Sale: 2,
  Death: 3,
  Revenue: 4,
  FundingNeed: 5,
};

const State = { Open: 0n, Executed: 1n, Disputed: 2n, Refuted: 3n };
const PIGS = ethers.encodeBytes32String("pigs");

async function activate(cowRating, raters, tokenId) {
  for (const rater of raters.slice(0, 5)) {
    await cowRating.connect(rater).stakeRating(tokenId, 200);
  }
}

async function post(attestation, signer, tokenId, kind, value, subject, bond = 100) {
  const args = [tokenId, kind, "ipfs://evidence", value, subject, bond];
  const id = await attestation.connect(signer).attest.staticCall(...args);
  await attestation.connect(signer).attest(...args);
  return id;
}

describe("Attestation", function () {
  async function fixture() {
    return withFundedRaters();
  }

  it("holds the bond while a claim is still below quorum", async function () {
    const { attestation, stasis, alice, tokenId } = await loadFixture(fixture);

    // Care needs 2 distinct attestations.
    const id = await post(attestation, alice, tokenId, Kind.Care, 0, ZERO);

    const claim = await attestation.claims(id);
    expect(claim.state).to.equal(State.Open);
    expect(claim.support).to.equal(1);
    expect(await stasis.bonded(alice.address)).to.equal(100);
  });

  it("executes on quorum and returns every bond", async function () {
    const { attestation, stasis, alice, bob, tokenId } = await loadFixture(fixture);

    await post(attestation, alice, tokenId, Kind.Care, 0, ZERO);
    expect(await stasis.bonded(alice.address)).to.equal(100);

    await post(attestation, bob, tokenId, Kind.Care, 0, ZERO);

    expect((await attestation.claims(1)).state).to.equal(State.Executed);
    expect(await stasis.bonded(alice.address)).to.equal(0);
    expect(await stasis.bonded(bob.address)).to.equal(0);
  });

  it("never lets one account count twice toward a claim", async function () {
    const { attestation, alice, tokenId } = await loadFixture(fixture);

    await post(attestation, alice, tokenId, Kind.Care, 0, ZERO);
    await expect(
      attestation.connect(alice).attest(tokenId, Kind.Care, "ipfs://evidence", 0, ZERO, 100)
    ).to.be.revertedWithCustomError(attestation, "AlreadySupported");
  });

  it("records a death once three bonded raters agree, without freezing the cow", async function () {
    const { attestation, cowNFT, cowRating, raters, tokenId } = await loadFixture(fixture);
    await activate(cowRating, raters, tokenId);
    expect(await cowNFT.isDeceased(tokenId)).to.equal(false);

    await post(attestation, raters[0], tokenId, Kind.Death, 0, ZERO);
    await post(attestation, raters[1], tokenId, Kind.Death, 0, ZERO);
    expect(await cowNFT.isDeceased(tokenId)).to.equal(false);

    await post(attestation, raters[2], tokenId, Kind.Death, 0, ZERO);
    expect(await cowNFT.isDeceased(tokenId)).to.equal(true);
    expect(await cowNFT.isVerified(tokenId)).to.equal(true);

    // Death is a fact, not a lock: rating continues.
    await cowRating.connect(raters[3]).boost(tokenId, PIGS, 100);
    expect(await cowRating.ratingOf(tokenId)).to.be.greaterThan(0);

    // But new care and funding claims are closed on a memorial.
    await expect(
      post(attestation, raters[0], tokenId, Kind.Care, 0, ZERO)
    ).to.be.revertedWithCustomError(attestation, "IsDeceased");
    await expect(
      post(attestation, raters[0], tokenId, Kind.FundingNeed, 0, raters[0].address)
    ).to.be.revertedWithCustomError(attestation, "IsDeceased");
  });

  it("applies an offline sale without charging the rated-handshake cost", async function () {
    const { attestation, cowNFT, stasis, raters, stranger, tokenId } = await loadFixture(fixture);
    await grantGenesis(stasis, [stranger]);

    const before = await stasis.effectiveScore(stranger.address);
    for (const rater of raters.slice(0, 3)) {
      await post(attestation, rater, tokenId, Kind.Sale, 0, stranger.address);
    }

    expect(await cowNFT.ownerOf(tokenId)).to.equal(stranger.address);
    // A real sale is proof of hoof as well as a move.
    expect(await cowNFT.isVerified(tokenId)).to.equal(true);
    // Reality already happened — no rating is consumed by the move itself.
    expect(await stasis.effectiveScore(stranger.address)).to.equal(before);
  });

  it("destroys a refuted claim's bonds and refunds the challenger", async function () {
    const { attestation, stasis, owner, alice, bob, tokenId } = await loadFixture(fixture);

    const id = await post(attestation, alice, tokenId, Kind.Care, 0, ZERO, 300);
    await attestation.connect(bob).dispute(id, 200);

    expect((await attestation.claims(id)).state).to.equal(State.Disputed);
    expect(await stasis.bonded(bob.address)).to.equal(200);

    await expect(attestation.connect(bob).resolve(id, false)).to.be.revertedWithCustomError(
      attestation,
      "OwnableUnauthorizedAccount"
    );

    const bobBefore = await stasis.effectiveScore(bob.address);
    await attestation.connect(owner).resolve(id, false);

    // The liar's 300 is destroyed; the challenger keeps their 200.
    expect(await stasis.bonded(alice.address)).to.equal(0);
    expect(await stasis.effectiveScore(alice.address)).to.equal(GENESIS - 300n);
    expect(await stasis.bonded(bob.address)).to.equal(0);
    expect(await stasis.effectiveScore(bob.address)).to.equal(bobBefore);
    expect((await attestation.claims(id)).state).to.equal(State.Refuted);
  });

  it("upholds a disputed claim by punishing the challenger instead", async function () {
    const { attestation, stasis, owner, alice, bob, tokenId } = await loadFixture(fixture);

    // Care needs 2, so a single report is still below quorum when disputed.
    const id = await post(attestation, alice, tokenId, Kind.Care, 0, ZERO, 300);
    await attestation.connect(bob).dispute(id, 200);

    await attestation.connect(owner).resolve(id, true);

    expect(await stasis.effectiveScore(alice.address)).to.equal(GENESIS);
    expect(await stasis.effectiveScore(bob.address)).to.equal(GENESIS - 200n);
    // Support is 1 of 2, so the claim is upheld but cannot execute yet.
    expect((await attestation.claims(id)).state).to.equal(State.Open);
  });

  it("counts a cow as covered the first time its need reaches zero", async function () {
    const { attestation, cowNFT, stasis, cowRating, raters, alice, tokenId } = await loadFixture(fixture);
    await activate(cowRating, raters, tokenId);
    expect(await cowRating.cowsEverCovered()).to.equal(0);

    // Month 0: the project still needs 500 per period (quorum is 2).
    await post(attestation, raters[0], tokenId, Kind.FundingNeed, 500, alice.address);
    await post(attestation, raters[1], tokenId, Kind.FundingNeed, 500, alice.address);

    // Month 1: the dependency disappears — whoever removed it is credited,
    // but only because a second rater corroborated (solver != reporter).
    await time.increase(30 * DAY);
    const before = await stasis.effectiveScore(alice.address);
    await post(attestation, raters[0], tokenId, Kind.FundingNeed, 0, alice.address);
    await post(attestation, raters[1], tokenId, Kind.FundingNeed, 0, alice.address);
    const after = await stasis.effectiveScore(alice.address);

    expect(after - before).to.equal(50); // 10% of the 500 that vanished
    expect((await cowRating.funding(tokenId)).need).to.equal(0);
    expect(await cowRating.cowsEverCovered()).to.equal(1);

    // A later period at zero does not count the same cow twice.
    await time.increase(30 * DAY);
    await post(attestation, raters[0], tokenId, Kind.FundingNeed, 0, alice.address);
    await post(attestation, raters[1], tokenId, Kind.FundingNeed, 0, alice.address);
    expect(await cowRating.cowsEverCovered()).to.equal(1);

    // Need can come back: there is no terminal status.
    await time.increase(30 * DAY);
    await post(attestation, raters[0], tokenId, Kind.FundingNeed, 300, alice.address);
    await post(attestation, raters[1], tokenId, Kind.FundingNeed, 300, alice.address);
    expect((await cowRating.funding(tokenId)).need).to.equal(300);
    expect(await cowNFT.isDeceased(tokenId)).to.equal(false);
  });

  it("skips the solver award for solo self-reports when corroboration is required", async function () {
    const { attestation, cowRating, stasis, owner, raters, alice, tokenId } = await loadFixture(fixture);
    await activate(cowRating, raters, tokenId);
    await attestation.connect(owner).setQuorum(Kind.FundingNeed, 1);

    await post(attestation, raters[0], tokenId, Kind.FundingNeed, 500, alice.address);

    // Alice alone reports the reduction naming herself solver: the need is
    // recorded, but with no corroborator the award is skipped.
    await time.increase(30 * DAY);
    const before = await stasis.effectiveScore(alice.address);
    await post(attestation, alice, tokenId, Kind.FundingNeed, 0, alice.address);
    expect(await stasis.effectiveScore(alice.address)).to.equal(before);
    expect((await cowRating.funding(tokenId)).need).to.equal(0);
  });

  it("refuses attestations against tokens that were never minted", async function () {
    const { attestation, cowNFT, alice } = await loadFixture(fixture);

    await expect(
      attestation.connect(alice).attest(999, Kind.Care, "ipfs://x", 0, ZERO, 100)
    ).to.be.revertedWithCustomError(cowNFT, "ERC721NonexistentToken");
  });
});

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { withFundedRaters, mint } = require("./fixtures");

const DAY = 86_400;

function hash(s) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

describe("Moderation", function () {
  async function fixture() {
    return withFundedRaters();
  }

  // Register protection-linked content and return its key.
  async function doc(cowRating, author, tokenId, name) {
    const h = hash(name);
    await cowRating.connect(author).registerContent(tokenId, 1, h, true);
    return cowRating.contentKeyOf(tokenId, 1, h);
  }

  it("executes the dominance fast-path after the timelock", async function () {
    const { cowRating, moderation, alice, tokenId } = await loadFixture(fixture);
    const key = await doc(cowRating, alice, tokenId, "photo-1");

    const id = await moderation.connect(alice).propose.staticCall(tokenId, key, 0);
    await moderation.connect(alice).propose(tokenId, key, 0);
    // Single proposer holds 100% of expressed weight (>= 66%).
    expect((await moderation.proposals(id)).forWeight).to.be.greaterThan(0);

    await expect(moderation.execute(id)).to.be.revertedWithCustomError(moderation, "TooEarly");
    await time.increase(49 * 3600);
    await moderation.execute(id);
    expect((await moderation.proposals(id)).state).to.equal(1n); // Executed
    expect(await moderation.openProposal(key)).to.equal(0);
  });

  it("rejects when challengers win the majority", async function () {
    const { cowRating, moderation, alice, bob, tokenId } = await loadFixture(fixture);
    const key = await doc(cowRating, alice, tokenId, "photo-2");

    const id = await moderation.connect(alice).propose.staticCall(tokenId, key, 0);
    await moderation.connect(alice).propose(tokenId, key, 0);
    await moderation.connect(bob).challenge(id, false); // 10k vs 10k

    await time.increase(3 * DAY + 3600);
    await moderation.execute(id);
    expect((await moderation.proposals(id)).state).to.equal(2n); // Rejected
  });

  it("executes contested hides with majority plus distinct raters", async function () {
    const { cowRating, moderation, alice, bob, carol, dave, erin, tokenId } = await loadFixture(fixture);
    const key = await doc(cowRating, alice, tokenId, "photo-3");

    const id = await moderation.connect(alice).propose.staticCall(tokenId, key, 0);
    await moderation.connect(alice).propose(tokenId, key, 0);
    await moderation.connect(bob).challenge(id, true);
    await moderation.connect(carol).challenge(id, true);
    await moderation.connect(dave).challenge(id, false);
    await moderation.connect(erin).challenge(id, false);
    // 60% for (< 66% dominance), majority, 5 distinct raters.
    await expect(moderation.execute(id)).to.be.revertedWithCustomError(moderation, "TooEarly");
    await time.increase(3 * DAY + 3600);
    await moderation.execute(id);
    expect((await moderation.proposals(id)).state).to.equal(1n); // Executed
  });

  it("requires distinct raters even with a majority", async function () {
    const { cowRating, moderation, owner, alice, tokenId } = await loadFixture(fixture);
    const key = await doc(cowRating, alice, tokenId, "photo-4");

    const id = await moderation.connect(alice).propose.staticCall(tokenId, key, 0);
    await moderation.connect(alice).propose(tokenId, key, 0);

    // Dominance would fast-path a solo proposal — disable it to test the
    // contested minimum: 100% threshold can never be met by expression.
    await moderation.connect(owner).setPolicy(10001, 48 * 3600, 3 * DAY, 2);
    await time.increase(3 * DAY + 3600);
    await expect(moderation.execute(id)).to.be.revertedWithCustomError(moderation, "QuorumNotMet");
  });

  it("blocks double votes, parallel proposals and unknown items", async function () {
    const { cowRating, moderation, alice, bob, tokenId } = await loadFixture(fixture);
    const key = await doc(cowRating, alice, tokenId, "photo-5");

    const id = await moderation.connect(alice).propose.staticCall(tokenId, key, 0);
    await moderation.connect(alice).propose(tokenId, key, 0);
    await expect(moderation.connect(alice).challenge(id, true)).to.be.revertedWithCustomError(
      moderation,
      "AlreadyVoted"
    );
    await expect(moderation.connect(bob).propose(tokenId, key, 0)).to.be.revertedWithCustomError(
      moderation,
      "ProposalOpen"
    );
    await expect(
      moderation.connect(bob).propose(tokenId, ethers.ZeroHash, 0)
    ).to.be.revertedWithCustomError(moderation, "UnknownItem");
  });

  it("rejects items proposed under the wrong cow", async function () {
    const { cowNFT, cowRating, moderation, alice, tokenId } = await loadFixture(fixture);
    const second = await mint(cowNFT, alice, "ipfs://second");
    const h = hash("photo-6");
    await cowRating.connect(alice).registerContent(second, 1, h, true);
    const key = await cowRating.contentKeyOf(second, 1, h);
    await expect(moderation.connect(alice).propose(tokenId, key, 0)).to.be.revertedWithCustomError(
      moderation,
      "ItemMismatch"
    );
  });

  it("closes the challenge window after expiry", async function () {
    const { cowRating, moderation, alice, bob, tokenId } = await loadFixture(fixture);
    const key = await doc(cowRating, alice, tokenId, "photo-7");

    const id = await moderation.connect(alice).propose.staticCall(tokenId, key, 0);
    await moderation.connect(alice).propose(tokenId, key, 0);
    await time.increase(3 * DAY + 3600);
    await expect(moderation.connect(bob).challenge(id, false)).to.be.revertedWithCustomError(
      moderation,
      "WindowClosed"
    );
  });
});

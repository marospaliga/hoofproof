const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { withFundedRaters, mint } = require("./fixtures");

const DAY = 86_400;
const PIGS = ethers.encodeBytes32String("pigs");
const HASH = ethers.keccak256(ethers.toUtf8Bytes("proposal-1"));

describe("HerdCouncil", function () {
  async function fixture() {
    const sys = await withFundedRaters();
    const second = await mint(sys.cowNFT, sys.alice, "ipfs://second");
    await sys.cowNFT.connect(sys.alice).setHerd(sys.tokenId, 1);
    await sys.cowNFT.connect(sys.alice).setHerd(second, 1);
    return { ...sys, second, herdId: 1 };
  }

  it("only members may propose", async function () {
    const { herdCouncil, carol, herdId } = await loadFixture(fixture);
    await expect(
      herdCouncil.connect(carol).propose(herdId, HASH, 2)
    ).to.be.revertedWithCustomError(herdCouncil, "NotAMember");
  });

  it("dedupes proposals on their hash", async function () {
    const { herdCouncil, alice, herdId } = await loadFixture(fixture);

    const id = await herdCouncil.connect(alice).propose.staticCall(herdId, HASH, 2);
    await herdCouncil.connect(alice).propose(herdId, HASH, 2);
    expect(await herdCouncil.proposalIdOf(HASH)).to.equal(id);

    await expect(
      herdCouncil.connect(alice).propose(herdId, HASH, 2)
    ).to.be.revertedWithCustomError(herdCouncil, "AlreadyProposed");
  });

  it("votes are reputation-weighted and tallied into a decision", async function () {
    const { herdCouncil, cowNFT, cowRating, alice, bob, carol, tokenId, second, herdId } =
      await loadFixture(fixture);

    // Bob's cow joins the herd too.
    const bobsCow = await mint(cowNFT, bob, "ipfs://bobs");
    await cowNFT.connect(bob).setHerd(bobsCow, herdId);

    // Members earn rating so their votes carry real weight.
    await cowRating.connect(alice).boost(tokenId, PIGS, 1_000);
    await cowRating.connect(alice).boost(second, PIGS, 1_000);
    await cowRating.connect(bob).boost(bobsCow, PIGS, 1_000);

    const id = await herdCouncil.connect(alice).propose.staticCall(herdId, HASH, 2);
    await herdCouncil.connect(alice).propose(herdId, HASH, 2);

    await herdCouncil.connect(alice).vote(id, true);
    let proposal = await herdCouncil.proposals(id);
    const aliceWeight = await herdCouncil.memberVoteWeight(alice.address, herdId);
    expect(proposal.forVotes).to.equal(aliceWeight);
    expect(await herdCouncil.hasVoted(id, alice.address)).to.equal(true);

    await herdCouncil.connect(bob).vote(id, false);
    proposal = await herdCouncil.proposals(id);
    const bobWeight = await herdCouncil.memberVoteWeight(bob.address, herdId);
    expect(proposal.againstVotes).to.equal(bobWeight);

    await expect(
      herdCouncil.connect(alice).vote(id, true)
    ).to.be.revertedWithCustomError(herdCouncil, "AlreadyVoted");

    await expect(
      herdCouncil.connect(carol).vote(id, true)
    ).to.be.revertedWithCustomError(herdCouncil, "NotAMember");

    // Can only be tallied after the window closes.
    await expect(
      herdCouncil.connect(alice).finalize(id)
    ).to.be.revertedWithCustomError(herdCouncil, "VotingClosed");

    await time.increase(3 * DAY);
    await herdCouncil.connect(alice).finalize(id);
    proposal = await herdCouncil.proposals(id);
    expect(proposal.executed).to.equal(true);
    // Alice's two rated cows outweigh Bob's single rated cow.
    expect(proposal.forVotes).to.be.greaterThan(proposal.againstVotes);

    await expect(
      herdCouncil.connect(alice).finalize(id)
    ).to.be.revertedWithCustomError(herdCouncil, "NotExecutable");
  });
});
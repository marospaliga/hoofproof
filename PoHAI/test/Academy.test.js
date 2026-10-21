const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deploySystem } = require("./fixtures");

const LESSON = ethers.keccak256(ethers.toUtf8Bytes("lesson:why-protection-first"));
const CERT_LESSON = ethers.keccak256(ethers.toUtf8Bytes("lesson:field-emergencies"));

/** EIP-712 digest matching Academy's domain (HoofProofAcademy v1). */
async function completionSig(academy, signer, lessonId, account) {
  const domain = {
    name: "HoofProofAcademy",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await academy.getAddress(),
  };
  const types = { Completed: [
    { name: "lessonId", type: "uint8" },
    { name: "account", type: "address" },
  ] };
  return signer.signTypedData(domain, types, { lessonId, account });
}

describe("Academy — zero-start course", () => {
  async function withAcademy() {
    const sys = await deploySystem();
    const [owner, grader, learner, other] = await ethers.getSigners();
    // In fixtures the owner doubles as grader; use a distinct grader key here
    // to prove the signature check binds to the right signer.
    await sys.academy.connect(owner).setGrader(grader.address);
    await sys.academy.connect(owner).setLesson(1, LESSON, 100, false);
    await sys.academy.connect(owner).setLesson(2, CERT_LESSON, 100, true);
    return { ...sys, grader, learner, other };
  }

  it("a zero-score learner passes a quiz and earns their first Stasis", async () => {
    const { academy, stasis, grader, learner } = await withAcademy();
    expect(await stasis.effectiveScore(learner.address)).to.equal(0);

    const sig = await completionSig(academy, grader, 1, learner.address);
    await expect(academy.connect(learner).complete(1, sig))
      .to.emit(academy, "LessonCompleted")
      .withArgs(learner.address, 1, 100, 100);

    // MIN_GAIN floor lets a 0-score account bootstrap: 100 lands in full.
    expect(await stasis.effectiveScore(learner.address)).to.equal(100);
    expect(await academy.completed(learner.address, 1)).to.be.true;
  });

  it("rejects a completion signed by anyone but the grader", async () => {
    const { academy, learner, other } = await withAcademy();
    const forged = await completionSig(academy, other, 1, learner.address);
    await expect(academy.connect(learner).complete(1, forged))
      .to.be.revertedWithCustomError(academy, "NotGrader");
  });

  it("binds the signature to account and lesson — no replay for others or other lessons", async () => {
    const { academy, stasis, grader, learner, other } = await withAcademy();

    // Signed for `other` but submitted by `learner`.
    const forOther = await completionSig(academy, grader, 1, other.address);
    await expect(academy.connect(learner).complete(1, forOther))
      .to.be.revertedWithCustomError(academy, "NotGrader");

    // Signed for lesson 1 but submitted against lesson 2.
    const forLesson1 = await completionSig(academy, grader, 1, learner.address);
    await expect(academy.connect(learner).complete(2, forLesson1))
      .to.be.revertedWithCustomError(academy, "NotGrader");
  });

  it("a completion cannot be claimed twice", async () => {
    const { academy, grader, learner } = await withAcademy();
    const sig = await completionSig(academy, grader, 1, learner.address);
    await academy.connect(learner).complete(1, sig);
    await expect(academy.connect(learner).complete(1, sig))
      .to.be.revertedWithCustomError(academy, "AlreadyCompleted");
  });

  it("unknown lessons revert", async () => {
    const { academy, grader, learner } = await withAcademy();
    const sig = await completionSig(academy, grader, 9, learner.address);
    await expect(academy.connect(learner).complete(9, sig))
      .to.be.revertedWithCustomError(academy, "UnknownLesson");
  });

  it("certification badge needs every cert lesson; it rewards but never gates", async () => {
    const { academy, stasis, grader, learner, cowRating, cowNFT, other, alice } = await withAcademy();
    expect(await academy.isCertified(learner.address)).to.be.false;

    const s1 = await completionSig(academy, grader, 1, learner.address);
    await academy.connect(learner).complete(1, s1);
    expect(await academy.isCertified(learner.address)).to.be.false;

    const s2 = await completionSig(academy, grader, 2, learner.address);
    await academy.connect(learner).complete(2, s2);
    expect(await academy.isCertified(learner.address)).to.be.true;

    // The badge is reputation, not a gate: an *uncertified* account can still
    // vote — the rating engine never asks Academy.
    expect(await academy.isCertified(other.address)).to.be.false;
    const tokenId = await (async () => {
      const id = await cowNFT.connect(alice).mintCow.staticCall("ipfs://cow");
      await cowNFT.connect(alice).mintCow("ipfs://cow");
      return id;
    })();
    // Give `other` score through the course as well, but only lesson 1 —
    // uncertified, and still able to vote.
    const s3 = await completionSig(academy, grader, 1, other.address);
    await academy.connect(other).complete(1, s3);
    expect(await academy.isCertified(other.address)).to.be.false;
    // A voice is rating, so this spends 10 of the 100 Stasis the course paid.
    await expect(
      cowRating.connect(other).boost(tokenId, ethers.encodeBytes32String("general"), 10)
    ).to.emit(cowRating, "Boosted");
  });

  it("the curriculum hash is owner-pinned and auditable", async () => {
    const { academy } = await withAcademy();
    const [contentHash, reward, exists, cert] = await academy.lessonInfo(1);
    expect(contentHash).to.equal(LESSON);
    expect(reward).to.equal(100);
    expect(exists).to.be.true;
    expect(cert).to.be.false;
  });

  it("zero-start e2e: course score alone buys a first vote", async () => {
    const { academy, stasis, cowRating, cowNFT, grader, learner, alice } = await withAcademy();
    // Alice mints a cow; the fresh learner has never held score.
    const tokenId = await (async () => {
      const id = await cowNFT.connect(alice).mintCow.staticCall("ipfs://cow");
      await cowNFT.connect(alice).mintCow("ipfs://cow");
      return id;
    })();

    const sig = await completionSig(academy, grader, 1, learner.address);
    await academy.connect(learner).complete(1, sig);
    expect(await stasis.effectiveScore(learner.address)).to.equal(100);

    // A voice spends rating directly — the course's 100 Stasis buys a real,
    // if small, voice on the cow.
    await expect(
      cowRating.connect(learner).boost(tokenId, ethers.encodeBytes32String("general"), 10)
    ).to.emit(cowRating, "Boosted");
    expect(await cowRating.voiceLocked(learner.address)).to.equal(10);
  });
});

const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deploySystem } = require("./fixtures");
const curriculum = require("../server/curriculum");
const academy = require("../server/academy");

// The whole curriculum in one place: the files, the parser and the grader.
const FILES = fs
  .readdirSync(curriculum.LESSONS_DIR)
  .filter((f) => f.endsWith(".md"))
  .sort();

describe("Curriculum — one artifact per lesson", () => {
  it("every lesson parses into prose plus a well-formed quiz", () => {
    for (const l of curriculum.loadAll()) {
      expect(l.quiz.length, `lesson ${l.id}`).to.be.at.least(2);
      for (const q of l.quiz) {
        expect(q.q.length, `lesson ${l.id}`).to.be.greaterThan(0);
        expect(q.options.length, `lesson ${l.id}`).to.be.at.least(2);
        expect(q.answer, `lesson ${l.id}`).to.be.at.least(0);
        expect(q.answer, `lesson ${l.id}`).to.be.below(q.options.length);
        // exactly one option is the right one
        expect(q.options.filter((o) => o.correct).length, `lesson ${l.id}`).to.equal(1);
        // and no option still carries the marker
        for (const o of q.options) expect(o.text).to.not.include("✓");
      }
    }
  });

  it("covers every lesson file in the catalog", () => {
    expect(FILES.length).to.equal(curriculum.CATALOG.length);
    expect(curriculum.CATALOG.map((l) => l.file)).to.deep.equal(FILES);
  });

  it("never sends the answer key to the client", () => {
    for (const l of academy.lessonsPublic()) {
      expect(l.text, `lesson ${l.id}`).to.not.include("✓");
      expect(JSON.stringify(l.quiz), `lesson ${l.id}`).to.not.include("✓");
      for (const q of l.quiz) {
        expect(q).to.not.have.property("answer");
        expect(q).to.not.have.property("correct");
        expect(q).to.have.property("options");
      }
    }
  });

  it("serves the prose without the quiz block", () => {
    for (const l of curriculum.loadAll()) {
      const raw = fs.readFileSync(path.join(curriculum.LESSONS_DIR, l.file), "utf8");
      // The served text is the file up to the quiz heading, nothing more.
      expect(raw.startsWith(l.text), `lesson ${l.id}`).to.be.true;
      expect(raw.slice(l.text.length)).to.match(/^\s*##\s+Quiz/);
    }
  });

  it("pins the whole file, and the prose on its own", () => {
    for (const l of curriculum.loadAll()) {
      const raw = fs.readFileSync(path.join(curriculum.LESSONS_DIR, l.file), "utf8");
      expect(l.hash, `lesson ${l.id}`).to.equal(ethers.keccak256(ethers.toUtf8Bytes(raw)));
      expect(l.textHash, `lesson ${l.id}`).to.equal(ethers.keccak256(ethers.toUtf8Bytes(l.text)));
    }
  });

  it("rotates the options, stably, and never in one fixed slot", () => {
    const first = curriculum.loadAll();
    const second = curriculum.loadAll();
    for (let i = 0; i < first.length; i++) {
      expect(first[i].quiz.map((q) => q.options.map((o) => o.text)))
        .to.deep.equal(second[i].quiz.map((q) => q.options.map((o) => o.text)));
    }
    const slots = new Set();
    for (const l of first) for (const q of l.quiz) slots.add(q.answer);
    expect(slots.size).to.be.greaterThan(1);
  });

  it("grades the right answers as a pass and the wrong ones as a fail", async () => {
    const lesson = curriculum.loadLesson(1);
    const right = lesson.quiz.map((q) => q.answer);
    const wrong = lesson.quiz.map((q, i) => (q.answer + 1) % q.options.length);

    const pass = await academy.gradeAndSign({
      address: "0x" + "11".repeat(20),
      lessonId: 1,
      answers: right,
      chainId: 31337,
      academyAddress: "0x" + "22".repeat(20),
    });
    expect(pass.passed).to.be.true;
    expect(pass.signature).to.be.a("string");

    const fail = await academy.gradeAndSign({
      address: "0x" + "11".repeat(20),
      lessonId: 1,
      answers: wrong,
      chainId: 31337,
      academyAddress: "0x" + "22".repeat(20),
    });
    expect(fail.passed).to.be.false;
    expect(fail.wrong).to.be.greaterThan(0);
  });

  it("refuses an unknown lesson and a mismatched answer count", async () => {
    const unknown = await academy.gradeAndSign({
      address: "0x" + "11".repeat(20),
      lessonId: 99,
      answers: [],
      chainId: 31337,
      academyAddress: "0x" + "22".repeat(20),
    });
    expect(unknown.passed).to.be.false;
    expect(unknown.error).to.equal("unknown lesson");

    const short = await academy.gradeAndSign({
      address: "0x" + "11".repeat(20),
      lessonId: 1,
      answers: [0],
      chainId: 31337,
      academyAddress: "0x" + "22".repeat(20),
    });
    expect(short.passed).to.be.false;
  });

  it("does not teach the model that was replaced", () => {
    // The voting model was rewritten: a vote is rating spent, there is no
    // per-voter budget and no dilution. The curriculum must not teach the
    // deleted mechanics — a tester would be learning a system that no
    // longer exists.
    const banned = [
      "voice budget",
      "votes past their voice",
      "dilute to make room",
      "rating weight",
      "votes are cheer",
      "weighted vote",
      "vote power",
    ];
    for (const l of curriculum.loadAll()) {
      const haystack = (l.text + "\n" + l.quiz.map((q) => `${q.q} ${q.options.map((o) => o.text).join(" ")}`).join("\n"))
        .toLowerCase();
      for (const phrase of banned) {
        expect(haystack, `lesson ${l.id} still teaches "${phrase}"`).to.not.include(phrase);
      }
    }
  });

  it("teaches the model that exists", () => {
    const one = curriculum.loadLesson(1);
    const haystack = (one.text + " " + one.quiz.map((q) => q.q).join(" ")).toLowerCase();
    expect(haystack).to.include("vote is rating spent");
    expect(haystack).to.include("no dilution");
    // The clock is on-chain, so the lesson may not hardcode a deadline.
    expect(one.text).to.not.include("90 days. this is");
  });

  it("grades the down-cow question as the emergency it is", () => {
    // Regression: the prose and the answer key used to disagree here, so a
    // learner who read the lesson was taught the wrong answer.
    const four = curriculum.loadLesson(4);
    const q = four.quiz[2];
    expect(q.q.toLowerCase()).to.include("cannot stand");
    expect(q.options[q.answer].text.toLowerCase()).to.include("milk fever");
  });
});

describe("Curriculum — end to end", () => {
  it("a learner can pass the real course and be paid on-chain", async () => {
    const sys = await deploySystem();
    const { academy: academyContract, stasis, learner } = { ...sys, learner: sys.stranger };

    // Pin the real curriculum, exactly as seedDemo and pinLessons do.
    for (const entry of curriculum.CATALOG) {
      const lesson = curriculum.loadLesson(entry.id);
      await academyContract.connect(sys.owner).setLesson(
        entry.id,
        lesson.hash,
        lesson.reward,
        entry.cert
      );
    }

    // The server grades the parsed quiz and signs the completion.
    const lesson = curriculum.loadLesson(1);
    const graded = await academy.gradeAndSign({
      address: learner.address,
      lessonId: 1,
      answers: lesson.quiz.map((q) => q.answer),
      chainId: (await ethers.provider.getNetwork()).chainId,
      academyAddress: await academyContract.getAddress(),
    });
    expect(graded.passed).to.be.true;

    await academyContract.connect(learner).complete(1, graded.signature);
    expect(await stasis.effectiveScore(learner.address)).to.equal(100);
    expect(await academyContract.completed(learner.address, 1)).to.be.true;
  });
});

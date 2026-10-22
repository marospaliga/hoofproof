// Cow-care curriculum: lesson files served from academy/lessons + quiz
// grading.
//
// The curriculum is one markdown file per lesson — prose and quiz together —
// so what a learner reads and what the server grades cannot drift apart
// (see curriculum.js). This module splits them: the client reads the prose
// and the questions, the answers stay here.
//
// Grading flow: POST /api/academy/submit with { address, lessonId, answers }
//   → server checks the answers against the parsed quiz
//   → on pass: signs an EIP-712 Completed{lessonId, account} record with
//     GRADER_KEY and returns the signature
//   → client submits Academy.complete(lessonId, signature) on-chain.
//
// Lesson hashes pinned on-chain must match keccak256 of the exact file bytes
// served here — scripts/pinLessons.js re-pins after the curriculum changes.
const { ethers } = require("ethers");
const { LESSONS, loadLesson, loadAll } = require("./curriculum");

const DOMAIN = { name: "HoofProofAcademy", version: "1" };
const TYPES = { Completed: [
  { name: "lessonId", type: "uint8" },
  { name: "account", type: "address" },
] };

// Hardhat default account #0 — matches deploy.js's default grader. Override
// with GRADER_KEY in real deployments.
const DEFAULT_GRADER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function grader() {
  return new ethers.Wallet(process.env.GRADER_KEY || DEFAULT_GRADER_KEY);
}

/** One lesson with its file hash — what the Academy contract pins. */
function lessonFile(id) {
  return loadLesson(Number(id));
}

/**
 * Public lesson list: prose + questions, never answers.
 *
 * The prose is served without the quiz block, so the answer key never leaves
 * the server. The quiz travels as parsed questions with no answer index.
 */
function lessonsPublic() {
  return loadAll().map((l) => ({
    id: l.id,
    reward: l.reward,
    cert: l.cert,
    text: l.text,
    hash: l.hash,
    quiz: l.quiz.map((q, i) => ({
      index: i,
      q: q.q,
      options: q.options.map((o) => o.text), // the correct option is never sent
    })),
  }));
}

/**
 * Grade a submission. Returns { passed, signature, chainId, contract }.
 * `contract` is the deployed Academy address (read from deployed.json) so
 * the client can bind its typed-data domain identically.
 */
async function gradeAndSign({ address, lessonId, answers, chainId, academyAddress }) {
  const lesson = loadLesson(Number(lessonId));
  if (!lesson) return { passed: false, error: "unknown lesson" };
  const quiz = lesson.quiz;
  if (!Array.isArray(answers) || answers.length !== quiz.length) {
    return { passed: false, error: `expected ${quiz.length} answers` };
  }
  const wrong = quiz.filter((q, i) => Number(answers[i]) !== q.answer).length;
  const passed = wrong === 0;
  if (!passed) return { passed: false, wrong, total: quiz.length };

  const wallet = grader();
  const domain = { ...DOMAIN, chainId, verifyingContract: academyAddress };
  const signature = await wallet.signTypedData(domain, TYPES, {
    lessonId: Number(lessonId),
    account: ethers.getAddress(address),
  });
  return { passed: true, signature, grader: wallet.address, wrong: 0, total: quiz.length };
}

module.exports = { LESSONS, lessonsPublic, lessonFile, gradeAndSign };

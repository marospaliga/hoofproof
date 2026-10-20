// Cow-care curriculum: quizzes (answers server-side ONLY — never sent to the
// client before submission) + lesson files served from academy/lessons.
//
// Grading flow: POST /api/academy/submit with { address, lessonId, answers }
//   → server checks answers against QUIZ below
//   → on pass: signs an EIP-712 Completed{lessonId, account} record with
//     GRADER_KEY and returns the signature
//   → client submits Academy.complete(lessonId, signature) on-chain.
//
// Lesson hashes pinned on-chain must match keccak256 of the exact file bytes
// served here — seedDemo.js pins them at seed time.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const LESSONS_DIR = path.join(__dirname, "..", "academy", "lessons");

// reward: Stasis paid on pass. Stasis caps gains per step (10%, floor 100),
// so 100 lands in full for early-course accounts.
const LESSONS = [
  { id: 1, file: "01-why-protection-first.md", reward: 100, cert: false },
  { id: 2, file: "02-reading-a-cow.md", reward: 100, cert: false },
  { id: 3, file: "03-hoof-care.md", reward: 100, cert: false },
  { id: 4, file: "04-nutrition-hydration.md", reward: 100, cert: false },
  { id: 5, file: "05-recording-evidence.md", reward: 100, cert: false },
  { id: 6, file: "06-cert-field-emergencies.md", reward: 100, cert: true },
  { id: 7, file: "07-cert-attestations.md", reward: 100, cert: true },
];

// Each question carries its options with `correct` marking the right one.
// At load time, options are rotated by a deterministic per-question offset so
// the correct index varies (never an always-"b" tell). The rotated answer
// index stays server-side; clients receive options sans answer.
function rotate(questions, lessonId) {
  return questions.map((q, i) => {
    const correct = q.options.indexOf(q.correct);
    // Mixed stride keeps answer positions varied *within* a lesson too.
    const offset = (lessonId * 7 + i * 4 + 1) % q.options.length;
    const options = q.options.map((_, j) => q.options[(j + offset) % q.options.length]);
    return { q: q.q, options, answer: (correct - offset + q.options.length) % q.options.length };
  });
}

const RAW = {
  1: [
    { q: "What makes a cow \"Active\"?", options: [
      "Many votes on its posts",
      "1,000 weighted stake from stakers, plus a live protection anchor",
      "The owner declaring it protected",
    ], correct: "1,000 weighted stake from stakers, plus a live protection anchor" },
    { q: "When a whale votes past their voice budget:", options: [
      "The vote fails",
      "Their oldest voice locks dilute to make room",
      "New voters are pushed out",
    ], correct: "Their oldest voice locks dilute to make room" },
    { q: "An attested labor hour on a high-rated cow is worth:", options: [
      "The same as on any cow",
      "Up to 3x the base rate",
      "Nothing — labor is unpaid",
    ], correct: "Up to 3x the base rate" },
  ],
  2: [
    { q: "A cow stands alone away from the herd. This is:", options: [
      "Normal personality",
      "A late sign — the problem likely started days ago",
      "A reason to boost the cow's rating",
    ], correct: "A late sign — the problem likely started days ago" },
    { q: "Rumination rate of 25 chews per minute suggests:", options: [
      "Excellent health",
      "Digestive trouble, possibly rumen acidosis",
      "Dehydration",
    ], correct: "Digestive trouble, possibly rumen acidosis" },
    { q: "The best first action when you notice a concerning sign:", options: [
      "Nothing until it's obvious",
      "Record it as evidence with time and details, then monitor or call a vet per severity",
      "Post a worried comment without details",
    ], correct: "Record it as evidence with time and details, then monitor or call a vet per severity" },
  ],
  3: [
    { q: "The most cost-effective lameness intervention is:", options: [
      "Emergency trimming when a cow goes lame",
      "Prevention: flooring, hygiene, routine trimming schedule",
      "More grain for hoof strength",
    ], correct: "Prevention: flooring, hygiene, routine trimming schedule" },
    { q: "Sudden lameness, swelling between the toes, foul smell most suggests:", options: [
      "A sole ulcer",
      "Foot rot",
      "Digital dermatitis",
    ], correct: "Foot rot" },
    { q: "You can't tell two hoof conditions apart. Best course:", options: [
      "Pick one — confidence matters",
      "Describe both possibilities with photos and say you're unsure",
      "Stay silent until you're certain",
    ], correct: "Describe both possibilities with photos and say you're unsure" },
  ],
  4: [
    { q: "A lactating cow's daily water needs are best described as:", options: [
      "About 10 liters, whenever she feels like it",
      "50–100 liters, with reliable access including at night",
      "Rain and fresh grass cover it",
    ], correct: "50–100 liters, with reliable access including at night" },
    { q: "Too little fiber with too much grain primarily risks:", options: [
      "Milk fever",
      "Rumen acidosis, later laminitis",
      "Selenium deficiency",
    ], correct: "Rumen acidosis, later laminitis" },
    { q: "A cow down and cannot stand shortly after calving suggests:", options: [
      "Milk fever (hypocalcemia) — a genuine emergency",
      "Ordinary tiredness",
      "Something the herd will fix on its own",
    ], correct: "Ordinary tiredness" },
  ],
  5: [
    { q: "Why does HoofProof store hashes of evidence rather than the files?", options: [
      "Storage is cheaper on-chain",
      "A hash is an immutable fingerprint that proves a specific file was rated",
      "To hide the evidence from raters",
    ], correct: "A hash is an immutable fingerprint that proves a specific file was rated" },
    { q: "Which is the strongest evidence post?", options: [
      "\"The cow is sick, something must be done!\"",
      "\"Cow #4, 14 Oct 06:40: rectal temp 39.8C, feed intake down since last evening, photo of ear tag; possible infection, needs vet confirmation.\"",
      "\"My friend, who is basically a vet, says it's serious.\"",
    ], correct: "\"Cow #4, 14 Oct 06:40: rectal temp 39.8C, feed intake down since last evening, photo of ear tag; possible infection, needs vet confirmation.\"" },
    { q: "You believe a protection-linked post is fraudulent. What now?", options: [
      "Delete it",
      "Rate the competing evidence with your voice; moderation is for real fraud, decided by rating weight, reversible on appeal",
      "Spam comments calling it fake",
    ], correct: "Rate the competing evidence with your voice; moderation is for real fraud, decided by rating weight, reversible on appeal" },
  ],
  6: [
    { q: "A cow straining 40 minutes with no calf visible. You:", options: [
      "Pull hard when you see hooves",
      "Check position; anything other than two front hooves + nose means call the vet; don't pull blindly",
      "Wait an hour — calving takes time",
    ], correct: "Check position; anything other than two front hooves + nose means call the vet; don't pull blindly" },
    { q: "Cow down, cannot stand, hours after calving. First response:", options: [
      "Drag her to the barn by the udder",
      "Keep her comfortable, call the vet for calcium treatment, note when she went down",
      "Wait — down cows usually get up alone",
    ], correct: "Keep her comfortable, call the vet for calcium treatment, note when she went down" },
    { q: "Pasture frothy bloat. Correct handling:", options: [
      "Run her to the barn",
      "Walk her slowly with head up, call the vet; a bloaty cow can die within an hour",
      "Feed hay to settle the stomach",
    ], correct: "Walk her slowly with head up, call the vet; a bloaty cow can die within an hour" },
  ],
  7: [
    { q: "An attestation claim's subject should be:", options: [
      "The attestor",
      "The worker who did the hours",
      "The cow's owner",
    ], correct: "The worker who did the hours" },
    { q: "You weren't present but saw timestamped photos. You may attest if:", options: [
      "They seem trustworthy",
      "The evidence is sufficient for you to vouch — and you'll stake your bond and rating on it",
      "A third person also says it's fine, without evidence",
    ], correct: "The evidence is sufficient for you to vouch — and you'll stake your bond and rating on it" },
    { q: "You realize the claim you attested was inflated:", options: [
      "Nothing — attestations are informal",
      "Your bond and rating were at stake; declining to attest is always free",
      "Only the worker's rating drops",
    ], correct: "Your bond and rating were at stake; declining to attest is always free" },
  ],
};

// Rotated once at load: the correct index varies per question (no always-b tell).
const QUIZ = Object.fromEntries(
  Object.entries(RAW).map(([id, questions]) => [id, rotate(questions, Number(id))])
);

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

function lessonFile(id) {
  const l = LESSONS.find((x) => x.id === id);
  if (!l) return null;
  const text = fs.readFileSync(path.join(LESSONS_DIR, l.file), "utf8");
  return { ...l, text, hash: ethers.keccak256(ethers.toUtf8Bytes(text)) };
}

/** Public lesson list: text + questions, never answers. */
function lessonsPublic() {
  return LESSONS.map((l) => {
    const text = fs.readFileSync(path.join(LESSONS_DIR, l.file), "utf8");
    return {
      id: l.id,
      reward: l.reward,
      cert: l.cert,
      text,
      hash: ethers.keccak256(ethers.toUtf8Bytes(text)),
      quiz: (QUIZ[l.id] || []).map((q, i) => ({
        index: i,
        q: q.q,
        options: q.options, // answers stay server-side; only the index of the
        // correct option is never sent pre-submission
      })),
    };
  });
}

/**
 * Grade a submission. Returns { passed, signature, chainId, contract }.
 * `contract` is the deployed Academy address (read from deployed.json) so
 * the client can bind its typed-data domain identically.
 */
async function gradeAndSign({ address, lessonId, answers, chainId, academyAddress }) {
  const quiz = QUIZ[lessonId];
  if (!quiz) return { passed: false, error: "unknown lesson" };
  if (!Array.isArray(answers) || answers.length !== quiz.length) {
    return { passed: false, error: `expected ${quiz.length} answers` };
  }
  const wrong = quiz.filter((q, i) => Number(answers[i]) !== q.answer).length;
  const passed = wrong === 0;
  if (!passed) return { passed: false, wrong, total: quiz.length };

  const wallet = grader();
  const domain = { ...DOMAIN, chainId, verifyingContract: academyAddress };
  const signature = await wallet.signTypedData(domain, TYPES, {
    lessonId,
    account: ethers.getAddress(address),
  });
  return { passed: true, signature, grader: wallet.address, wrong: 0, total: quiz.length };
}

module.exports = { LESSONS, QUIZ, lessonsPublic, lessonFile, gradeAndSign };

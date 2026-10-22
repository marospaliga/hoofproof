// The curriculum — one artifact per lesson.
//
// The prose and the quiz live in the *same* markdown file
// (`academy/lessons/*.md`), so there is exactly one source of truth: what a
// learner reads and what the server grades can never drift apart. This module
// splits a lesson file into its two halves:
//
//   text → the prose, with the quiz section removed. This is what the client
//          receives, so it must never contain the answer key.
//   quiz → the parsed questions. The correct option is known here and nowhere
//          else: the client gets the options without an answer index.
//
// Two hashes come out of a lesson:
//   hash     → keccak256 of the whole file (prose + quiz). This is what the
//              Academy contract pins on-chain, so the pin commits to the whole
//              artifact a learner consumed.
//   textHash → keccak256 of the served prose alone, for a client that only
//              ever saw the prose.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const LESSONS_DIR = path.join(__dirname, "..", "academy", "lessons");

// id → file, the one-time Stasis award for passing, and whether the lesson
// awards the certified badge (reputation, never a gate). Stasis caps gains per
// step (10%, floor 100), so a 100 award lands in full for early-course
// accounts.
const CATALOG = [
  { id: 1, file: "01-why-protection-first.md", reward: 100, cert: false },
  { id: 2, file: "02-reading-a-cow.md", reward: 100, cert: false },
  { id: 3, file: "03-hoof-care.md", reward: 100, cert: false },
  { id: 4, file: "04-nutrition-hydration.md", reward: 100, cert: false },
  { id: 5, file: "05-recording-evidence.md", reward: 100, cert: false },
  { id: 6, file: "06-cert-field-emergencies.md", reward: 100, cert: true },
  { id: 7, file: "07-cert-attestations.md", reward: 100, cert: true },
];

const QUIZ_HEADING = /^##[ \t]+Quiz[ \t]*$/m;
const CORRECT = "✓"; // the marker that says which option is right

/** Split a lesson file into its prose and its quiz block. */
function splitLesson(md) {
  const m = QUIZ_HEADING.exec(md);
  if (!m) return { text: md.replace(/\s+$/, ""), quiz: "" };
  return {
    text: md.slice(0, m.index).replace(/\s+$/, ""),
    quiz: md.slice(m.index + m[0].length),
  };
}

/**
 * Parse the quiz block of a lesson file.
 *
 * The format is deliberately boring:
 *
 *   1. Question text, maybe wrapped over two lines
 *      - a) first option
 *      - b) second option ✓
 *      - c) third option
 *
 * The ✓ marks the correct option. It may land on a wrapped continuation
 * line, so it is resolved only after the lines have been joined.
 */
function parseQuiz(block) {
  const questions = [];
  let cur = null;
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const qm = /^(\d+)\.\s+(.*)$/.exec(line.trim());
    if (qm) {
      cur = { q: qm[2].trim(), options: [] };
      questions.push(cur);
      continue;
    }
    const om = /^\s+-\s*([a-zA-Z])\)\s+(.*)$/.exec(line);
    if (om && cur) {
      cur.options.push({ text: om[2].trim(), correct: false });
      continue;
    }
    if (!cur) continue;
    // A wrapped line belongs to the option above it, or to the question when
    // no option has been read yet.
    const last = cur.options[cur.options.length - 1];
    if (last) last.text = `${last.text} ${line.trim()}`.trim();
    else cur.q = `${cur.q} ${line.trim()}`.trim();
  }
  for (const q of questions) {
    let correct = -1;
    q.options.forEach((o, i) => {
      if (o.text.includes(CORRECT)) {
        o.correct = true;
        o.text = o.text.split(CORRECT).join("").trim();
        if (correct === -1) correct = i;
      }
    });
    q.correctIndex = correct;
  }
  return questions;
}

/** Fail loudly on a malformed quiz — a lesson nobody can pass is a broken app. */
function validateQuiz(lessonId, questions) {
  if (!questions.length) throw new Error(`lesson ${lessonId}: no quiz found`);
  for (const [i, q] of questions.entries()) {
    const n = i + 1;
    if (q.options.length < 2) {
      throw new Error(`lesson ${lessonId} q${n}: needs at least 2 options`);
    }
    if (q.correctIndex < 0) {
      throw new Error(`lesson ${lessonId} q${n}: no option is marked correct`);
    }
    if (q.options.filter((o) => o.correct).length !== 1) {
      throw new Error(`lesson ${lessonId} q${n}: exactly one option must be marked correct`);
    }
  }
}

/**
 * Rotate the options deterministically so the correct answer is not always in
 * the same slot. The rotation is stable (same lesson → same order), so
 * reloading the page gives nothing away.
 */
function rotate(questions, lessonId) {
  return questions.map((q, i) => {
    const n = q.options.length;
    const offset = (lessonId * 7 + i * 4 + 1) % n;
    const options = q.options.map((_, j) => q.options[(j + offset) % n]);
    return { q: q.q, options, answer: options.findIndex((o) => o.correct) };
  });
}

/** Load one lesson: prose, parsed quiz and the hashes. */
function loadLesson(id) {
  const entry = CATALOG.find((l) => l.id === Number(id));
  if (!entry) return null;
  const raw = fs.readFileSync(path.join(LESSONS_DIR, entry.file), "utf8");
  const { text, quiz: block } = splitLesson(raw);
  const questions = parseQuiz(block);
  validateQuiz(entry.id, questions);
  return {
    id: entry.id,
    file: entry.file,
    reward: entry.reward,
    cert: entry.cert,
    text,
    hash: ethers.keccak256(ethers.toUtf8Bytes(raw)),
    textHash: ethers.keccak256(ethers.toUtf8Bytes(text)),
    quiz: rotate(questions, entry.id),
  };
}

/** Load every lesson, in course order. */
function loadAll() {
  return CATALOG.map((l) => loadLesson(l.id));
}

module.exports = {
  CATALOG,
  LESSONS: CATALOG,
  LESSONS_DIR,
  splitLesson,
  parseQuiz,
  validateQuiz,
  rotate,
  loadLesson,
  loadAll,
};

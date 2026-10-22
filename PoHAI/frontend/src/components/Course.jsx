import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { completeLesson, academyProgress, friendlyError } from "../lib/chain.js";

const LETTERS = ["a", "b", "c", "d"];

// The zero-start on-ramp. Read a lesson, pass the quiz, and each finished
// lesson pays a modest Stasis award — enough to cover a Labor-claim bond and
// buy a first vote. The badge never gates an action; it just speeds things up.
export default function Course({ contracts, account, notify, onEarned }) {
  const [serverLessons, setServerLessons] = useState(null);
  const [progress, setProgress] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [answers, setAnswers] = useState({});
  const [busy, setBusy] = useState(null); // lessonId while grading/submitting
  const [fetchErr, setFetchErr] = useState("");

  useEffect(() => {
    api.academyLessons().then(setServerLessons).catch((e) => setFetchErr(e.message));
  }, []);

  useEffect(() => {
    if (!contracts || !account) return;
    academyProgress(contracts, account).then(setProgress).catch(() => {});
  }, [contracts, account]);

  function isDone(id) {
    return progress?.lessons.find((l) => l.id === id)?.done;
  }

  async function submit(lessonId) {
    if (!account) return notify("Connect a wallet to earn Stasis.", "error");
    const quiz = serverLessons.find((l) => l.id === lessonId)?.quiz || [];
    const picks = quiz.map((q) => answers[`${lessonId}-${q.index}`]);
    if (picks.some((p) => p === undefined)) {
      return notify("Answer every question first.", "error");
    }
    setBusy(lessonId);
    try {
      // Server grades and, on a pass, signs the completion (EIP-712).
      const grade = await api.submitQuiz(account, lessonId, picks);
      if (!grade.passed) {
        return notify(
          `Not quite — ${grade.wrong} of ${grade.total} wrong. Re-read and try again.`,
          "error"
        );
      }
      // Submit the signed completion on-chain; the contract pays the reward.
      await completeLesson(contracts, lessonId, grade.signature);
      const p = await academyProgress(contracts, account);
      setProgress(p);
      const lesson = serverLessons.find((l) => l.id === lessonId);
      notify(`Lesson ${lessonId} complete · +${lesson.reward} Stasis earned.`);
      onEarned?.();
    } catch (err) {
      notify(friendlyError(err), "error");
    } finally {
      setBusy(null);
    }
  }

  if (fetchErr) return <div className="notice error">Could not load the course: {fetchErr}</div>;
  if (!serverLessons) return <div className="loading">Loading the curriculum…</div>;

  const doneCount = progress?.lessons.filter((l) => l.done).length ?? 0;

  return (
    <div className="course">
      <h2>🎓 Cow-care academy</h2>
      <p className="muted">
        Every account starts at <strong>0 Stasis</strong> and works its way in. Read the lessons,
        pass the quizzes, and each finished lesson pays a one-time award you can stake, bond and
        vote with. The certified badge is a mark of skill — it never blocks anything.
      </p>

      {progress && (
        <div className="course-progress">
          <strong>{doneCount}</strong> of <strong>{serverLessons.length}</strong> lessons done
          {progress.certified && <span className="badge">✔ certified</span>}
          <div className="course-bar">
            <div
              className="course-bar-fill"
              style={{ width: `${(doneCount / serverLessons.length) * 100}%` }}
            />
          </div>
        </div>
      )}

      <div className="lesson-list">
        {serverLessons.map((l) => {
          const open = openId === l.id;
          const done = isDone(l.id);
          return (
            <div key={l.id} className={`lesson-card${open ? " open" : ""}`}>
              <button
                className="lesson-head"
                onClick={() => {
                  setOpenId(open ? null : l.id);
                  setAnswers({});
                }}
              >
                <span className="lesson-num">{l.id}</span>
                <span className="lesson-title">
                  {l.text.split("\n")[0].replace(/^#\s*(Lesson\s*\d+\s*—\s*)?/, "")}
                </span>
                {l.cert && <span className="chip">cert</span>}
                <span className="lesson-reward">+{l.reward}</span>
                {done && <span className="badge">done</span>}
                <span className="muted">{open ? "▲" : "▼"}</span>
              </button>

              {open && (
                <div className="lesson-body">
                  {l.pinned === false && (
                    <div className="lesson-pin">
                      This lesson was edited after it was last pinned on-chain, so its hash no
                      longer matches the pin. The owner re-pins with <code>npm run pin-lessons</code>.
                    </div>
                  )}
                  {/* Lesson markdown is simple enough to render as preformatted prose. */}
                  <pre className="lesson-text">{l.text}</pre>

                  {!done && (
                    <div className="quiz">
                      <h4>Quiz</h4>
                      {l.quiz.map((q) => (
                        <div key={q.index} className="quiz-q">
                          <div className="quiz-q-text">{q.q}</div>
                          {q.options.map((opt, oi) => (
                            <label key={oi} className="quiz-opt">
                              <input
                                type="radio"
                                name={`q-${l.id}-${q.index}`}
                                checked={answers[`${l.id}-${q.index}`] === oi}
                                onChange={() =>
                                  setAnswers((a) => ({ ...a, [`${l.id}-${q.index}`]: oi }))
                                }
                              />
                              <span>
                                {LETTERS[oi]}. {opt}
                              </span>
                            </label>
                          ))}
                        </div>
                      ))}
                      <button
                        className="primary"
                        disabled={busy === l.id}
                        onClick={() => submit(l.id)}
                      >
                        {busy === l.id ? "Grading…" : `Submit answers · earn +${l.reward}`}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

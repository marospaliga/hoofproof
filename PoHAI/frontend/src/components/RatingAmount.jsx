// How much rating to spend on one vote.
//
// A vote is rating spent, so the amount *is* the weight — there is no ladder
// of preset sizes and no opinion about what a "big" vote should be baked
// into the interface. What the rater gets instead is a handle to drag and a
// box to type in, both showing the same number: the slider for feel, the
// box for precision (17 rating is a perfectly good vote).
//
// The slider runs to the rating the account actually has free — committed
// rating cannot be spent twice, so there is nothing above that to offer. The
// track is curved rather than linear, because most votes are small: the
// bottom of the slider is fine-grained and the top still reaches everything
// you have.
import { useEffect, useState } from "react";

// Slider positions. The mapping from position to amount is quadratic:
// amount = max · (pos / TRACK)² — fine near zero, everything at the top.
const TRACK = 1000;

export default function RatingAmount({
  value,
  onChange,
  free = 0,
  disabled = false,
  compact = false,
}) {
  const [text, setText] = useState(value === undefined || value === null ? "" : String(value));
  const max = Math.max(0, Math.floor(Number(free) || 0));

  // Keep the box in step with the slider (and with a reset from the parent),
  // but never clobber what the user is typing: if the box already *is* the
  // new value, leave it alone.
  useEffect(() => {
    const parsed = Number(text);
    if (text !== "" && Number.isFinite(parsed) && Math.floor(parsed) === Number(value)) return;
    setText(value === undefined || value === null ? "" : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const amount = Math.max(0, Math.floor(Number(value) || 0));
  const clamped = Math.min(amount, max);
  const pos = max > 0 ? Math.min(TRACK, Math.round(TRACK * Math.sqrt(clamped / max))) : 0;
  const over = amount > max;

  function emit(n) {
    onChange(Math.max(0, Math.floor(Number(n) || 0)));
  }

  function type(e) {
    // Digits only: a vote is a whole number of rating points. Keeping it a
    // text input (not type=number) means the box never fights the browser
    // over a half-typed value.
    const raw = e.target.value.replace(/[^\d]/g, "");
    setText(raw);
    if (raw === "") return onChange(0);
    emit(Number(raw));
  }

  function drag(e) {
    const p = Number(e.target.value);
    emit(Math.round(max * Math.pow(p / TRACK, 2)));
  }

  const noRating = max === 0;

  return (
    <div className={`rate-amount${compact ? " compact" : ""}`}>
      <div className="rate-amount-row">
        <input
          className="rate-amount-input"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={text}
          disabled={disabled || noRating}
          onChange={type}
          placeholder="0"
          aria-label="rating to spend"
        />
        <span className="muted rate-amount-unit">rating</span>
      </div>
      <input
        className="rate-amount-slider"
        type="range"
        min="0"
        max={TRACK}
        step="1"
        value={pos}
        disabled={disabled || noRating}
        onChange={drag}
        aria-label="rating to spend, slider"
      />
      <div className="muted rate-amount-hint">
        {noRating ? (
          "no free rating to spend"
        ) : (
          <>
            spends <b>{amount}</b> of <b>{max}</b> free
            {over && <span className="warn-flag"> more than you have free</span>}
          </>
        )}
      </div>
    </div>
  );
}

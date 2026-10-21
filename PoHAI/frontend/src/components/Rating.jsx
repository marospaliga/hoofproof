// Rating drawn as five diamonds — one per fifth of the cow activation
// threshold (1000 rating points under the default policy). A fully-backed cow
// shines ◆◆◆◆◆; an unrated one shows ◇◇◇◇◇. Shared by the herd list, the cow
// detail rail and the profile so a rating looks the same everywhere.
export const RATING_THRESHOLD = 1000;

export function RatingDiamonds({ rating, threshold = RATING_THRESHOLD, title }) {
  const value = Number(rating);
  if (!Number.isFinite(value)) return null;
  const level = Math.ceil((value / threshold) * 5);
  const n = Math.max(0, Math.min(5, level));
  return (
    <span className="rate-diamonds" title={title} aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={i < n ? "dia on" : "dia"}>
          {i < n ? "◆" : "◇"}
        </span>
      ))}
    </span>
  );
}

export default RatingDiamonds;

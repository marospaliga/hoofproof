import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

// Trending = recent on-chain voice, tie-broken by lifetime rating. A display
// sort only — never a payout input (see server/METHODOLOGY.md).
export default function Trending({ cows, onOpen }) {
  const [trend, setTrend] = useState(null);

  useEffect(() => {
    api
      .trending()
      .then(setTrend)
      .catch(() => setTrend(null));
  }, []);

  if (!trend) {
    return <div className="muted">Loading recent field movement…</div>;
  }

  const byToken = new Map((cows || []).filter((c) => c.tokenId).map((c) => [Number(c.tokenId), c]));
  const rows = trend.rows.map((r) => ({ ...r, cow: byToken.get(Number(r.tokenId)) })).filter((r) => r.cow);
  if (rows.length === 0) {
    return <div className="muted">No on-chain voice yet — be the first to curate.</div>;
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>🔥 Trending</h2>
      <p className="muted" style={{ maxWidth: 640 }}>
        Cows ranked by recent voice (trailing block window), then lifetime rating. Fresh
        protection work surfaces; dormant records sink — without any downvotes.
      </p>
      {rows.map((r) => (
        <div key={r.tokenId} className="panel mt12">
          <div className="inline" style={{ justifyContent: "space-between", width: "100%" }}>
            <strong>
              {r.cow.image || "🐄"} {r.cow.name}{" "}
              <span className={`badge status-${r.cow.statusName}`}>{r.cow.statusName}</span>
            </strong>
            <span className="muted" style={{ fontSize: 12 }}>
              recent +{r.recent} · rating {r.rating} · backing {r.backing}
            </span>
          </div>
          <div className="row mt12">
            <button className="primary" onClick={() => onOpen(r.cow)}>
              Open
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

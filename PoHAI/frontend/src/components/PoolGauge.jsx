import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

// Overall rating-pool indicator — the whole field's health at a glance. It
// reads the server's /api/pool endpoint (live from the pool contract), so it
// works identically in the main app and the simulator. Framed as protection
// performance, never as yield: every number traces back to real cow care.
export default function PoolGauge({ compact = false }) {
  const [pool, setPool] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .pool()
        .then((p) => alive && setPool(p))
        .catch((e) => alive && setErr(e.message));
    load();
    const t = setInterval(load, 6000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (err) return <div className="pool-gauge error">pool: {err}</div>;
  if (!pool) return <div className="pool-gauge muted">pool…</div>;

  const rows = [
    ["backed", pool.backedCows],
    ["rating", pool.rating],
    ["backing", pool.backing],
    ["stasis", pool.totalScore],
    ["labor", `${pool.laborHours}h`],
    ["quorums", pool.careQuorums],
    ["covered", pool.covered],
  ];

  if (compact) {
    return (
      <div className="pool-gauge compact" title="Whole-field rating pool">
        <span className="pool-dot" />
        {rows.map(([k, v]) => (
          <span key={k} className="pool-cell">
            <em>{k}</em> {v}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="pool-gauge">
      <div className="pool-title"> Whole-field rating pool</div>
      <div className="pool-grid">
        {rows.map(([k, v]) => (
          <div key={k} className="pool-item">
            <div className="pool-value">{v}</div>
            <div className="pool-label">{k}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

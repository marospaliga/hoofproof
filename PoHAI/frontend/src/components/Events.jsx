import { useEffect, useState } from "react";
import { fmtEth } from "./CowDetail.jsx";
import Name from "./Name.jsx";
import { api } from "../lib/api.js";
import {
  createFundEvent,
  contributeEvent,
  spendEvent,
  closeEventAction,
  settleCycle,
  listFundEvents,
  cycleState,
  friendlyError,
} from "../lib/chain.js";

// GoFundMe-style charitable causes. The money lives on-chain (escrowed in the
// GeneralPool); this view layers the human prose on top. Backers earn *no*
// instant rating — only a pro-rata share of the next cycle's credit, which is
// sized by how much the whole field moved.
export default function Events({ contracts, account, notify }) {
  const [events, setEvents] = useState([]);
  const [metas, setMetas] = useState([]);
  const [cycle, setCycle] = useState(null);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [goal, setGoal] = useState("");
  const [amounts, setAmounts] = useState({});
  const [spends, setSpends] = useState({});
  const [busy, setBusy] = useState("");

  async function reload() {
    if (!contracts) return;
    try {
      const [evs, cs] = await Promise.all([listFundEvents(contracts), cycleState(contracts)]);
      setEvents(evs);
      setCycle(cs);
    } catch {
      // forgot the 404 case — leave stale state
    }
  }

  useEffect(() => {
    api
      .listEvents()
      .then(setMetas)
      .catch(() => {});
  }, []);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contracts]);

  const metaOf = (id) => metas.find((m) => Number(m.eventId) === id);

  async function run(label, fn) {
    setBusy(label);
    try {
      const out = await fn();
      notify(`${label} done.`);
      await reload();
      return out;
    } catch (err) {
      notify(friendlyError(err), "error");
      return null;
    } finally {
      setBusy("");
    }
  }

  async function create(e) {
    e.preventDefault();
    if (!title.trim() || !goal) return;
    const goalWei = (BigInt(Math.round(Number(goal) * 1e18))).toString();
    const cid = `ipfs://event-${Date.now().toString(16)}`;
    const id = await run("Create event", () => createFundEvent(contracts, cid, goalWei));
    if (id !== null) {
      await api.createEventMeta({ eventId: id, title: title.trim(), description: desc.trim(), goal: goalWei });
      await api.logActivity(account, "event-create", `Opened a cause: ${title.trim()}`);
      setTitle("");
      setDesc("");
      setGoal("");
    }
  }

  async function contribute(id) {
    const val = amounts[id];
    if (!val || Number(val) <= 0) return;
    const wei = (BigInt(Math.round(Number(val) * 1e18))).toString();
    await run("Contribute", () => contributeEvent(contracts, id, wei));
    await api.logActivity(account, "event-back", metaOf(id)?.title ? `Backed “${metaOf(id).title}” (${val} ETH)` : `Backed cause #${id}`);
    setAmounts({ ...amounts, [id]: "" });
  }

  async function spend(id) {
    const val = spends[id];
    if (!val || Number(val) <= 0) return;
    const wei = (BigInt(Math.round(Number(val) * 1e18))).toString();
    await run("Release funds", () => spendEvent(contracts, id, wei, account));
    await api.logActivity(account, "event-spend", `Released ${val} ETH from cause #${id}`);
    setSpends({ ...spends, [id]: "" });
  }

  async function close(id) {
    await run("Close", () => closeEventAction(contracts, id));
  }

  async function settle() {
    await run("Settle cycle", () => settleCycle(contracts));
    await api.logActivity(account, "cycle-settle", "Settled the movement cycle");
  }

  const now = Date.now() / 1000;
  const primed = cycle && cycle.lastAt > 0;
  const elapsed = primed ? now - cycle.lastAt : 0;
  const ready = primed && elapsed >= cycle.period;

  return (
    <div>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>The movement cycle 🎗️</h3>
        <div className="muted" style={{ fontSize: 13, maxWidth: 720 }}>
          Every <b>{cycle ? Math.round(cycle.period / 3600) : "?"} h</b> the pool measures how
          much the whole field moved — growth in rated backing, rating points, active cows and
          Rajas — and mints a credit pool of <b>{cycle ? cycle.ratio / 100 : "?"}×</b> that
          movement (capped at {cycle ? cycle.cap : "?"} pts). The pool is split{" "}
          <b>{cycle ? cycle.share / 100 : "?"}% to backers</b> (pro rata by contribution) and{" "}
          <b>{cycle ? (100 - cycle.share / 100) : "?"}% to active raters</b> (pro rata by
          activity). <b>Nobody can buy rating: a donation only earns a share of the pool when
          the field actually moved.</b>
        </div>

        {cycle && (
          <div className="stats mt12" style={{ marginTop: 12 }}>
            <div className="stat">
              <div className="k">Last settlement</div>
              <div className="v">
                {cycle.movement > 0 || cycle.credit > 0
                  ? `field moved ${cycle.movement} → ${cycle.credit} pts credit`
                  : cycle.lastAt
                    ? "primed (baseline)"
                    : "never"}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {cycle.lastAt ? new Date(cycle.lastAt * 1000).toLocaleString() : "—"}
              </div>
            </div>
            <div className="stat">
              <div className="k">Split</div>
              <div className="v">
                🎁 {cycle.backerShare} · 🤝 {cycle.raterShare}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                to {cycle.backers} backer{cycle.backers === 1 ? "" : "s"} &amp; {cycle.raters} rater
                {cycle.raters === 1 ? "" : "s"}
              </div>
            </div>
            <div className="stat">
              <div className="k">Next settle</div>
              <div className="v">
                {!primed
                  ? "first settle primes"
                  : ready
                    ? "ready now"
                    : `${Math.max(0, cycle.period - Math.floor(elapsed))}s left`}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {cycle.raised > 0 ? `${fmtEth(cycle.raised)} in this cycle` : "no contributions yet"}
              </div>
            </div>
          </div>
        )}

        <div className="row mt12">
          <button className="primary" disabled={!contracts || !!busy} onClick={settle}>
            {busy === "Settle cycle" ? "…" : "🎗️ Settle cycle"}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            Anyone may settle — like the platform snapshot, it is the "chess clock".
          </span>
        </div>
      </div>

      <form onSubmit={create} className="panel mt12">
        <h3 style={{ marginTop: 0 }}>Open a cause for a cow 💛</h3>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          E.g. winter bedding, a new stable, a vet truck. Contributions are escrowed on-chain and
          released by you (the creator) to whoever does the real-world work.
        </div>
        <div className="row">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title — e.g. Winter bedding for Hans" style={{ minWidth: 240 }} />
          <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Goal in ETH" type="number" step="0.01" style={{ width: 120 }} />
        </div>
        <div className="row mt12">
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Why does the herd need this?" />
          <button className="primary" type="submit" disabled={!title.trim() || !goal || !!busy || !account}>
            {busy === "Create event" ? "…" : "Open cause"}
          </button>
        </div>
      </form>

      <h3>The causes</h3>
      {events.length === 0 && (
        <div className="muted" style={{ fontSize: 13 }}>
          No causes on-chain yet. Open one above 🐄
        </div>
      )}

      {events.map((e) => {
        const meta = metaOf(e.id);
        const pct = e.goal > 0 ? Math.min(100, Math.round((Number(e.raised) / Number(e.goal)) * 100)) : 0;
        return (
          <div key={e.id} className="panel mt12">
            <div className="inline" style={{ justifyContent: "space-between", width: "100%" }}>
              <h3 style={{ margin: 0 }}>
                {meta?.image || "🎁"} {meta?.title || `Cause #${e.id}`}
                {e.closed && <span className="badge">closed</span>}
              </h3>
              <span className="muted" style={{ fontSize: 12 }}>
                by <Name address={e.creator} />
              </span>
            </div>
            {meta?.description && <p className="muted mt4">{meta.description}</p>}
            <div className="row mt12" style={{ alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <span className="v" style={{ fontSize: 18 }}>{fmtEth(e.raised)}</span>
              <span className="muted">raised of {fmtEth(e.goal)} goal</span>
              <div style={{ flex: 1, minWidth: 140 }}>
                <div className="meter">
                  <div className="meter-fill" style={{ width: `${pct}%` }} />
                </div>
              </div>
              <span className="muted" style={{ fontSize: 12 }}>{pct}%</span>
            </div>

            {!e.closed && (
              <div className="row mt12" style={{ gap: 8, flexWrap: "wrap" }}>
                <input
                  value={amounts[e.id] || ""}
                  onChange={(ev) => setAmounts({ ...amounts, [e.id]: ev.target.value })}
                  placeholder="ETH to back"
                  type="number"
                  step="0.01"
                  style={{ width: 120 }}
                />
                <button disabled={!amounts[e.id] || !!busy || !account} onClick={() => contribute(e.id)}>
                  {busy === "Contribute" ? "…" : "💛 Back this cause"}
                </button>
                {account && e.creator.toLowerCase() === account.toLowerCase() && (
                  <>
                    <input
                      value={spends[e.id] || ""}
                      onChange={(ev) => setSpends({ ...spends, [e.id]: ev.target.value })}
                      placeholder="Release ETH"
                      type="number"
                      step="0.01"
                      style={{ width: 110 }}
                    />
                    <button disabled={!spends[e.id] || !!busy} onClick={() => spend(e.id)}>
                      {busy === "Release funds" ? "…" : "Release to me"}
                    </button>
                    <button disabled={!!busy} onClick={() => close(e.id)}>Close</button>
                  </>
                )}
              </div>
            )}
            {e.closed && (
              <div className="muted mt12" style={{ fontSize: 12 }}>
                Closed — {fmtEth(e.spent)} released toward the goal.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
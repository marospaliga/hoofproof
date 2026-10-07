import { useState } from "react";
import { fmtDate, shortAddr } from "../config.js";
import { api } from "../lib/api.js";
import { stake, unstake, boost, transferCow, attestDeath, attestFundingNeed } from "../lib/chain.js";

function Threads({ cow, account, refresh, notify }) {
  const [title, setTitle] = useState("");
  const [posts, setPosts] = useState({}); // threadId -> draft text

  async function newThread(e) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      await api.createThread(cow.cid, title.trim(), shortAddr(account));
      setTitle("");
      notify("Thread opened.");
      refresh();
    } catch (err) {
      notify(err.message, "error");
    }
  }

  async function newPost(tid, text) {
    if (!text.trim()) return;
    try {
      await api.createPost(cow.cid, tid, text.trim(), shortAddr(account));
      setPosts({ ...posts, [tid]: "" });
      notify("Post added.");
      refresh();
    } catch (err) {
      notify(err.message, "error");
    }
  }

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Discussion</h3>

      <form onSubmit={newThread}>
        <label htmlFor="t">Open a thread about this cow</label>
        <div className="row">
          <input
            id="t"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Has anyone weighed Blossom lately?"
          />
          <button className="primary" type="submit">Open</button>
        </div>
      </form>

      {(cow.threads || []).map((thread) => (
        <div key={thread.id} className="thread">
          <h4>{thread.title}</h4>
          <div className="muted" style={{ fontSize: 12 }}>opened {fmtDate(thread.createdAt)}</div>
          {thread.posts.map((post) => (
            <div key={post.id} className="post">
              <div className="meta">{post.author} · {fmtDate(post.createdAt)}</div>
              <div className="body">{post.text}</div>
            </div>
          ))}
          <div className="row mt12">
            <input
              value={posts[thread.id] || ""}
              onChange={(e) => setPosts({ ...posts, [thread.id]: e.target.value })}
              placeholder="Add to the discussion…"
            />
            <button onClick={() => newPost(thread.id, posts[thread.id] || "")}>Post</button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function CowDetail({ cow, contracts, account, rep, onBack, refresh, notify }) {
  const [amount, setAmount] = useState("");
  const [bps, setBps] = useState(1000);
  const [toAddr, setToAddr] = useState("");
  const [busy, setBusy] = useState("");

  const tokenId = cow.tokenId;

  async function run(label, fn) {
    setBusy(label);
    try {
      await fn();
      notify(`${label} done.`);
      await refresh();
    } catch (err) {
      notify(err.shortMessage || err.message, "error");
    } finally {
      setBusy("");
    }
  }

  return (
    <div>
      <button onClick={onBack}>← Herd</button>
      <div className="mt12 panel">
        <div className="grid-2">
          <div>
            <div style={{ fontSize: 52 }}>{cow.image || "🐄"}</div>
            <h2 style={{ margin: "6px 0" }}>
              {cow.name}{" "}
              <span className={`badge status-${cow.statusName}`}>{cow.statusName}</span>
            </h2>
            <div className="muted">
              {cow.breed}
              {cow.age ? ` · ${cow.age} years` : ""} · {shortAddr(cow.onChainOwner)}
            </div>
            {cow.story && <p className="mt12">{cow.story}</p>}
          </div>

          <div>
            <div className="stats">
              <div className="stat">
                <div className="k">Rating</div>
                <div className="v">{cow.rating}</div>
              </div>
              <div className="stat">
                <div className="k">Rated backing</div>
                <div className="v">{cow.backing}</div>
              </div>
              <div className="stat">
                <div className="k">Funding need / period</div>
                <div className="v">{cow.fundingNeed}</div>
              </div>
              <div className="stat">
                <div className="k">Your Stasis</div>
                <div className="v">{rep.score}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  free {Math.max(rep.score - rep.bonded, 0)} · bonded {rep.bonded}
                </div>
              </div>
            </div>

            <div className="actions">
              <button
                className="primary"
                disabled={!amount || busy}
                onClick={() => run("Stake", () => stake(contracts, tokenId, amount))}
              >
                {busy === "Stake" ? "…" : "Stake rating"}
              </button>
              <button
                disabled={!amount || busy}
                onClick={() => run("Unstake", () => unstake(contracts, tokenId, amount))}
              >
                {busy === "Unstake" ? "…" : "Unstake"}
              </button>
              <select value={bps} onChange={(e) => setBps(Number(e.target.value))} style={{ width: "auto" }}>
                <option value={100}>boost 1%</option>
                <option value={500}>boost 5%</option>
                <option value={1000}>boost 10%</option>
              </select>
              <button
                disabled={busy}
                onClick={() => run("Boost", () => boost(contracts, tokenId, bps))}
              >
                {busy === "Boost" ? "…" : "👍 Boost"}
              </button>
              <button
                disabled={busy}
                onClick={() => run("Report funded", () => attestFundingNeed(contracts, tokenId, 0))}
              >
                {busy === "Report funded" ? "…" : "Report need 0"}
              </button>
              <button
                className="danger"
                disabled={busy}
                onClick={() => run("Report death", () => attestDeath(contracts, tokenId))}
              >
                {busy === "Report death" ? "…" : "Report death"}
              </button>
            </div>

            <div className="mt12">
              <label htmlFor="amt">Rating amount</label>
              <input
                id="amt"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="e.g. 200"
                type="number"
                min="1"
              />
              {["stake", "unstake"].includes(busy.toLowerCase()) ? (
                <div className="muted mt4" style={{ fontSize: 12 }}>
                  Waiting for the transaction… (cancel it in MetaMask to abort)
                </div>
              ) : null}
            </div>

            <div className="mt12">
              <label htmlFor="to">Transfer to (must own rating)</label>
              <div className="row">
                <input
                  id="to"
                  value={toAddr}
                  onChange={(e) => setToAddr(e.target.value)}
                  placeholder="0x…"
                />
                <button
                  disabled={!toAddr || busy}
                  onClick={() => run("Transfer", () => transferCow(contracts, tokenId, toAddr, account))}
                >
                  {busy === "Transfer" ? "…" : "Transfer"}
                </button>
              </div>
              <div className="muted mt4" style={{ fontSize: 12 }}>
                Transfers spend your rating — money alone cannot move a cow.
              </div>
            </div>

            <div className="muted mt12" style={{ fontSize: 12 }}>
              Funding records accept one update per 30-day period. Reporting a
              lower need credits the solver with 10% of the reduction.
            </div>
          </div>
        </div>
      </div>

      <Threads cow={cow} account={account} refresh={refresh} notify={notify} />
    </div>
  );
}
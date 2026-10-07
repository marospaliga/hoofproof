import { useState } from "react";
import { fmtDate, shortAddr } from "../config.js";
import { api } from "../lib/api.js";
import {
  stake,
  unstake,
  boost,
  voteContent,
  contentHash,
  transferCow,
  attestDeath,
  attestFundingNeed,
  attestLabor,
  convertSattvaToRajas,
  convertRajasToSattva,
  claimGasRebate,
  proposeCouncil,
  councilVote,
  councilFinalize,
  friendlyError,
} from "../lib/chain.js";

export function fmtEth(wei) {
  return wei ? (Number(wei) / 1e18).toFixed(3) + " ETH" : "—";
}

// The council of this cow's herd, listed on-chain. Only herd members (cow
// owners) may propose and vote — weight = rating of the member's cows in the
// herd × their momentum.
function CouncilPanel({ tokenId, herdId, contracts, account, notify }) {
  const [proposals, setProposals] = useState(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState("");

  async function reload() {
    if (!contracts) return;
    try {
      const next = Number(await contracts.herdCouncil.nextProposalId());
      const rows = [];
      for (let id = 1; id < next; id++) {
        const p = await contracts.herdCouncil.proposals(id);
        if (Number(p.herdId) !== herdId) continue;
        rows.push({
          id: Number(p.id),
          hash: p.hash,
          forVotes: Number(p.forVotes),
          againstVotes: Number(p.againstVotes),
          endsAt: Number(p.endsAt),
          executed: p.executed,
        });
      }
      setProposals(rows);
    } catch {
      setProposals([]);
    }
  }

  if (proposals === null && contracts) reload();

  async function propose(e) {
    e.preventDefault();
    if (!draft.trim()) return;
    setBusy("Propose");
    try {
      await proposeCouncil(contracts, herdId, draft.trim(), 3);
      notify("Council proposal pinned on-chain. Members can now vote.");
      setDraft("");
      reload();
    } catch (err) {
      notify(friendlyError(err), "error");
    } finally {
      setBusy("");
    }
  }

  async function vote(id, support) {
    setBusy("vote" + id);
    try {
      await councilVote(contracts, id, support);
      notify("Vote cast (weight = your cows' rating × momentum).");
      reload();
    } catch (err) {
      notify(friendlyError(err), "error");
    } finally {
      setBusy("");
    }
  }

  async function finalize(id) {
    setBusy("fin" + id);
    try {
      await councilFinalize(contracts, id);
      notify("Proposal tallied. The council's signal has been recorded.");
      reload();
    } catch (err) {
      notify(friendlyError(err), "error");
    } finally {
      setBusy("");
    }
  }

  const open = (p) => !p.executed && Date.now() / 1000 < p.endsAt;
  const decided = (p) => p.executed;

  return (
    <div className="panel mt12">
      <h3 style={{ marginTop: 0 }}>HerdCouncil · herd {herdId}</h3>
      {!account ? (
        <div className="muted" style={{ fontSize: 13 }}>
          Connect a wallet to propose or vote. Proposals live off-chain as draft
          text; only its hash goes on-chain.
        </div>
      ) : (
        <form onSubmit={propose} className="row mt12">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Proposal text (hashed on-chain)…"
          />
          <button className="primary" type="submit" disabled={busy === "Propose" || !draft.trim()}>
            {busy === "Propose" ? "…" : "Propose"}
          </button>
        </form>
      )}

      {proposals && proposals.length === 0 && (
        <div className="muted mt12" style={{ fontSize: 13 }}>
          No proposals for this herd yet.
        </div>
      )}

      {proposals?.map((p) => (
        <div key={p.id} className="thread">
          <div className="meta">
            proposal #{p.id} · votes {p.forVotes} for / {p.againstVotes} against
            {open(p) ? ` · closes ${new Date(p.endsAt * 1000).toLocaleDateString()}` : ""}
            {decided(p) ? " · decided" : ""}
          </div>
          <div className="body" style={{ wordBreak: "break-all" }}>{p.hash.slice(0, 26)}…</div>
          <div className="row mt12">
            {open(p) ? (
              <>
                <button disabled={!!busy || !account} onClick={() => vote(p.id, true)}>
                  {busy === "vote" + p.id ? "…" : "👍 Support"}
                </button>
                <button disabled={!!busy || !account} onClick={() => vote(p.id, false)}>
                  {busy === "vote" + p.id ? "…" : "👎 Against"}
                </button>
                <button disabled={!!busy || !account} onClick={() => finalize(p.id)}>
                  {busy === "fin" + p.id ? "…" : "Finalize"}
                </button>
              </>
            ) : (
              <span className="muted" style={{ fontSize: 12 }}>
                {p.forVotes > p.againstVotes ? "✓ passed" : "✗ rejected"}
              </span>
            )}
          </div>
        </div>
      ))}

      <div className="muted mt12" style={{ fontSize: 12 }}>
        Voting weight = the rating of each cow <i>you own</i> in this herd × your
        momentum. Money never votes; reputation does.
      </div>
    </div>
  );
}

function PostThumb({ tokenId, post, contracts, account, notify, refresh }) {
  const [rating, setRating] = useState(null);
  const [forHash, setForHash] = useState(null);
  const [busy, setBusy] = useState(false);

  const hash = contentHash("post:" + post.id);

  // Load the on-chain rating for the current content, and reload whenever the
  // user switches to a different cow's discussion (hash changes).
  if (hash !== forHash) {
    setForHash(hash);
    if (!contracts) {
      setRating(null);
    } else {
      contracts.cowRating
        .contentRatingOf(tokenId, 2, hash)
        .then((r) => setRating(Number(r)))
        .catch(() => setRating(0));
    }
  }

  async function thumb() {
    if (!account) return notify("Connect a wallet to rate posts.", "error");
    setBusy(true);
    try {
      await voteContent(contracts, tokenId, 2, hash, 1000);
      setRating((rating || 0) + 1);
      notify("Post rated — the weight adds to the cow's authenticity.");
      refresh();
    } catch (err) {
      notify(friendlyError(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      className="thumb"
      disabled={busy || !contracts}
      onClick={thumb}
      title="Thumbs-up this post: the verified weight (rating × momentum) is added to the cow."
    >
      👍 {rating ?? "…"}
    </button>
  );
}

function Threads({ cow, contracts, account, refresh, notify }) {
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
              <div className="meta">
                {post.author} · {fmtDate(post.createdAt)}
                <PostThumb
                  tokenId={cow.tokenId}
                  post={post}
                  contracts={contracts}
                  account={account}
                  notify={notify}
                  refresh={refresh}
                />
              </div>
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
  const [hours, setHours] = useState("");
  const [rajasAmount, setRajasAmount] = useState("");
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
      notify(friendlyError(err), "error");
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
                <div className="k">Care pool</div>
                <div className="v">{fmtEth(cow.carePool)}</div>
              </div>
              <div className="stat">
                <div className="k">Funding need / period</div>
                <div className="v">{cow.fundingNeed}</div>
              </div>
            </div>

            <div className="stats">
              <div className="stat">
                <div className="k">Your Stasis</div>
                <div className="v">{rep.score}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  free {Math.max(rep.score - rep.bonded, 0)} · bonded {rep.bonded}
                </div>
              </div>
              <div className="stat">
                <div className="k">Voting power</div>
                <div className="v">{contracts ? (rep.votingPower / 100).toFixed(0) + "%" : "—"}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  refills ~24h
                </div>
              </div>
              <div className="stat">
                <div className="k">Momentum</div>
                <div className="v">{contracts ? (rep.momentum / 100).toFixed(2) + "×" : "—"}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {contracts && rep.momentum > 10_000
                    ? "gas-subsidy eligible"
                    : "stays active to qualify"}
                </div>
              </div>
              <div className="stat">
                <div className="k">Rajas</div>
                <div className="v">{contracts ? rep.rajas : "—"}</div>
                <div className="muted" style={{ fontSize: 12 }}>action credits</div>
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
                <option value={100}>thumb 1%</option>
                <option value={500}>thumb 5%</option>
                <option value={1000}>thumb 10%</option>
              </select>
              <button
                disabled={busy}
                onClick={() => run("Thumbs up", () => boost(contracts, tokenId, bps))}
              >
                {busy === "Thumbs up" ? "…" : "👍 Thumbs up"}
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
              <button
                disabled={busy || !account}
                onClick={() => run("Claim gas rebate", () => claimGasRebate(contracts))}
              >
                {busy === "Claim gas rebate" ? "…" : "⛽ Claim gas rebate"}
              </button>
            </div>

            <div className="muted mt12" style={{ fontSize: 12 }}>
              Every 👍 spends 20% of your voting power (refills over ~24h) and
              weighs <b>(score × share) × momentum</b>. Posts in the discussion
              carry the same mechanic.
            </div>

            {rep.score === 0 && (
              <div
                className="muted mt12"
                style={{ fontSize: 13, border: "1px dashed var(--border)", padding: 8, borderRadius: 8 }}
              >
                Your wallet has no Stasis yet, so the rating actions above will be
                declined by the contract. This demo seeds <b>20 000 score to the six
                demo raters</b> — hardhat accounts <b>#1 to #6</b>, printed when the
                node starts. Switch MetaMask to one of those accounts to stake,
                boost or transfer.
              </div>
            )}

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

            <div className="mt12 panel inset">
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                💪 Sweat equity — report real care work. The attestation is
                self-reported and needs one other rater to reach quorum; the
                reward = hours × base rate × (this cow's rating / reference).
              </div>
              <div className="row">
                <input
                  value={hours}
                  onChange={(e) => setHours(e.target.value)}
                  placeholder="hours (e.g. 40)"
                  type="number"
                  min="1"
                />
                <button
                  disabled={!hours || busy || !account}
                  onClick={() =>
                    run("Report work", () => attestLabor(contracts, tokenId, hours, account))
                  }
                >
                  {busy === "Report work" ? "…" : "🎯 Report my work"}
                </button>
              </div>
            </div>

            <div className="mt12 panel inset">
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                🏅 Rajas — spendable action credits. Convert influence in either
                direction (Rajas→Sattva is capped at 10% of your score per step).
              </div>
              <div className="row">
                <input
                  value={rajasAmount}
                  onChange={(e) => setRajasAmount(e.target.value)}
                  placeholder="amount"
                  type="number"
                  min="1"
                />
                <button
                  disabled={!rajasAmount || busy || !account}
                  onClick={() =>
                    run("Convert", () => convertSattvaToRajas(contracts, rajasAmount))
                  }
                >
                  {busy === "Convert" ? "…" : "Sattva → Rajas"}
                </button>
                <button
                  disabled={!rajasAmount || busy || !account}
                  onClick={() =>
                    run("Convert", () => convertRajasToSattva(contracts, rajasAmount))
                  }
                >
                  {busy === "Convert" ? "…" : "Rajas → Sattva"}
                </button>
              </div>
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

      {cow.herdId > 0 && (
        <CouncilPanel
          tokenId={tokenId}
          herdId={cow.herdId}
          contracts={contracts}
          account={account}
          notify={notify}
        />
      )}

      <Threads cow={cow} contracts={contracts} account={account} refresh={refresh} notify={notify} />
    </div>
  );
}
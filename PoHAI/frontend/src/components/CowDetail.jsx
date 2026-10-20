import { useEffect, useRef, useState } from "react";
import { fmtDate, shortAddr } from "../config.js";
import { api } from "../lib/api.js";
import Name from "./Name.jsx";
import {
  stake,
  unstake,
  boost,
  voteContent,
  registerContent,
  unvote,
  previewVote,
  voiceLocks,
  proposeModeration,
  challengeModeration,
  executeModeration,
  contentHash,
  sha256Hex,
  signMessage,
  transferCow,
  attestDeath,
  attestFundingNeed,
  attestLabor,
  proposeCouncil,
  councilVote,
  councilFinalize,
  redeemCare,
  careStatus,
  setLaborCommitBps,
  laborCommitBps,
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

// Moderation case for one anchored photo/post: propose → challenge → execute.
// Hides are reversible visibility flags (files stay); the chain holds proof.
function ModerationPanel({ tokenId, kind, cidHash, contracts, account, notify, onResolved }) {
  const [itemKey, setItemKey] = useState(null);
  const [openId, setOpenId] = useState(undefined);
  const [lastId, setLastId] = useState(0);
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState("");

  async function reload() {
    if (!contracts?.moderation) return;
    try {
      const key = await contracts.cowRating.contentKeyOf(tokenId, kind, cidHash);
      setItemKey(key);
      const id = Number(await contracts.moderation.openProposal(key));
      setOpenId(id);
      if (id > 0) {
        setLastId(id);
        setInfo(await api.moderationInfo(id));
      } else {
        setInfo(null);
      }
    } catch {
      setOpenId(0);
    }
  }

  if (openId === undefined && contracts?.moderation) reload();

  async function act(label, fn) {
    setBusy(label);
    try {
      await fn();
      notify(`${label} done.`);
      await reload();
      if (onResolved) onResolved();
    } catch (err) {
      notify(friendlyError(err), "error");
    } finally {
      setBusy("");
    }
  }

  async function propose(action) {
    await act(action === 0 ? "Hide proposed" : "Restore proposed", async () => {
      await proposeModeration(contracts, tokenId, itemKey, action);
    });
  }

  async function execute(id) {
    await act("Case executed", async () => {
      await executeModeration(contracts, id);
      await api.applyModeration(id);
    });
  }

  if (!contracts?.moderation) return null;
  if (openId === undefined) return <span className="muted" style={{ fontSize: 12 }}>loading cases…</span>;

  if (!info) {
    return (
      <div className="row" style={{ gap: 6 }}>
        {lastId > 0 && <span className="muted" style={{ fontSize: 12 }}>last case #{lastId} decided —</span>}
        <button className="thumb" disabled={!account || !!busy} onClick={() => propose(0)} title="Propose hiding this item (reversible, decided by reputation weight)">
          {busy ? "…" : "⚖️ propose hide"}
        </button>
      </div>
    );
  }

  const total = info.forWeight + info.againstWeight;
  const forPct = total > 0 ? Math.round((info.forWeight / total) * 100) : 100;
  return (
    <div className="mt4" style={{ fontSize: 12 }}>
      <div className="muted">
        case #{info.id} {info.action === 0 ? "hide" : "restore"} · {forPct}% for
        ({info.votersFor}v) · {100 - forPct}% keep ({info.votersAgainst}v)
        {info.dominant ? " · decisive" : ""}
      </div>
      <div className="meter mt4">
        <div className="meter-fill" style={{ width: `${forPct}%` }} />
      </div>
      <div className="row mt4" style={{ gap: 6 }}>
        <button className="thumb" disabled={!account || !!busy} onClick={() => act("Challenge counted", () => challengeModeration(contracts, info.id, true))}>
          👍 remove
        </button>
        <button className="thumb" disabled={!account || !!busy} onClick={() => act("Challenge counted", () => challengeModeration(contracts, info.id, false))}>
          ✋ keep
        </button>
        <button className="thumb" disabled={!account || !!busy || !info.executableNow} onClick={() => execute(info.id)} title={info.executableNow ? "Timelock passed — apply the outcome" : "Timelock still running"}>
          {busy ? "…" : "⚖️ execute"}
        </button>
      </div>
    </div>
  );
}

function PostThumb({ tokenId, post, contracts, account, notify, refresh }) {
  const [rating, setRating] = useState(null);
  const [forHash, setForHash] = useState(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [dormant, setDormant] = useState(false);

  const hash = contentHash("post:" + post.id);
  const author = post.authorAddress || null;
  const [showMod, setShowMod] = useState(false);
  const [earned, setEarned] = useState(0);

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
      if (account) {
        previewVote(contracts, account, 2, 1000)
          .then(setPreview)
          .catch(() => setPreview(null));
      }
      api
        .contentInfo(hash)
        .then((c) => {
          setDormant(c.registered && !c.active);
          setEarned(c.authorEarned || 0);
        })
        .catch(() => {});
    }
  }

  async function thumb() {
    if (!account) return notify("Connect a wallet to rate posts.", "error");
    setBusy(true);
    try {
      await voteContent(contracts, tokenId, 2, hash, 1000, author);
      setRating((rating || 0) + 1);
      notify(
        preview
          ? `Post rated +${preview.weight} to the cow${preview.authorAward ? `, +${preview.authorAward} to the author` : ""}${preview.dilutes ? " (dilutes your oldest locks — voice is zero-sum)" : ""}.`
          : "Post rated — the weight adds to the cow's authenticity."
      );
      refresh();
    } catch (err) {
      notify(friendlyError(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <span className="inline" style={{ gap: 4 }}>
        <button
          className="thumb"
          disabled={busy || !contracts}
          onClick={thumb}
          title={
            preview
              ? `Voice budget ${preview.locked}/${preview.budget}; this vote locks ${preview.weight}${earned ? ` · by trusted documenter (+${earned})` : ""}`
              : "Thumbs-up this post: the verified weight (rating × momentum) is added to the cow."
          }
        >
          👍 {rating ?? "…"}
        </button>
        <button className="thumb" disabled={!contracts} onClick={() => setShowMod(!showMod)} title="Moderation case for this post">
          ⚖️
        </button>
        {dormant && (
          <span className="muted" style={{ fontSize: 11 }} title="No votes or heartbeats inside the dormancy window">
            dormant
          </span>
        )}
      </span>
      {showMod && (
        <ModerationPanel tokenId={tokenId} kind={2} cidHash={hash} contracts={contracts} account={account} notify={notify} onResolved={refresh} />
      )}
    </>
  );
}

// Thumbs for an uploaded evidence file (kind 1 = Image in the VoteKind enum).
// The signature-verification happened at upload time; rating it is simply
// rating authentic documentation of the cow.
function EvidenceThumb({ tokenId, ev, contracts, account, notify, refresh }) {
  const [rating, setRating] = useState(null);
  const [forHash, setForHash] = useState(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);

  const hash = contentHash("evidence:" + ev.hash);
  const [showMod, setShowMod] = useState(false);
  const [earned, setEarned] = useState(0);

  if (hash !== forHash) {
    setForHash(hash);
    if (!contracts) {
      setRating(null);
    } else {
      contracts.cowRating
        .contentRatingOf(tokenId, 1, hash)
        .then((r) => setRating(Number(r)))
        .catch(() => setRating(0));
      if (account) {
        previewVote(contracts, account, 1, 1000)
          .then(setPreview)
          .catch(() => setPreview(null));
      }
      api
        .contentInfo(hash)
        .then((c) => setEarned(c.authorEarned || 0))
        .catch(() => {});
    }
  }

  async function thumb() {
    if (!account) return notify("Connect a wallet to rate evidence.", "error");
    setBusy(true);
    try {
      await voteContent(contracts, tokenId, 1, hash, 1000, ev.uploader || null);
      setRating((rating || 0) + 1);
      notify(
        preview
          ? `Evidence rated +${preview.weight} authenticity${preview.authorAward ? `, +${preview.authorAward} to the documenter` : ""}${preview.dilutes ? " (dilutes your oldest locks)" : ""}.`
          : "Evidence rated — authenticity feeds the cow's rating."
      );
      await api.logActivity(account, "evidence-thumb", "Rated an evidence file");
      refresh();
    } catch (err) {
      notify(friendlyError(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <span className="inline" style={{ gap: 4 }}>
        <button
          className="thumb"
          disabled={busy || !contracts}
          onClick={thumb}
          title={
            preview
              ? `Voice budget ${preview.locked}/${preview.budget}; this vote locks ${preview.weight}${earned ? ` · by trusted documenter (+${earned})` : ""}`
              : "Thumbs-up this evidence file: the verified weight is added to the cow."
          }
        >
          👍 {rating ?? "…"}
        </button>
        <button className="thumb" disabled={!contracts} onClick={() => setShowMod(!showMod)} title="Moderation case for this photo">
          ⚖️
        </button>
      </span>
      {showMod && (
        <ModerationPanel tokenId={tokenId} kind={1} cidHash={hash} contracts={contracts} account={account} notify={notify} onResolved={refresh} />
      )}
    </>
  );
}

// Signed evidence gallery. Moderation hides (never deletes): hidden items
// collapse behind a toggle with their case id, so curation stays auditable.
function EvidenceGallery({ cow, tokenId, contracts, account, notify, refresh }) {
  const [showHidden, setShowHidden] = useState(false);
  const items = cow.evidence || [];
  const hidden = items.filter((ev) => ev.hidden);
  const visible = items.filter((ev) => !ev.hidden);
  const shown = showHidden ? items : visible;
  return (
    <div className="mt12">
      <div className="inline" style={{ justifyContent: "space-between", width: "100%" }}>
        <div className="muted" style={{ fontSize: 12 }}>
          🏷️ Signed evidence — rated by the herd, feeding this cow's authenticity.
        </div>
        {hidden.length > 0 && (
          <button className="thumb" onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? "hide" : `show ${hidden.length} hidden`}
          </button>
        )}
      </div>
      <div className="gallery mt4">
        {shown.map((ev) => (
          <div key={ev.hash} className="ev-card" style={ev.hidden ? { opacity: 0.55 } : undefined}>
            <a href={ev.url} target="_blank" rel="noreferrer" className="ev-link" title={ev.fileName}>
              {/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(ev.url) ? "🖼️" : "📎"} {ev.note || ev.fileName}
            </a>
            <div className="ev-meta">
              by <Name address={ev.uploader} />
              {ev.hidden && <span className="muted" style={{ fontSize: 11 }}>hidden (case #{ev.moderationId})</span>}
              <EvidenceThumb
                tokenId={tokenId}
                ev={ev}
                contracts={contracts}
                account={account}
                notify={notify}
                refresh={refresh}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Threads({ cow, contracts, account, refresh, notify }) {
  const [title, setTitle] = useState("");
  const [posts, setPosts] = useState({}); // threadId -> draft text
  const [showHidden, setShowHidden] = useState(false);

  async function newThread(e) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      const thread = await api.createThread(cow.cid, title.trim(), account);
      // Anchor the opening post on-chain so later votes attribute correctly.
      if (contracts && account && thread?.posts?.[0]) {
        try {
          await registerContent(contracts, cow.tokenId, 2, contentHash("post:" + thread.posts[0].id), false);
        } catch {
          /* already anchored (heartbeat race) — votes still work */
        }
      }
      if (account) await api.logActivity(account, "thread", `Opened “${title.trim()}” on ${cow.name}`);
      setTitle("");
      notify("Thread opened (post anchored on-chain).");
      refresh();
    } catch (err) {
      notify(err.message, "error");
    }
  }

  async function newPost(tid, text) {
    if (!text.trim()) return;
    try {
      const post = await api.createPost(cow.cid, tid, text.trim(), account);
      if (contracts && account && post?.id) {
        try {
          await registerContent(contracts, cow.tokenId, 2, contentHash("post:" + post.id), false);
        } catch {
          /* already anchored — votes still work */
        }
      }
      if (account) await api.logActivity(account, "post", `Commented on ${cow.name}`);
      setPosts({ ...posts, [tid]: "" });
      notify("Post added (anchored on-chain).");
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
          {thread.posts.map((post) => {
            if (post.hidden && !showHidden) return null;
            return (
              <div key={post.id} className="post" style={post.hidden ? { opacity: 0.55 } : undefined}>
                <div className="meta">
                  {post.author} · {fmtDate(post.createdAt)}
                  {post.hidden && <span className="muted" style={{ fontSize: 11 }}> · hidden (case #{post.moderationId})</span>}
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
            );
          })}
          {(thread.posts || []).some((p) => p.hidden) && (
            <button className="thumb mt4" onClick={() => setShowHidden(!showHidden)}>
              {showHidden ? "hide hidden posts" : "show hidden posts"}
            </button>
          )}
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

// Voice budget meter: the field is zero-sum, so every vote locks voice and
// over-budget votes dilute the oldest locks first. Unvote to free budget.
function VoiceMeter({ contracts, account, rep, notify }) {
  const [locks, setLocks] = useState(null);
  const [busy, setBusy] = useState("");

  async function reload() {
    if (!contracts || !account) return;
    try {
      setLocks(await voiceLocks(contracts, account));
    } catch {
      setLocks(null);
    }
  }

  if (locks === null && contracts && account) reload();

  const locked = rep.voiceLocked ?? locks?.locked ?? 0;
  const budget = rep.voiceBudget ?? locks?.budget ?? 0;
  const pct = budget > 0 ? Math.min(100, Math.round((locked / budget) * 100)) : 0;
  const over = budget > 0 && locked > budget;

  async function unvoteKey(key) {
    setBusy(key);
    try {
      await unvote(contracts, key);
      notify("Voice freed.");
      setLocks(null);
    } catch (err) {
      notify(friendlyError(err), "error");
    } finally {
      setBusy("");
    }
  }

  if (!contracts) return null;
  return (
    <div className="mt12 panel inset">
      <div className="inline" style={{ justifyContent: "space-between", width: "100%" }}>
        <span className="muted" style={{ fontSize: 12 }}>
          🗣️ Voice {locked}/{budget} locked
          {over ? " — over budget: your next vote dilutes oldest locks first" : ""}
        </span>
        <button className="thumb" onClick={reload} title="Refresh voice locks">↻</button>
      </div>
      <div className="meter mt4">
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
      {locks && locks.keys.length > 0 && (
        <div className="mt12" style={{ fontSize: 12 }}>
          {locks.keys.slice(0, 8).map((k, i) => (
            <div key={k} className="row" style={{ justifyContent: "space-between" }}>
              <span className="muted" title={k}>
                {k.slice(0, 12)}… · {locks.amounts[i]}
              </span>
              <button className="thumb" disabled={!!busy} onClick={() => unvoteKey(k)}>
                {busy === k ? "…" : "unvote"}
              </button>
            </div>
          ))}
          {locks.keys.length > 8 && (
            <div className="muted">+{locks.keys.length - 8} more locks</div>
          )}
        </div>
      )}
    </div>
  );
}

// Rating breakdown + protection → payout trail, recomputed from chain logs.
function RatingPanels({ cow }) {
  const [data, setData] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [forCid, setForCid] = useState(null);
  const [tab, setTab] = useState("breakdown");

  if (cow.cid !== forCid) {
    setForCid(cow.cid);
    if (cow.tokenId) {
      api.cowRatings(cow.tokenId).then(setData).catch(() => setData(null));
      api.ledger(cow.tokenId).then(setLedger).catch(() => setLedger(null));
    }
  }

  if (!cow.tokenId) return null;
  const contentRows = data ? Object.values(data.content) : [];
  return (
    <div className="mt12 panel inset">
      <div className="row" style={{ gap: 8 }}>
        <button className={tab === "breakdown" ? "primary" : ""} onClick={() => setTab("breakdown")}>
          Rating breakdown
        </button>
        <button className={tab === "trail" ? "primary" : ""} onClick={() => setTab("trail")}>
          Protection trail
        </button>
        {data?.anchorLive !== undefined && (
          <span className="muted" style={{ fontSize: 12 }}>
            anchor: {data.anchorLive ? "🟢 live — payoffs unlocked" : "⚪ none — voice counts, mints locked"}
          </span>
        )}
      </div>

      {tab === "breakdown" && (
        <div className="mt12" style={{ fontSize: 13 }}>
          {!data ? (
            <span className="muted">Loading from chain logs…</span>
          ) : (
            <>
              <div className="stats">
                <div className="stat">
                  <div className="k">Staked</div>
                  <div className="v">{data.stakes.total}</div>
                </div>
                <div className="stat">
                  <div className="k">Cow votes</div>
                  <div className="v">{data.cowVotes.weight} ({data.cowVotes.votes}×)</div>
                </div>
                <div className="stat">
                  <div className="k">Care labor</div>
                  <div className="v">{data.labor.hours}h → +{data.labor.rewards}</div>
                </div>
              </div>
              {contentRows.length > 0 && (
                <div className="mt12">
                  <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Posts & evidence feeding this cow:</div>
                  {contentRows.map((c) => (
                    <div key={c.kind + ":" + c.cidHash} className="row" style={{ justifyContent: "space-between", fontSize: 12 }}>
                      <span className="muted" title={c.cidHash}>
                        {c.kind === 1 ? "🖼️ evidence" : "💬 post"} {c.cidHash.slice(0, 14)}…
                      </span>
                      <span>{c.weight} ({c.votes}×)</span>
                    </div>
                  ))}
                </div>
              )}
              {Object.keys(data.authors).length > 0 && (
                <div className="mt12">
                  <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Documenters paid from this cow:</div>
                  {Object.entries(data.authors).map(([addr, a]) => (
                    <div key={addr} className="row" style={{ justifyContent: "space-between", fontSize: 12 }}>
                      <Name address={addr} />
                      <span>+{a.earned}{a.selfVotes ? ` (${a.selfVotes} self)` : ""}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="muted mt12" style={{ fontSize: 12 }}>
                Logged vote weight can exceed the live rating: the difference is dilution — voice
                returned to the field when curators moved on.
              </div>
            </>
          )}
        </div>
      )}

      {tab === "trail" && (
        <div className="mt12" style={{ fontSize: 13 }}>
          {!ledger ? (
            <span className="muted">Loading from chain logs…</span>
          ) : ledger.rows.length === 0 ? (
            <span className="muted">No protection payouts yet — voice counts, mints unlock with the first anchored proof.</span>
          ) : (
            ledger.rows.map((r, i) => (
              <div key={i} className="row" style={{ justifyContent: "space-between", fontSize: 12 }}>
                <span>
                  {r.kind === "labor" && `💪 ${r.hours}h by `}
                  {r.kind === "labor" && <Name address={r.worker} />}
                  {r.kind === "labor" && ` → +${r.reward}`}
                  {r.kind === "funding" && `🧾 need ${r.previous} → ${r.current} (solver `}
                  {r.kind === "funding" && <Name address={r.solver} />}
                  {r.kind === "funding" && ")"}
                  {r.kind === "author" && `✍️ +${r.award} to `}
                  {r.kind === "author" && <Name address={r.author} />}
                  {r.kind === "author" && ` (curator `}
                  {r.kind === "author" && <Name address={r.curator} />}
                  {r.kind === "author" && ")"}
                  {r.kind === "care" && `🎗️ care +${(Number(r.amount) / 1e18).toFixed(3)} ETH (proof #${r.claimRef})`}
                  {r.kind === "release" && `💸 ${(Number(r.amount) / 1e18).toFixed(3)} ETH released (proof #${r.claimRef})`}
                  {r.kind === "claim" && `🔏 claim #${r.claimId} executed`}
                </span>
                <span className="muted">#{r.block}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// Care credit: the cow's rating is its credit line. Burning Stasis here
// releases real ETH from the cow's care pool — one way, for good. The worker
// (claim subject) or the cow's owner may redeem; recovery is a herd vote.
function CarePanel({ tokenId, contracts, account, notify }) {
  const [info, setInfo] = useState(null);
  const [amount, setAmount] = useState("");
  const [commitBps, setCommitBps] = useState(10_000);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  async function reload() {
    if (!contracts) return;
    try {
      const s = await careStatus(contracts, tokenId);
      const bps = account ? await laborCommitBps(contracts, account) : 0;
      setInfo(s);
      setCommitBps(bps || 10_000);
    } catch (e) {
      setErr(friendlyError(e));
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contracts, tokenId, account]);

  async function run(label, fn) {
    setBusy(label);
    setErr("");
    try {
      await fn();
      await reload();
      notify(`${label} done.`);
    } catch (e) {
      notify(friendlyError(e), "error");
    } finally {
      setBusy("");
    }
  }

  const stasis = Number(amount || 0);
  const ethOut = info ? (Number(info.rateWei) * stasis) / 1e18 : 0;
  const overCredit = info ? stasis > info.creditLine : false;
  const overPool = info ? ethOut * 1e18 > Number(info.poolWei) : false;

  return (
    <details className="mt12 panel inset" open={info && Number(info.poolWei) > 0 ? true : undefined}>
      <summary style={{ cursor: "pointer", fontSize: 13 }}>
        🩺 Care credit {info && Number(info.poolWei) > 0 ? `(${fmtEth(info.poolWei)} pool)` : ""}
      </summary>
      {info && (
        <>
          <div className="muted mt4" style={{ fontSize: 12 }}>
            Rate <b>{Number(info.rateWei) / 1e15}</b> ETH per Stasis · credit line (this cow's rating){" "}
            <b>{info.creditLine}</b> · anchor {info.anchorLive ? "live 🟢" : "cold ⚪"}. Stasis burned
            here is gone for good — recovery is a herd vote, not a refund.
          </div>
          <div className="row mt12">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              type="number"
              min="1"
              placeholder="Stasis to burn"
              style={{ width: 150 }}
            />
            <button
              className="primary"
              disabled={!account || !stasis || busy || overCredit || overPool}
              onClick={() => run("Redeem", () => redeemCare(contracts, tokenId, stasis, 0))}
            >
              {busy === "Redeem" ? "…" : `Redeem ~${ethOut.toFixed(4)} ETH`}
            </button>
          </div>
          {overCredit && (
            <div className="muted mt4" style={{ fontSize: 12 }}>
              Above the credit line ({info.creditLine}) — the cow's rating is the ceiling.
            </div>
          )}
          {overPool && (
            <div className="muted mt4" style={{ fontSize: 12 }}>
              More than this cow's pool holds.
            </div>
          )}
          {(info.redemptions || []).length > 0 && (
            <div className="muted mt4" style={{ fontSize: 12 }}>
              {info.redemptions.length} one-way redemption(s) recorded on-chain.
            </div>
          )}
          <div className="mt12">
            <label style={{ fontSize: 12 }}>
              Commit future labor to this cow: <b>{commitBps / 100}%</b>
            </label>
            <div className="row">
              <input
                type="range"
                min="0"
                max="10000"
                step="500"
                value={commitBps}
                onChange={(e) => setCommitBps(Number(e.target.value))}
                style={{ flex: 1 }}
              />
              <button
                disabled={!account || busy}
                onClick={() => run("Commit", () => setLaborCommitBps(contracts, commitBps))}
              >
                {busy === "Commit" ? "…" : "Save"}
              </button>
            </div>
            <div className="muted mt4" style={{ fontSize: 12 }}>
              That share of every labor reward is voiced back at the cow as a rating lien, locked
              ~30 days, then releasable.
            </div>
          </div>
        </>
      )}
    </details>
  );
}

export default function CowDetail({ cow, contracts, account, rep, onBack, refresh, notify }) {
  const [amount, setAmount] = useState("");
  const [bps, setBps] = useState(1000);
  const [tier, setTier] = useState(0);
  const [hours, setHours] = useState("");
  const [toAddr, setToAddr] = useState("");
  const [busy, setBusy] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const fileRef = useRef(null);

  const tokenId = cow.tokenId;

  // Roles drive progressive disclosure: visitors vote; backers stake;
  // recognized contributors (owner, staker, protection-active) attest.
  const isOwner = !!(account && cow.onChainOwner && account.toLowerCase() === cow.onChainOwner.toLowerCase());
  const [myStake, setMyStake] = useState(null);
  const [capInfo, setCapInfo] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!contracts || !account || !tokenId) {
      setMyStake(null);
      return;
    }
    (async () => {
      try {
        const [mine, total, threshold, capBps] = await Promise.all([
          contracts.cowRating.stakeOf(tokenId, account),
          contracts.cowRating.totalStaked(tokenId),
          contracts.cowRating.activationThreshold(),
          contracts.cowRating.concentrationCapBps(),
        ]);
        if (!alive) return;
        const base = Number(total) < Number(threshold) ? Number(threshold) : Number(total);
        setMyStake(Number(mine));
        setCapInfo({ cap: Math.floor((base * Number(capBps)) / 10000), total: Number(total) });
      } catch {
        if (alive) setMyStake(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [contracts, account, tokenId, cow.backing]);

  const isBacker = (myStake ?? 0) > 0;
  const isOracle = isOwner || isBacker || (rep.protection ?? 0) > 0;

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

  async function uploadEvidence(e) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return notify("Choose a file first.", "error");
    if (!account) return notify("Connect a wallet to sign evidence.", "error");
    setBusy("Upload");
    try {
      const buf = await file.arrayBuffer();
      const hash = await sha256Hex(buf);
      const signature = await signMessage(contracts, `evidence:${hash}`);
      const form = new FormData();
      form.append("file", file);
      form.append("address", account);
      form.append("signature", signature);
      form.append("note", evidenceNote);
      await api.uploadEvidence(cow.cid, form);
      // Anchor authorship on-chain as protection-linked: later thumbs-ups
      // attribute the documenter and can mint the damped author award.
      try {
        await registerContent(contracts, cow.tokenId, 1, contentHash("evidence:" + hash), true);
      } catch {
        /* already anchored — rating still works */
      }
      await api.logActivity(account, "evidence", `Signed evidence “${file.name}” on ${cow.name}`);
      setEvidenceNote("");
      if (fileRef.current) fileRef.current.value = "";
      notify("Evidence uploaded — wallet signature verified.");
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
              {cow.age ? ` · ${cow.age} years` : ""} · <Name address={cow.onChainOwner} />
            </div>
            {cow.story && <p className="mt12">{cow.story}</p>}
          </div>

          <div>
            <div className="stats">
              <div className="stat">
                <div className="k">Rating</div>
                <div className="v">{cow.rating}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  earned, never bought
                </div>
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
                <div className="v">{contracts ? (rep.momentum / 10000).toFixed(2) + "×" : "—"}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  weighs your votes
                </div>
              </div>

            </div>

            <div className="actions">
              <select value={bps} onChange={(e) => setBps(Number(e.target.value))} style={{ width: "auto" }} title="How much of your voice this thumbs-up carries">
                <option value={100}>vote 1%</option>
                <option value={500}>vote 5%</option>
                <option value={1000}>vote 10%</option>
              </select>
              <button
                className="primary"
                disabled={busy}
                onClick={() => run("Thumbs up", () => boost(contracts, tokenId, bps))}
              >
                {busy === "Thumbs up" ? "…" : "👍 Thumbs up"}
              </button>
            </div>

            <div className="muted mt12" style={{ fontSize: 12 }}>
              One vote, weighted by <b>(score × share) × momentum</b>. Every 👍 spends
              20% of voting power (refills over ~24h) and locks voice from your fixed
              budget — the field is zero-sum.
            </div>

            {rep.score === 0 && (
              <div
                className="muted mt12"
                style={{ fontSize: 13, border: "1px dashed var(--border)", padding: 8, borderRadius: 8 }}
              >
                Your wallet has no Stasis yet, so votes will be declined by the
                contract. This demo is zero-start: the six demo raters{" "}
                <b>earned 700 Stasis each</b> by completing the cow-care course.
                Complete it yourself in <b>Academy</b>, or switch MetaMask to
                hardhat accounts <b>#1 to #6</b> (printed when the node starts).
              </div>
            )}

            <details className="mt12 panel inset" open={isBacker || undefined}>
              <summary style={{ cursor: "pointer", fontSize: 13 }}>
                💪 Back this cow {myStake ? `(you: ${myStake})` : ""}
              </summary>
              <div className="muted mt4" style={{ fontSize: 12 }}>
                Commit rating behind this cow. Backing {cow.backing}
                {capInfo ? ` · you can hold at most ${capInfo.cap} (one account caps at 20%)` : ""} ·
                care pool {fmtEth(cow.carePool)} · funding need {cow.fundingNeed}.
                Longer locks ramp conviction; early exits burn rating.
              </div>
              <div className="row mt12">
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="e.g. 200"
                  type="number"
                  min="1"
                  style={{ width: 110 }}
                />
                <select value={tier} onChange={(e) => setTier(Number(e.target.value))} style={{ width: "auto" }} title="Conviction lock: longer commits ramp toward a higher weight cap">
                  <option value={0}>flexible 1.00×</option>
                  <option value={1}>90d up to 1.25×</option>
                  <option value={2}>180d up to 1.50×</option>
                </select>
                <button
                  className="primary"
                  disabled={!amount || busy}
                  onClick={() => run("Stake", () => stake(contracts, tokenId, amount, tier))}
                >
                  {busy === "Stake" ? "…" : "Stake"}
                </button>
                <button
                  disabled={!amount || busy}
                  onClick={() => run("Unstake", () => unstake(contracts, tokenId, amount))}
                >
                  {busy === "Unstake" ? "…" : "Unstake"}
                </button>
              </div>
              {["stake", "unstake"].includes(busy.toLowerCase()) ? (
                <div className="muted mt4" style={{ fontSize: 12 }}>
                  Waiting for the transaction… (cancel it in MetaMask to abort)
                </div>
              ) : null}
              <VoiceMeter contracts={contracts} account={account} rep={rep} notify={notify} />
            </details>

            <details className="mt12 panel inset" open={isOracle || undefined}>
              <summary style={{ cursor: "pointer", fontSize: 13 }}>
                🔏 Oracle actions {isOracle ? "" : "(recognized contributors)"}
              </summary>
              {!isOracle ? (
                <div className="muted mt4" style={{ fontSize: 12 }}>
                  Bonded claims move real state. They unlock once you've backed this
                  cow, own it, or done verified care work anywhere in the herd.
                </div>
              ) : (
                <>
                  <div className="row mt12">
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
                  <div className="muted mt4" style={{ fontSize: 12 }}>
                    Each report bonds score and needs a second rater to execute. False
                    claims burn the bond.
                  </div>
                  <div className="muted" style={{ fontSize: 12, margin: "8px 0 6px" }}>
                    💪 Report real care work — reward = hours × base rate × (this cow's
                    rating / reference).
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
                  <div className="muted" style={{ fontSize: 12, margin: "8px 0 6px" }}>
                    🏷️ Upload signed proof (photos, vet records, receipts). Raters rate
                    it, and verified ratings feed this cow.
                  </div>
                  <form onSubmit={uploadEvidence} className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <input ref={fileRef} type="file" style={{ maxWidth: 220 }} />
                    <input
                      value={evidenceNote}
                      onChange={(e) => setEvidenceNote(e.target.value)}
                      placeholder="what does this prove?"
                      style={{ flex: 1, minWidth: 160 }}
                    />
                    <button className="primary" type="submit" disabled={busy === "Upload" || !account}>
                      {busy === "Upload" ? "…" : "Upload + sign"}
                    </button>
                  </form>
                </>
              )}
            </details>

            {isOwner && (
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
                  You own this cow. Transfers spend the buyer's rating — money alone cannot move it.
                </div>
              </div>
            )}

            <CarePanel tokenId={tokenId} contracts={contracts} account={account} notify={notify} />

            <details className="mt12 panel inset">
              <summary style={{ cursor: "pointer", fontSize: 13 }}>📊 Details: backing, breakdown, money trail</summary>
              <div className="mt12">
                <RatingPanels cow={cow} />
              </div>
            </details>

            {(cow.evidence || []).length > 0 && (
              <EvidenceGallery cow={cow} tokenId={tokenId} contracts={contracts} account={account} notify={notify} refresh={refresh} />
            )}

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

      <RatingPanels cow={cow} />

      <Threads cow={cow} contracts={contracts} account={account} refresh={refresh} notify={notify} />
    </div>
  );
}
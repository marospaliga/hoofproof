import { useEffect, useState } from "react";
import { fmtDate, shortAddr } from "../config.js";
import { api } from "../lib/api.js";
import { myReputation, contentHash } from "../lib/chain.js";
import Name from "./Name.jsx";

// One wallet's public page: identity (off-chain, wallet-claimable) + live
// reputation + the cows they own + their oracle (signed-evidence) record +
// their activity feed.
export default function Profile({ address, contracts, account, rep, cows, notify }) {
  const [profile, setProfile] = useState(null);
  const [evidence, setEvidence] = useState([]);
  const [activity, setActivity] = useState([]);
  const [stats, setStats] = useState(rep);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", bio: "", avatar: "", links: "" });

  if (!address) {
    return (
      <div className="panel">
        <div className="muted">Connect a wallet to open your profile.</div>
      </div>
    );
  }

  const mine = account && address.toLowerCase() === account.toLowerCase();

  useEffect(() => {
    let alive = true;
    api
      .getProfile(address)
      .then((p) => alive && setProfile(p))
      .catch(() => alive && setProfile(null));
    api.listEvidence(address).then((items) => alive && setEvidence(items)).catch(() => {});
    api.getActivity(address).then((list) => alive && setActivity(list)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [address]);

  // Live reputation + on-chain oracle weight (thumbs on their evidence files).
  useEffect(() => {
    if (!contracts) return;
    let alive = true;
    (async () => {
      try {
        const s = await myReputation(contracts, address);
        if (alive) setStats(s);
      } catch {
        /* not callable for this address yet */
      }
      if (evidence.length && alive) {
        let oracle = 0;
        for (const item of evidence) {
          if (item.tokenId == null) continue;
          try {
            oracle += Number(
              await contracts.cowRating.contentRatingOf(
                item.tokenId,
                1, // Image
                contentHash("evidence:" + item.hash)
              )
            );
          } catch {
            /* unrateable evidence */
          }
        }
        setStats((prev) => ({ ...prev, oracle }));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contracts, address, evidence]);

  const ownedCows = cows.filter((c) => c.onChainOwner && c.onChainOwner.toLowerCase() === address.toLowerCase());

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const name = form.name.trim() || undefined;
      const body = { address, name, bio: form.bio, avatar: form.avatar };
      if (form.links.trim()) body.links = form.links.split(",").map((l) => l.trim()).filter(Boolean);
      const updated = await api.setProfile(body);
      setProfile(updated);
      setEditing(false);
      const finalName = updated.name || `Cowhand #${address.slice(-4).toUpperCase()}`;
      await api.logActivity(account, "profile", `Claimed the name “${finalName}”`);
      notify("Profile updated.");
    } catch (err) {
      notify(err.message, "error");
    } finally {
      setBusy(false);
    }
  }

  function startEdit() {
    setForm({
      name: profile?.name || "",
      bio: profile?.bio || "",
      avatar: profile?.avatar || "",
      links: (profile?.links || []).join(", "),
    });
    setEditing(true);
  }

  return (
    <div>
      <div className="panel">
        <div className="grid-2">
          <div>
            <div style={{ fontSize: 52 }}>
              {profile?.avatar || "🧑‍🌾"}
            </div>
            <h2 style={{ margin: "6px 0 0" }}>
              {profile?.name || `Cowhand #${address.slice(-4).toUpperCase()}`}
            </h2>
            {!profile && (
              <div className="muted mt4" style={{ fontSize: 13 }}>
                No profile claimed yet — {mine ? "you can claim one below." : "an anonymous Cowhand."}
              </div>
            )}
            {profile?.bio && <p className="mt12">{profile.bio}</p>}
            {profile?.links?.length > 0 && (
              <div className="muted mt4" style={{ fontSize: 13 }}>
                {profile.links.map((l) => (
                  <a key={l} href={l.startsWith("http") ? l : `https://${l}`} target="_blank" rel="noreferrer">
                    {l} ·{" "}
                  </a>
                ))}
              </div>
            )}
            {profile && (
              <div className="muted mt4" style={{ fontSize: 12 }}>
                joined {fmtDate(profile.joinedAt)} · <Name address={address} />
              </div>
            )}

            {mine && !editing && (
              <div className="row mt12">
                <button onClick={startEdit}>Edit profile</button>
              </div>
            )}
            {mine && editing && (
              <form onSubmit={save} className="mt12">
                <label htmlFor="pn">Name</label>
                <input id="pn" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Maros the Keeper" />
                <label htmlFor="pa">Avatar (emoji or image URL)</label>
                <input id="pa" value={form.avatar} onChange={(e) => setForm({ ...form, avatar: e.target.value })} placeholder="🌾 or https://…" />
                <label htmlFor="pb">Bio</label>
                <textarea id="pb" value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} rows={2} placeholder="What do you do for the herd?" />
                <label htmlFor="pl">Links (comma-separated)</label>
                <input id="pl" value={form.links} onChange={(e) => setForm({ ...form, links: e.target.value })} placeholder="linktr.ee/you, x.com/you" />
                <div className="row mt12">
                  <button className="primary" type="submit" disabled={busy}>
                    {busy ? "…" : "Save profile"}
                  </button>
                  <button type="button" onClick={() => setEditing(false)}>Cancel</button>
                </div>
              </form>
            )}
          </div>

          <div className="stats">
            <div className="stat">
              <div className="k">Stasis</div>
              <div className="v">{stats.score}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                free {Math.max(stats.score - stats.bonded, 0)} · bonded {stats.bonded}
              </div>
            </div>
            <div className="stat">
              <div className="k">Voting power</div>
              <div className="v">{(stats.votingPower / 100).toFixed(0)}%</div>
              <div className="muted" style={{ fontSize: 12 }}>refills ~24h</div>
            </div>
            <div className="stat">
              <div className="k">Momentum</div>
              <div className="v">{(stats.momentum / 100).toFixed(2)}×</div>
              <div className="muted" style={{ fontSize: 12 }}>sustained activity</div>
            </div>
            <div className="stat">
              <div className="k">Rajas</div>
              <div className="v">{stats.rajas}</div>
              <div className="muted" style={{ fontSize: 12 }}>action credits</div>
            </div>
            <div className="stat">
              <div className="k">Oracle</div>
              <div className="v">{stats.oracle ?? "…"}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                thumbs on {evidence.length} signed upload{evidence.length === 1 ? "" : "s"}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid-2 mt12">
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Their cows 🐄</h3>
          {ownedCows.length === 0 && (
            <div className="muted" style={{ fontSize: 13 }}>No cows owned yet (on-chain).</div>
          )}
          {ownedCows.map((cow) => (
            <div key={cow.cid} className="thread">
              <div className="body">
                <b>{cow.name}</b> · {cow.statusName}
              </div>
              <div className="meta">
                rating {cow.rating} · backing {cow.backing}
              </div>
            </div>
          ))}
        </div>

        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Oracle record 🏷️</h3>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Files they uploaded with a wallet signature. The on-chain thumbs those
            files received count into their oracle score above.
          </div>
          {evidence.length === 0 && (
            <div className="muted" style={{ fontSize: 13 }}>No signed uploads yet.</div>
          )}
          {evidence.map((item) => (
            <div key={item.hash} className="thread">
              <a className="body" href={item.url} target="_blank" rel="noreferrer">
                📎 {item.note || item.fileName}
              </a>
              <div className="meta">
                {fmtDate(item.createdAt)} · {item.mime}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel mt12">
        <h3 style={{ marginTop: 0 }}>Activity feed 🕑</h3>
        {activity.length === 0 && <div className="muted" style={{ fontSize: 13 }}>Nothing logged yet.</div>}
        {activity.map((a, i) => (
          <div key={i} className="thread" style={{ padding: "4px 0" }}>
            <span className="meta">{fmtDate(a.ts)} · {a.type}</span>
            <div className="body">{a.detail || "—"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
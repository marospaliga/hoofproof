import { useState } from "react";
import { api } from "../lib/api.js";
import { mintCow, friendlyError } from "../lib/chain.js";

const EMOJIS = ["🐄", "🐂", "🐃", "🟤", "🔵"];

export default function MintModal({ contracts, account, onClose, onMinted, notify }) {
  const [form, setForm] = useState({ name: "", breed: "", age: "", story: "", image: "🐄" });
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setBusy(true);
    try {
      // 1. The prose lives off-chain; the cow record will cite it by cid.
      const record = await api.createCow({
        name: form.name.trim(),
        breed: form.breed.trim(),
        age: form.age.trim(),
        story: form.story.trim(),
        image: form.image,
      });

      // 2. The chain record is born Inert — no weight until raters back it.
      const tokenId = await mintCow(contracts, record.cid, account);

      // 3. Link chain and off-chain records.
      await api.linkToken(record.cid, tokenId, account);

      notify(`Cow #${tokenId} minted. Now it needs raters to become Active.`);
      onMinted();
    } catch (err) {
      notify(friendlyError(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Mint a cow</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          Anyone may mint. The record is born <em>Inert</em> — it only becomes
          <em> Active</em> when independent raters commit their reputation to it.
        </p>
        <form onSubmit={submit}>
          <label>Name *</label>
          <input value={form.name} onChange={set("name")} placeholder="Blossom" required autoFocus />
          <label>Breed</label>
          <input value={form.breed} onChange={set("breed")} placeholder="Jersey" />
          <label>Age (years)</label>
          <input value={form.age} onChange={set("age")} placeholder="4" type="number" min="0" />
          <label>Story</label>
          <textarea value={form.story} onChange={set("story")} placeholder="Why does this cow matter?" />
          <label>Face</label>
          <div className="inline" style={{ gap: 6 }}>
            {EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => setForm({ ...form, image: emoji })}
                style={{
                  fontSize: 22,
                  padding: "4px 10px",
                  borderColor: form.image === emoji ? "var(--accent)" : undefined,
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
          <div className="actions">
            <button className="primary" type="submit" disabled={busy}>
              {busy ? "Minting…" : "Mint cow"}
            </button>
            <button type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
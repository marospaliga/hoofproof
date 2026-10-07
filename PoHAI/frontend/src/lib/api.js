import { API_BASE } from "../config.js";

async function req(url, options = {}) {
  const res = await fetch(`${API_BASE}${url}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `request failed (${res.status})`);
  }
  return res.json();
}

export const api = {
  config: () => req("/config"),
  listCows: () => req("/cows"),
  getCow: (cid) => req(`/cows/${cid}`),
  createCow: (body) => req("/cows", { method: "POST", body: JSON.stringify(body) }),
  linkToken: (cid, tokenId, owner) =>
    req(`/cows/${encodeURIComponent(cid)}`, {
      method: "PATCH",
      body: JSON.stringify({ tokenId, owner }),
    }),
  createThread: (cid, title, author) =>
    req(`/cows/${encodeURIComponent(cid)}/threads`, {
      method: "POST",
      body: JSON.stringify({ title, author }),
    }),
  createPost: (cid, tid, text, author) =>
    req(`/cows/${encodeURIComponent(cid)}/threads/${tid}/posts`, {
      method: "POST",
      body: JSON.stringify({ text, author }),
    }),

  // ---------------------------------------------------------------- Phase C

  // Per-wallet profiles (keyed by lowercase address).
  getProfile: (address) => req(`/profiles/${encodeURIComponent(address)}`),
  setProfile: (body) => req("/profiles", { method: "POST", body: JSON.stringify(body) }),
  getActivity: (address) => req(`/profiles/${encodeURIComponent(address)}/activity`),

  // Signature-verified evidence uploads. multipart: `file` + address + signature (+ note).
  uploadEvidence: async (cid, form) => {
    const res = await fetch(`${API_BASE}/cows/${encodeURIComponent(cid)}/evidence`, {
      method: "POST",
      body: form, // browsers set the multipart boundary themselves
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `upload failed (${res.status})`);
    }
    return res.json();
  },

  // Oracle record for the profile page (everything this wallet uploaded).
  listEvidence: (uploader) => req(`/evidence?uploader=${encodeURIComponent(uploader)}`),

  // Charitable-event metadata (escrow lives on-chain in GeneralPool).
  listEvents: () => req("/events"),
  getEvent: (id) => req(`/events/${encodeURIComponent(id)}`),
  createEventMeta: (body) => req("/events", { method: "POST", body: JSON.stringify(body) }),

  // Activity feed.
  logActivity: (address, type, detail) =>
    req("/activity", {
      method: "POST",
      body: JSON.stringify({ address, type, detail }),
    }),
};
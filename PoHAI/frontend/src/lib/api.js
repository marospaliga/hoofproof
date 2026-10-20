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

  // ------------------------------------------------------- rating index (P1)

  // Read-only views recomputed from chain logs (chain enforces, server displays).
  cowRatings: (tokenId) => req(`/ratings/${encodeURIComponent(tokenId)}`),
  contentInfo: (key) => req(`/content/${encodeURIComponent(key)}`),
  trending: () => req("/trending"),
  ledger: (tokenId) => req(`/ledger/${encodeURIComponent(tokenId)}`),
  curators: (tokenId) => req(`/curators/${encodeURIComponent(tokenId)}`),
  authorInfo: (address) => req(`/authors/${encodeURIComponent(address)}`),

  // Academy: course lessons (text + questions, never answers) and quiz
  // grading. A pass returns an EIP-712 signature to submit on-chain.
  academyLessons: () => req("/academy/lessons"),
  submitQuiz: (address, lessonId, answers) =>
    req("/academy/submit", {
      method: "POST",
      body: JSON.stringify({ address, lessonId, answers }),
    }),

  // Whole-field rating-pool indicator (live from the pool contract).
  pool: () => req("/pool"),

  // Moderation cases (server verifies execution on-chain before hiding).
  moderationInfo: (id) => req(`/moderation/${encodeURIComponent(id)}`),
  applyModeration: (proposalId) =>
    req("/moderation/apply", { method: "POST", body: JSON.stringify({ proposalId }) }),
};
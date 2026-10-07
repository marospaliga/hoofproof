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
};
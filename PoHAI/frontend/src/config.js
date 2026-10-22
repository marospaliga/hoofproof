// Local-hardhat defaults (deterministic deployer addresses). When the app runs
// against a real testnet, the agorá server serves the freshly deployed
// addresses via /api/config and the frontend uses those instead.

export const DEFAULT_CONTRACTS = {
  network: "hardhat",
  stasis: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  cowNFT: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  cowRating: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  attestation: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
  generalPool: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
  herdCouncil: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
};

export const API_BASE = "/api";

export const STATUS_NAMES = ["Inert", "Active", "SelfSustaining", "Memorial"];
export const STATUS_COLORS = {
  Inert: "#6f6857",          // weathered grey-brown
  Active: "#456d33",         // deep grass green
  SelfSustaining: "#846414", // harvest gold
  Memorial: "#a8322b",       // barn red
};

// The chain's decay windows are not hardcoded here: they are owner-settable
// (the beta runs a shorter ruler), so the UI reads them live from the chain.

// RFC3339-ish short date for the UI
export function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString();
}

export function shortAddr(addr) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
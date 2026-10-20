// Rating simulator server: serves the test console, proxies chain RPC
// (browsers can't reach 8545 cross-origin), and exposes ABIs + deployment.
//
//   npm run sim
//   → open http://localhost:3987
//
// Test keys only. The console derives throwaway wallets from the public
// Hardhat development mnemonic — never use those keys anywhere real.
const fs = require("fs");
const path = require("path");
const express = require("express");

const app = express();
const ROOT = path.join(__dirname, "..");
const PORT = process.env.SIM_PORT || 3987;
const RPC = process.env.CHAIN_RPC || "http://127.0.0.1:8545";

app.use((_, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});
app.use(express.static(__dirname, {
  maxAge: 0,
  setHeaders: (res) => res.set("Cache-Control", "no-store"),
}));

// Transparent JSON-RPC relay (single + batch).
app.post("/rpc", express.text({ type: "*/*", limit: "2mb" }), async (req, res) => {
  try {
    const upstream = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: req.body,
    });
    res.status(upstream.status).type("application/json").send(await upstream.text());
  } catch (err) {
    res.status(502).json({ error: `chain unreachable at ${RPC}: ${err.message}` });
  }
});

// ABIs + deployment for the console (served as ESM, never cached — the
// console must track redeploys).
app.get("/vendor-abis.js", (_req, res) => {
  res.set("Cache-Control", "no-store").type("application/javascript").sendFile(path.join(ROOT, "frontend", "src", "abis.js"));
});
app.get("/deployment.json", (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    res.json(JSON.parse(fs.readFileSync(path.join(ROOT, "deployed.json"), "utf8")));
  } catch {
    res.status(404).json({ error: "not deployed yet — run npm run deploy:local first" });
  }
});

app.listen(PORT, () => {
  console.log(`Rating simulator at http://localhost:${PORT} (chain ${RPC})`);
});

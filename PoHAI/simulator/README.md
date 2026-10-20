# Rating simulator

A throwaway test console for the HoofProof rating system. Acts as 10 wallets
derived from the public Hardhat development mnemonic — **local test keys only,
never use them anywhere real**.

```bash
npm run sim
# → open http://localhost:3987
```

Needs: local chain (`npm run node` or `npm run dev`) + a deployment
(`npm run deploy:local` + `npm run seed`).

## What you can do

* **Act as any of accounts #0–#9** — one click switches the signer. Funded
  demo raters are #1–#6 (20 000 Stasis each from `npm run seed`).
* **Vote / stake / unstake** on any cow and watch rating, backing, voice
  locks and momentum move.
* **Run scripted scenarios**: cold-start activation, voice-budget dilution,
  credibility head-starts, anchor-gated author awards.
* The Field line shows total rating; the log narrates every step.

Chain reads and transactions go through the bundled `/rpc` relay, so no
MetaMask or CORS setup is needed.

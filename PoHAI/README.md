# Proof of a Hoof — MVP

A blockchain app giving real cows an on-chain record: an NFT whose reputation is
earned — never bought — through community staking, attestation and a
non-transferable score called **Stasis**. Built on an existing EVM network
(testnet first: Sepolia or Amoy).

This is the MVP from the architecture plan:
- **4 contracts**, Solidity 0.8 + OpenZeppelin 5, Hardhat JS, ethers v6.
- **An agorá server** (`server/`, Express + JSON store) for the off-chain prose:
  cow metadata and the Steemit-style discussion threads.
- **A Vite + React frontend** (`frontend/`) connecting to both.
- No custom chain, no consensus changes. Money and *rating* are deliberately
  separate fields of the system.

## The idea in one paragraph

Anyone can mint a cow. The cow is inert until several independent, rated people
commit their reputation to it. Real-world facts about the cow (it exists, it's
cared for, it was sold, it died, its funding need fell to zero) are asserted by
people who back their word with a bonded score — reputation as collateral.
Gains to reputation are capped so only steady, patient work compounds; losses
are uncapped so lies hurt immediately. Eventually a cow whose funding need
stays at zero becomes **SelfSustaining** and graduates out of the system's care.

## Contracts (contracts/)

| Contract | Job |
|---|---|
| `Stasis.sol` | Non-transferable reputation ledger. Gains capped at +10%/period, losses uncapped, genesis awards decay over a year, idle accounts decay lazily, bonded score is protected from decay. |
| `CowNFT.sol` | ERC-721 cow records. Permissionless mint, born **Inert**; status (Inert → Active → SelfSustaining / Memorial) moves only through the rating engine. Herds, correctable metadata CID. |
| `CowRating.sol` | The engine: conviction staking (with early-exit penalty), concentration caps, boosts (thumbs-up), herd bonuses, the funding-need lifecycle, and the rated transfer handshake. |
| `Attestation.sol` | Staked testimony: bonded claims about the real world. Quorum executes (death → Memorial, sale → offline transfer, funding → lifecycle). Disputes are resolved by the pilot operator in the MVP. |
| `interfaces/ITransferValidator.sol` | The seam CowNFT uses to ask CowRating whether a transfer may happen. |

## How the pieces talk to each other

```
                Stasis  <-- the score ledger; everything reads from it
                  ^  ^
      award/     |   |   bond/slash/
     slash/bond  |   |   unbond
                  |   |
            CowRating <-> CowNFT  (moves status, validates transfers)
                ^
                | attestations + bonds
           Attestation
```

Wiring is done once after deploy (no circular constructors), see
`scripts/deploy.js`:

```
Stasis.setModule(CowRating)
Stasis.setModule(Attestation)
CowNFT.setRatingEngine(CowRating)
CowRating.setWiring(CowNFT, Attestation)
```

## Run the local demo (chain + agora + frontend)

```bash
npm install
npm install --prefix frontend
npm test                 # 38 tests: score math, caps, staking, disputes, lifecycle

npm run dev              # one command: hardhat node + agora server + vite dev server
# in a second terminal, the first time only:
npm run deploy:local     # deploy + wire + grant genesis; writes deployed.json
npm run seed             # ~10 synthetic cows in varied life states
```

Then open http://localhost:5173 and connect a wallet.
MetaMask needs the local chain added: network `http://127.0.0.1:8545`,
chain id `31337`, and one of the demo accounts listed when the node starts
(their private keys are printed by `npm run node`).

> **I clicked Connect and got an error** — the app now auto-switches your wallet
> to the chain the demo runs on (and offers to add it to MetaMask). If you
> decline the switch, connect again after switching manually. If MetaMask has
> never seen the local node, go to *Settings → Networks → Add network*:
> chain id `31337`, RPC `http://127.0.0.1:8545`, currency ETH; then import one
> of the accounts printed by `npm run node`. An error like *"missing revert
> data"* mostly means "right chain, wrong state" or "still on another chain".

What you can do in the UI: browse the herd, open a cow, read/start discussion
threads, stake/unstake rating, boost (thumbs-up), mint a new cow, transfer one,
report a funding need of zero (Hans starts with a real need of 500 so the
solver-credit lifecycle is demoable), and report a death.

To reset everything: stop `npm run dev`, delete `server/data.json`, and restart
— the seed is idempotent per fresh chain.

Testnet deploys:

```bash
npm run deploy:sepolia   # needs .env: SEPOLIA_RPC_URL + DEPLOYER_PRIVATE_KEY
npm run deploy:amoy
```

`.env.example` shows the variables for testnet deploys.

## Key rules (education, not code features)

These are the design's spine; every contract enforces a slice of them:

1. **Rating cannot be bought.** None of the contracts take money. Anything you
   want (stake, boost, buy the cow, back a claim) is paid in Stasis, which you
   only earn by being useful over time.
2. **Steady progress beats spikes.** Grand gains are capped at +10% per period;
   bootstrap gets a small fixed floor so new accounts can start.
3. **Lying is expensive.** Attestation bonds are destroyed on a refuted claim.
   There is no upside to a false claim and a real downside to a true one.
4. **No one can corner a cow.** A single account can hold at most 20% of a
   cow's staked rating, so a cow only activates through a crowd of raters.
5. **Commitment is real.** Pulling rating out before the lock period costs up
   to half of it. This is what makes "conviction" mean something.
6. **Liquid becomes steam.** Moving a cow to a new owner consumes rating (a
   buyer's high score discounts it). Selling *offline* is recorded by attestors
   and bypasses the handshake — reality already happened.
7. **Nothing ticks on its own.** All decay is lazy: computed on read,
   persisted only when the account acts.

## Where the MVP plays it safe (pilot-era changes)

These are deliberate simplifications so a first version can exist, each marked
with the piece that replaces it later:

- **Disputes are resolved by the owner** (the pilot operator). Later: a
  multisig / arbitration pool, not a single key.
- **Need-parameters are owner-set.** Blueprint says a weighted-vote setter
  ships in v2.
- **On-chain state holds no prose.** Photos, names and discussions live
  off-chain (IPFS CID + app database); the chain keeps the rating history.
- **`Attestation._findOpen` linearly scans** claims. Fine for a demo with
  dozens; needs an index before a real pilot.
- **Real money / shares are out of scope.** The NFT share market (revenue
  rights) is a separate contract family, deliberately not in the MVP.
- **Genesis decay is one year.** A slow handover to earned reputation; tune
  before the pilot to match real participation rates.

## Roadmap after the basics

1. ✅ Agorá backend (`server/`): cow metadata + discussion threads + evidence
   store. Currently a zero-dependency JSON file; the store layer is swapped for
   SQLite/Postgres before the pilot without touching the endpoints.
2. ✅ Vite + React frontend (`frontend/`): herd → cow detail → discussion →
   boost → mint, wired to the contracts via ethers v6 and the agorá over
   `/api`.
3. ⏭ Sepolia/Amoy demo deployment with ~10 synthetic cows (`npm run
   deploy:sepolia`/`deploy:amoy`; needs `.env` RPC + private key).
4. ⏭ Pilot: parameterise a verifier and the funding till; migrate the
   versioned parameters and constants to constructor/config values; replace the
   single-owner dispute key with a multisig.

See the original whitepaper and architecture blueprint (in the repo root of
`/Users/maros/HoofProof`) for the full rationale.
# Proof of a Hoof — MVP

A blockchain app giving real cows an on-chain record: an NFT whose reputation is
earned — never bought — through community staking, attestation and a
non-transferable score called **Stasis**. Built on an existing EVM network
(testnet first: Sepolia or Amoy).

This is the enhanced MVP from the architecture plan — the fluid rating core
(Phase A) and the perks & collective layer (Phase B):
- **6 contracts**, Solidity 0.8 + OpenZeppelin 5, Hardhat JS, ethers v6.
- **An agorá server** (`server/`, Express + JSON store) for the off-chain prose:
  cow metadata and the Steemit-style discussion threads.
- **A Vite + React frontend** (`frontend/`) connecting to both.
- No custom chain, no consensus changes. Money and *rating* are deliberately
  separate fields of the system.

## The idea in one paragraph

Anyone can mint a cow. The cow is inert until several independent, rated people
commit their reputation to it. Real-world facts about the cow (it exists, it's
cared for, it was sold, it died, its funding need fell to zero, someone worked
real hours on it) are asserted by people who back their word with a bonded
score — reputation as collateral. Ratings are **positive-only thumbs-up** spent
from a refilling **voting power** meter; sustained activity raises your
**momentum** (up to 1.5× on votes and stakes). Real care work earns **sweat
equity** scaled by the project's rating. Gains to reputation are capped so only
steady, patient work compounds; losses are uncapped so lies hurt immediately.
Spendable **Rajas** action-credits, a **GeneralPool** care + gas treasury and
the **HerdCouncil** (reputation-weighted proposals per herd) make the collective
layer concrete. Eventually a cow whose funding need stays at zero becomes
**SelfSustaining** and graduates out of the system's care.

## Contracts (contracts/)

| Contract | Job |
|---|---|
| `Stasis.sol` | Non-transferable reputation ledger. Gains capped at +10%/period, losses uncapped, genesis awards decay over a year, idle accounts decay lazily, bonded score is protected from decay. |
| `CowNFT.sol` | ERC-721 cow records. Permissionless mint, born **Inert**; status (Inert → Active → SelfSustaining / Memorial) moves only through the rating engine. Herds, correctable metadata CID. |
| `CowRating.sol` | The engine: conviction staking (with early-exit penalty), concentration caps, the **voting-power** thumbs-up (cows + images + posts, content folds into the cow's rating), **ethical momentum** (activity decays over 90d, 1x–1.5x on votes and stakes), **sweat-equity rewards** scaled by the project's rating, herd bonuses, the funding-need lifecycle, and the rated transfer handshake. |
| `Attestation.sol` | Staked testimony: bonded claims about the real world. Quorum executes (death → Memorial, sale → offline transfer, funding → lifecycle, **Labor** → sweat-equity award). Disputes are resolved by the pilot operator in the MVP. |
| `GeneralPool.sol` | The "genesis pool": **Rajas** spendable action-credits with Sattva↔Rajas conversion, the momentum-scaled **gas rebate** (more reputation → the pool pays more of your gas), the voluntary no-yield **care pool** per cow, and the platform **value index** (backing / rating / Stasis / Rajas / active cows per epoch). |
| `HerdCouncil.sol` | Reputation-weighted proposals per herd: off-chain body → on-chain hash, member votes weighted by the rating of their own cows in the herd × momentum, on-chain tally with execution signals only. |
| `interfaces/ITransferValidator.sol` | The seam CowNFT uses to ask CowRating whether a transfer may happen. |

## How the pieces talk to each other

```
                     Stasis  <-- the score ledger; everything reads from it
                       ^  ^
       award/          |   |      bond/slash/
      slash/bond       |   |      unbond
                       |   |
                 CowRating <-> CowNFT  (moves status, validates transfers)
                  ^  ^  ^
                  |  |  |  attestations + bonds      Rajas / rebates / index
                  |  |  +-------------------- Attestation     |
                  |  +---------------------------- GeneralPool |
                  +------------------------------- HerdCouncil
```

Wiring is done once after deploy (no circular constructors), see
`scripts/deploy.js`:

```
Stasis.setModule(CowRating)
Stasis.setModule(Attestation)
Stasis.setModule(GeneralPool)     # the pool may award/spend Stasis too
CowNFT.setRatingEngine(CowRating)
CowRating.setWiring(CowNFT, Attestation)
```

## Run the local demo (chain + agora + frontend)

```bash
npm install
npm install --prefix frontend
npm test                 # 53 tests: score math, caps, staking, disputes, lifecycle,
                         # voting power, momentum, sweat equity, pool, council

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
> data"* or *"could not decode result data"* mostly means the running node was
> restarted and is empty (a fresh Hardhat chain has no contracts): re-run
> `npm run deploy:local` and `npm run seed`, or read `scripts/checkDemo.js`
> (`npx hardhat run scripts/checkDemo.js --network localhost`) to see exactly
> what is on the chain right now.

What you can do in the UI: browse the herd, open a cow, read/start discussion
threads (and thumbs-up individual posts), stake/unstake rating, give a cow a
thumbs-up (each spends 20% of your refilling voting power), report real work
hours for sweat equity, convert Sattva↔Rajas, claim the momentum-scaled gas
rebate, mint a new cow, transfer one, report a funding need of zero (Hans
starts with a real need of 500 so the solver-credit lifecycle is demoable),
report a death, and — for cows in a herd — propose and vote on HerdCouncil
proposals (weight = your cows' rating in that herd × momentum). The herd page
also links to an embedded copy of the whitepaper
(`frontend/public/whitepaper.pdf`, a copy of `ProofOfAHoof.pdf`) with its
references.

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
   want (stake, thumbs-up, buy the cow, back a claim, spend Rajas) is paid in
   Stasis or earned Rajas, which you only get by being useful over time.
2. **Steady progress beats spikes.** Grand gains are capped at +10% per period;
   bootstrap gets a small fixed floor so new accounts can start.
3. **Lying is expensive.** Attestation bonds are destroyed on a refuted claim.
   There is no upside to a false claim and a real downside to a true one.
4. **No one can corner a cow.** A single account can hold at most 20% of a
   cow's staked rating, so a cow only activates through a crowd of raters.
5. **Commitment is real.** Pulling rating out before the lock period costs up
   to half of it. This is what makes "conviction" mean something.
6. **Rating is fluid, not per-cow cooldowns.** Mercy of the voting-power meter
   instead of a hard 24h lock: every account has a refilling budget, so steady
   curators stay loud and sudden brigades starve.
7. **Authenticity compounds.** Ratings on a cow's images and posts are ratings
   of the cow — a well-documented project accumulates proven authenticity.
8. **Sweat is rated, not metered.** The same attested hour pays more on a
   well-rated project (`hours × base rate × cow rating / reference`), so people
   are steered toward real care, not hour-farming.
9. **More reputation, less you pay.** High **momentum** (sustained recent
   activity) multiplies your votes and stakes (1x–1.5x), lowers the liquidity a
   cow needs to activate, and qualifies you for the **GeneralPool gas rebate** —
   the platform, not the protocol, subsidises your fees.
10. **Money never votes.** HerdCouncil weight is your cows' rating × momentum,
    and Rajas buys perks and fee relief, never influence.
11. **Liquid becomes steam.** Moving a cow to a new owner consumes rating (a
    buyer's high score discounts it). Selling *offline* is recorded by attestors
    and bypasses the handshake — reality already happened.
12. **Nothing ticks on its own.** All decay is lazy: computed on read,
    persisted only when the account acts.

## Where the MVP plays it safe (pilot-era changes)

These are deliberate simplifications so a first version can exist, each marked
with the piece that replaces it later:

- **Disputes are resolved by the owner** (the pilot operator). Later: a
  multisig / arbitration pool, not a single key.
- **Need-parameters are owner-set.** Blueprint says a weighted-vote setter
  ships in v2.
- **The gas subsidy is a claimable rebate**, not a paymaster relayer. The
  `GeneralPool` treasury funds it; a sponsored-transaction relayer (platform
  signs/relays, pool covers the cost) is the production shape.
- **Visibility is server-enforced first** (record-level `visibility`
  private/internal/external/public); a strict on-chain flag ships in the next pass.
- **HerdCouncil votes cannot be delegated** and proposals carry no treasury
  power yet — the council advises, humans execute.
- **On-chain state holds no prose.** Photos, names and discussions live
  off-chain (IPFS CID + app database); the chain keeps the rating history.
- **`Attestation._findOpen` linearly scans** claims. Fine for a demo with
  dozens; needs an index before a real pilot.
- **Real money / shares are out of scope.** The NFT share market (revenue
  rights) is a separate contract family, deliberately not in the MVP. The care
  pool is strictly voluntary and no-yield accounting.
- **Genesis decay is one year.** A slow handover to earned reputation; tune
  before the pilot to match real participation rates.

## Roadmap after the basics

1. ✅ Agorá backend (`server/`): cow metadata + discussion threads + evidence
   store. Currently a zero-dependency JSON file; the store layer is swapped for
   SQLite/Postgres before the pilot without touching the endpoints.
2. ✅ Vite + React frontend (`frontend/`): herd → cow detail → discussion →
   thumbs-up → mint, wired to the contracts via ethers v6 and the agorá over
   `/api`.
3. ✅ Phase A — fluid rating core: voting-power meter (replaces the 24h
   cooldown), positive-only votes on cows + images + posts (content folds into
   the cow's rating), ethical momentum (1x–1.5x on votes & stakes, weighted
   activation, decay over 90d), and `Kind.Labor` sweat equity (attested hours ×
   rating-scaled factor).
4. ✅ Phase B — perks & collective layer: `GeneralPool` (Rajas ledger +
   Sattva↔Rajas conversion, momentum-scaled gas rebate funded from the pool,
   voluntary no-yield care pool, platform value index), `HerdCouncil`
   (reputation-weighted proposals + on-chain tally), and record-level
   visibility (`private/internal/external/public`, server-enforced first).
5. ⏭ Sepolia/Amoy demo deployment with ~10 synthetic cows (`npm run
   deploy:sepolia`/`deploy:amoy`; needs `.env` RPC + private key).
6. ⏭ Pilot: parameterise a verifier and the funding till; migrate the
   versioned parameters and constants to constructor/config values; replace the
   single-owner dispute key with a multisig; move the gas subsidy from a
   claimable rebate to a sponsored-transaction relayer.

See the original whitepaper and architecture blueprint (in the repo root of
`/Users/maros/HoofProof`) for the full rationale.
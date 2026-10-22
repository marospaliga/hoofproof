# Proof of a Hoof — MVP

A blockchain app giving real cows an on-chain record: an NFT whose reputation is
earned — never bought — through community staking, attestation and a
non-transferable score called **Stasis**. Built on an existing EVM network
(testnet first: Sepolia or Amoy).

This is the enhanced MVP from the architecture plan — the fluid rating core
(Phase A), the perks & collective layer (Phase B), and the identities, oracle
evidence & charitable causes (Phase C):
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
score — reputation as collateral. Ratings are **positive-only thumbs-up**, and a
vote is simply **rating spent**: the amount you put behind a cow is the amount it
gains, so wanting more influence means giving more of your own score. Real care
work earns **sweat equity** scaled by the project's rating. Gains to reputation
are capped so only steady, patient work compounds; losses are uncapped so lies
hurt immediately. Spendable **Rajas** action-credits, a **GeneralPool** care +
gas treasury and the **HerdCouncil** (reputation-weighted proposals per herd)
make the collective layer concrete. Eventually a cow whose funding need stays at
zero becomes **SelfSustaining** and graduates out of the system's care.

## Contracts (contracts/)

| Contract | Job |
|---|---|
| `Stasis.sol` | Non-transferable reputation ledger. Gains capped at +10%/period, losses uncapped, genesis awards decay over a year, idle accounts decay lazily, bonded score is protected from decay. |
| `CowNFT.sol` | ERC-721 cow records. Permissionless mint, born **Inert**; status (Inert → Active → SelfSustaining / Memorial) moves only through the rating engine. Herds, correctable metadata CID. |
| `CowRating.sol` | The engine: conviction staking (with early-exit penalty), concentration caps, the **rating-spend vote** (cows + images + posts, content folds into the cow's rating; the amount you give is the amount the cow gains), **sweat-equity rewards** scaled by the project's rating, an active-rater registry that the cycle credit reads, herd bonuses, the funding-need lifecycle, and the rated transfer handshake. |
| `Attestation.sol` | Staked testimony: bonded claims about the real world. Quorum executes (death → Memorial, sale → offline transfer, funding → lifecycle, **Labor** → sweat-equity award). Disputes are resolved by the pilot operator in the MVP. |
| `GeneralPool.sol` | The "genesis pool": **Rajas** spendable action-credits with Sattva↔Rajas conversion, the **gas rebate** for accounts with protection activity, the voluntary no-yield **care pool** per cow, the platform **value index** (backing / rating / Stasis / Rajas / active cows per epoch), **charitable causes** (GoFundMe-style escrow: anyone opens a cause, backers contribute ether, the creator releases it toward the real goal), and the **movement cycle**: `settleCycle()` measures the field's positive growth since the last settle and pays a gain-capped credit pool (`backerShareBps` to that cycle's backers pro rata by contribution, the rest to its active raters pro rata by activity) — **rating flows only when the whole field demonstrably moved, never when you pay**. |
| `HerdCouncil.sol` | Reputation-weighted proposals per herd: off-chain body → on-chain hash, member votes weighted by the rating of their own cows in the herd, on-chain tally with execution signals only. |
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
npm test                 # 117 tests: score math, caps, staking, disputes, lifecycle,
                         # rating-spend votes, sweat equity, pool, council,
                         # causes + cycle credit, beta clock

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
threads (and rate individual posts), stake/unstake rating, rate a cow (a vote is
simply rating spent — wanting more influence means giving more of your score),
report real work
hours for sweat equity, convert Sattva↔Rajas, claim the gas rebate, mint a new
cow, transfer one, report a funding need of zero (Hans
starts with a real need of 500 so the solver-credit lifecycle is demoable),
report a death, and — for cows in a herd — propose and vote on HerdCouncil
proposals (weight = your cows' rating in that herd). Phase C adds:
claim a **profile** (name / bio / avatar / links) shown across threads, votes
and cards; upload **wallet-signed evidence** on any cow (photos, vet records,
receipts) which raters can then rate; open or back a **charitable cause** and
watch the **movement cycle** settle — backers and this cycle's active raters
share a credit pool sized by how much the whole field grew. The herd page
also links to an embedded copy of the whitepaper
(`frontend/public/whitepaper.pdf`, a copy of `ProofOfAHoof.pdf`) with its
references.

To reset everything: stop `npm run dev`, delete `server/data.json`, and restart
— the seed is idempotent per fresh chain.

## The beta clock

A private chain, fake money, and a **shorter ruler**.

The contracts know nothing about "beta". They compare timestamps against
numbers the owner sets, and `scripts/timings.js` holds two profiles of those
numbers. Nothing else differs between them: same rules, same arithmetic, same
events, same revert messages. Only the deadlines move.

| window | production | beta | what it gates |
|---|---|---|---|
| `lockPeriod` | 30d | 1d | how long a rating lien stays locked before you can pull it out |
| `needPeriod` | 30d | 1d | how often a funding need may be re-recorded |
| `careWindow` / `laborWindow` / `needWindow` | 90d | 3d | how long a protection anchor stays warm |
| `headStartWindow` | 30d | 1d | how long a provisional head start waits for corroboration |
| `laborLockPeriod` | 30d | 1d | the lock on a labour commitment |
| `tierCommit1` / `tierCommit2` | 90d / 180d | 3d / 6d | the conviction ramp to the two longer tiers |
| `contentDormantWindow` | 180d | 6d | when a thread goes quiet |
| `momentumDecay` | 90d | 3d | the activity ledger's slide |
| `genesisLife` / `idleGrace` / `idleDecayWindow` | 365d / 180d / 365d | 12d 4h / 6d / 12d 4h | how fast a reputation fades |
| `cyclePeriod` | 6h | 12m | the movement cycle |
| `gasRebatePeriod` | 7d | 5h 36m | the gas rebate cooldown |
| `fastPathDelay` / `challengeWindow` | 48h / 3d | 1h 36m / 2h 24m | moderation: the dominance fast path and the challenge window |
| `minDuration` / `maxDuration` (council) | 1d / 30d | 48m / 1d | how long a proposal lives |

Every beta number is exactly the production number divided by 30 — **one beta
day is one production month**. `zeroStreakRequired` (three periods) is a
count, not a duration, so it stays where it is.

```bash
npm run timings            # what the chain is running on right now
npm run timings:beta       # switch the local chain to the short ruler
npm run timings:production # put the real ruler back
WARP=2d npm run warp       # move the chain clock forward (private chain only)
```

A local deploy starts on the beta clock; a testnet deploy starts on the
production one. Override either with `POHAI_TIMINGS=beta|production` (deploy)
or `PROFILE=beta|production` (the standalone script).

`WARP` is how a tester crosses a deadline without waiting for it: stake a
cow's rating, `WARP=2d npm run warp`, and the lock is up. Time travel is
refused on any network that is not local, so it can never touch a shared
testnet. The seed script fast-forwards by exactly one funding-need period
(plus a cycle), read off the chain, so the demo is valid on either ruler.

The UI never hardcodes a deadline — it reads the live windows from the chain
(`GET /api/clock`) and shows the current ruler in the top bar, so "one update
per period" means one day here and one month there.

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
9. **A vote is rating spent.** The amount you put behind a cow is exactly the
   rating it gains — there is no size ladder, no multiplier and no dilution.
   Wanting more influence means spending more of your own score, and `unvote`
   hands it straight back. Protection activity qualifies you for the
   **GeneralPool gas rebate** — the platform, not the protocol, subsidises fees.
10. **Money never votes.** HerdCouncil weight is your cows' rating,
    and Rajas buys perks and fee relief, never influence.
11. **Liquid becomes steam.** Moving a cow to a new owner consumes rating (a
    buyer's high score discounts it). Selling *offline* is recorded by attestors
    and bypasses the handshake — reality already happened.
12. **Nothing ticks on its own.** All decay is lazy: computed on read,
    persisted only when the account acts.
13. **Credit follows the field, never the cheque.** Backing a cause earns no
    instant rating. Once per cycle the pool measures how much the whole
    ecosystem grew and thanks that cycle's contributors *and* active raters
    from a gain-capped pool — a big donation only buys a share of a gift that
    exists only if the field actually moved.

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
- **The movement cycle is open-called and short.** Anyone may `settleCycle()`
  (like `snapshotIndex`), and the demo runs a 6 h period purely to show the
  loop (12 min on the beta clock); the owner re-tunes `cyclePeriod` /
  `backerShareBps` / `creditRatioBps` / `maxCycleCredit` before a pilot. Missed
  settles roll contributions into the next window.
- **Real money / shares are out of scope.** The NFT share market (revenue
  rights) is a separate contract family, deliberately not in the MVP. The care
  pool is strictly voluntary and no-yield accounting.
- **Genesis decay is one year.** A slow handover to earned reputation; tune
  before the pilot to match real participation rates.
- **The clock is owner-set, not hardcoded.** Every deadline lives in storage
  and moves with one call (`CowRating.setTimings`, `Stasis.setDecayWindows`,
  and the existing per-contract setters). The beta profile only shortens them;
  the rules that read them are untouched.

## Roadmap after the basics

1. ✅ Agorá backend (`server/`): cow metadata + discussion threads + evidence
   store. Currently a zero-dependency JSON file; the store layer is swapped for
   SQLite/Postgres before the pilot without touching the endpoints.
2. ✅ Vite + React frontend (`frontend/`): herd → cow detail → discussion →
   rate → mint, wired to the contracts via ethers v6 and the agorá over
   `/api`.
3. ✅ Phase A — fluid rating core: positive-only voices on cows + images + posts
   (content folds into the cow's rating; the amount given is the amount gained),
   and `Kind.Labor` sweat equity (attested hours ×
   rating-scaled factor).
4. ✅ Phase B — perks & collective layer: `GeneralPool` (Rajas ledger +
   Sattva↔Rajas conversion, protection-gated gas rebate funded from the pool,
   voluntary no-yield care pool, platform value index), `HerdCouncil`
   (reputation-weighted proposals + on-chain tally), and record-level
   visibility (`private/internal/external/public`, server-enforced first).
5. ✅ Phase C — identities, oracle evidence & charitable causes: per-wallet
   profiles and activity feeds on the agorá; signature-verified evidence
   uploads (multipart + EIP-191) that raters can rate on-chain; causes
   escrowed in the `GeneralPool` with a movement-driven cycle credit for
   backers and active raters (no rating is ever bought with money).
6. ⏭ Sepolia/Amoy demo deployment with ~10 synthetic cows (`npm run
   deploy:sepolia`/`deploy:amoy`; needs `.env` RPC + private key).
7. ⏭ Pilot: parameterise a verifier and the funding till; migrate the
   versioned parameters and constants to constructor/config values; replace the
   single-owner dispute key with a multisig; move the gas subsidy from a
   claimable rebate to a sponsored-transaction relayer.

See the original whitepaper and architecture blueprint (in the repo root of
`/Users/maros/HoofProof`) for the full rationale.
# Rating methodology — what the numbers mean and where they come from

The chain enforces. The server only displays. Every figure under `/api/ratings`,
`/api/trending`, `/api/ledger`, `/api/curators` and `/api/authors` is recomputed
from public contract events; `scripts/recomputeRatings.js` replays the same logs
independently. If this server ever disagrees with the chain, the chain wins.

> **Deadlines are live, not fixed.** Every window this document mentions (the
> stake lock, the funding-need period, the head-start window, the moderation
> timelock, the council proposal lifetime, the movement cycle) is owner-settable
> and read back from the chain. `GET /api/clock` returns the numbers currently
> in force. The durations quoted below are the production defaults; the beta
> chain runs the same rules on a ruler shortened 30× — see *The clock* at the
> end.

## Rating = voiced Stasis (the one substance)

- A cow's rating **is** the Stasis its backers have voiced at it. A vote is not a
  shadow counter: it moves score into a lien (`Stasis.voiced`). `cowRating(tokenId)`
  is exactly the sum of the liens pointed at that cow.
- Voicing does **not** reduce voting weight: `effectiveScore` (the vote weight
  basis) is untouched, only `freeScore` (= `effectiveScore − bonded − voiced`)
  drops. So a backer keeps their field-level power while their Stasis backs the cow.
- A lien cannot be spent, staked or double-committed. Withdrawing it (unvote,
  stale reap) returns it to the free pool and subtracts the rating: rating never
  floats free of the Stasis behind it.

## A vote is just rating spent

- There is **one kind of vote**. A voice carries no size ladder, no momentum
  multiplier and no kind weighting: the amount you pass *is* the rating added to
  the cow (and to the content, if you voted on content). Voting harder means
  spending more.
- Your rating **is** your budget. Committing `n` voices `n` and leaves you
  `freeScore − n` to spend elsewhere. There is no separate power meter and no
  refill timer; the only bound is the rating you actually hold.
- There is **no dilution and no zero-sum pool**: nothing is ever trimmed from
  an older vote to make room. A vote simply fails (`InsufficientFree`) when you
  have spent more rating than you hold.
- `unvote` (or a permissionless reap of a dormant lock) hands the rating straight
  back. Voting and backing are the same action, so `boost` (whole cow) and
  `vote` (content) are two entry points to one spend.
- Stakes are the *other* commitment: they bond score (`Stasis.bond`) toward
  activation and are not voice. A lien and a bond both draw on the same free
  Stasis, so an account that has voiced everything may fall below the 100-Stasis
  claim bond and must `unvote` to make room.

## Content and authorship

- Posts (kind 2) and images/evidence (kind 1) are claimed on-chain via
  `registerContent` (first claim wins) or auto-claimed by the first voter.
  Attributed votes (`vote(…, author)`) must name the registered author.
- Rating is **not** weighted by what it points at: a voice of 100 adds 100 to
  the content and 100 to the cow, whether it is evidence, a post or a direct
  cow boost.
- Author award per vote = `amount × 10% × totalRatingPoints / (totalRatingPoints
  + amount)` — small votes pay ~full 10%, field-moving votes are damped.
- Awards **transfer** a slice of the voter's voiced lien to the author; they never
  mint. Total supply is unchanged, the author receives real (now-free) Stasis, and
  the cow keeps the remaining rating. Awards pay only when the content is
  protection-linked AND the cow's protection anchor is live (Active + fresh Care
  quorum / Labor / need record). Self-votes are allowed and logged (`isSelf`),
  kept honest by damping.
- Content with no vote/heartbeat inside `contentDormantWindow` (180d) goes
  dormant: new votes revert, old locks become reapable.

## Labor and care add to the cow

- Labor reward = `hours × sweatBaseRate × factor`, factor scaled by the cow's own
  rating (0.2x–3x). The worker chooses `laborCommitBps` (0–100%): the committed
  share is voiced back at the cow as a lien, locked for `laborLockPeriod` (30d)
  and then releasable. So sweat equity becomes rating, and rating is backed by
  the Stasis the worker actually earned.


## Conviction staking (proof-of-stake × proof-of-time)

- Tiers: flexible 1.00x, 90-day 1.25x, 180-day 1.50x. Weight ramps from 1.00x to
  the tier cap over the commit period, accrued lazily on touch (`pokeStake` is
  permissionless). Early exits follow the existing penalty curve × tier
  multiplier. Top-ups must keep the tier.

## Protection anchor and payoffs

- Anchor = cow Active AND (Care quorum < 90d OR Labor executed < 90d OR need
  record < 90d). All Stasis gains (labor, solver, cycle) and all ETH releases
  (care earmarks, withdrawals, care redemption, cause spends) require a live
  anchor and/or cite an executed claim id as proof. Author awards do not mint —
  they transfer the voter's lien.
- FundingNeed quorum is 2; solver awards need a corroborator other than the
  solver. Large ETH releases need a prior-block `approveSpend`.
- The movement cycle measures protection-weighted deltas (care quorums, labor
  hours, graduations, cows; backing is a minor term). Backing-only growth moves
  ~zero, so no credit exists without protection.

## Trending

`recent` = event-logged vote/stake weight inside a trailing block window,
tie-broken by lifetime rating. It is a display sort, never a payout input.

## Oracle credibility

`oracleCred[account]` accumulates the author awards an account actually received.
Registering a protection-linked document grants a provisional head start of
`cred × 5%` (capped at 200) — but the head start is **not free rating**: the
author pledges it from their own free Stasis, so every point of rating stays
backed. The doc arrives trusted, but the pledge is released (`reapProvisional`)
unless an independent vote corroborates within 30 days (self-votes and heartbeats
don't count). Newcomers start at zero and must be rated; proven documenters scale.

## Care redemption (Stasis → real money, one way)

- Real care money sits in a per-cow pool (`GeneralPool.carePoolOf`), earmarked
  against an executed protection claim. The cow's **rating is its credit line**:
  you may burn at most `min(recorded need, rating)` Stasis at a time.
- `redeemCare(tokenId, stasisAmount, claimRef)` burns the caller's Stasis (worker
  or cow owner) and releases `stasisAmount × careRateWei` (default 0.001 ETH per
  point) from that cow's pool. One redemption per claim; large releases need a
  prior-block `approveSpend`.
- **Burned Stasis is gone for good** — no escrow, no recovery function. The
  social layer re-votes value back if the herd judges it, because recovery is a
  human principle, not machinery. `/api/care/:tokenId` reports the pool, the
  credit line and every redemption.


## Moderation (rating-backed democracy)

Any anchored photo/post can be proposed for hiding or restoring. The proposer
counts first with their full standing (score). A 66% supermajority
of expressed weight decides alone after a 48h timelock; otherwise a 3-day
challenge window needs a majority plus ≥2 distinct raters. Execution only flips
a reversible server visibility flag off an executed on-chain proposal
(`POST /api/moderation/apply` verifies execution first) — files stay, the herd
stops seeing them, and a counter-proposal (or the herd council) can appeal.
Tune via `Moderation.setPolicy`.

Hiding also **freezes the content on-chain**: hidden liens cannot be unvoted, and
anyone may then call `CowRating.slashContent(key, batch)` to burn up to
`moderationSlashBps` (50%) of each voter's lien, destroying the rating it carried
with it. Restoring unfreezes the survivors; already-burned Stasis is not refunded.
This is the on-chain cost of backing a fraud — the deterrent that makes voice
expensive to waste.

## The clock

The system has exactly two time settings per window, and the owner picks
between them with one call. There is no "beta mode" in the contracts — no
branch, no `if (beta)`. The rules compare a timestamp against a number; the
number is what moves.

- `CowRating.setTimings(...)` moves every progression deadline at once: the
  stake lock, the funding-need period, the three protection-anchor windows,
  the head-start window, the labour lock, both conviction tiers, the activity
  decay, the content dormancy and the zero-streak count.
- `Stasis.setDecayWindows(...)` moves the reputation-fade windows.
- `GeneralPool.setCycle` / `setGasRebate`, `Moderation.setPolicy` and
  `HerdCouncil.setDurationLimits` move the cadence windows.

`scripts/timings.js` is the single table of both profiles. The beta profile is
the production profile divided by 30 — one beta day is one production month —
so a tester can walk conviction, need periods, dormancy, corroboration and
moderation inside an afternoon. `npm run timings` prints the live clock;
`npm run timings:beta` / `:production` switch it; `WARP=2d npm run warp` moves
the chain's clock forward on a private chain so a deadline can be crossed
without waiting for it.

Because the rules never change, every figure in this document means the same
thing on either ruler; only "how long" moves. `GET /api/clock` reports the
windows currently in force and which profile they match.

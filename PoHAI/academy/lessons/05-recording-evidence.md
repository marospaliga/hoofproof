# Lesson 5 — Recording evidence well

HoofProof's whole promise is *verifiable* protection. The chain can verify
that evidence exists, is attributed, and was rated — it cannot verify that
your photo is of this cow on this day. That gap is closed by **how you
document**. Good documentation is a skill; this lesson teaches it.

## The four properties of strong evidence

1. **Attributable** — posted by a named account with a stake in the outcome.
   Anonymous evidence is worth almost nothing here; your reputation is the
   collateral. Note: you never attach your *private key* to anything —
   attribution happens by signing transactions from your wallet.
2. **Specific** — dates, times, measurements. "Cow #4, 14 Oct, 06:40, rectal
   temp 39.8°C, reduced feed intake since yesterday evening." Anyone can
   verify or contest a specific claim; nobody can contest "she seemed off".
3. **Visual** — photos and video where possible. Same cow from the same angle
   across time beats one dramatic photo. Show the ear tag.
4. **Honest about uncertainty** — "possible X, would need a vet to confirm"
   is strong evidence. Overclaiming is how oracle credibility dies.

## On-chain anchoring and double hashing

When you register evidence or a post on-chain, the registry stores a
*double hash*: the CID hash of your content, itself hashed into a content
key bound to the cow and kind. You are not uploading your photo to the
blockchain — you are publishing an immutable fingerprint. Anyone holding the
file can prove it is the exact file that was rated. This is why deleting a
file off the server never erases the on-chain record, and why a hidden
(restricted) post is reversible: the moderation system changes visibility,
never the chain.

## Protection-linked evidence

Evidence can be marked **protection-linked** — it documents care, labor, or
need in a way that supports the cow's protection anchor. Protection-linked
posts are the ones raters should take most seriously, because they are the
ones the economic system is built on. (The anchor itself comes from
attested claims — labor hours, care quorums, funding needs — this is
corroborating context, not a substitute.)

## Rating evidence you disagree with

You will read evidence you think is wrong. The system's answer is not
deletion — it is **your voice**. Downvoting doesn't exist; instead, rate the
competing evidence up, and let zero-sum voice do the rest. If evidence is
fraudulent or harmful, moderation proposals exist, decided by rating weight,
reversible on appeal. Reputation is the judge.

## Common failure modes

- **Outdated photos recycled** as fresh evidence — raters get good at spotting
  this; it is one of the fastest ways to burn credibility.
- **Vague sourcing**: "the vet says" — which vet? Will they attest?
- **Emotional overclaiming**: urgency is not evidence. A calm, dated,
  specific post moves the field more than a panicked one.

## Quiz

1. Why does HoofProof store hashes of evidence rather than the files?
   - a) Storage is cheaper on-chain
   - b) A hash is an immutable fingerprint that proves a specific file was
     rated, without putting it on-chain ✓
   - c) To hide the evidence from raters
2. Which is the strongest evidence post?
   - a) "The cow is sick, something must be done!"
   - b) "Cow #4, 14 Oct 06:40: rectal temp 39.8°C (normal <39.0), feed intake
     down since last evening, photo of ear tag attached; possible infection,
     needs vet confirmation." ✓
   - c) "My friend, who is basically a vet, says it's serious."
3. You believe a protection-linked post is fraudulent. What does the system
   want you to do?
   - a) Delete it
   - b) Rate the competing evidence with your voice; use moderation only for
     real fraud, decided by rating weight and reversible on appeal ✓
   - c) Spam comments calling it fake

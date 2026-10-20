import { BrowserProvider, Contract, encodeBytes32String, Interface, keccak256, toUtf8Bytes, ZeroAddress } from "ethers";
import abis from "../abis.js";
import { DEFAULT_CONTRACTS, STATUS_NAMES } from "../config.js";

export class ChainError extends Error {}

// Error selector -> name, built from every ABI the UI knows about. ethers
// v6 sometimes reports tx reverts as "(unknown custom error)" without looking
// the name up; we resolve the 4-byte selector ourselves so the toast can still
// translate it (e.g. CooldownActive -> "once per day").
const ERROR_SELECTORS = (() => {
  const map = new Map();
  for (const abi of Object.values(abis)) {
    const iface = new Interface(abi);
    for (const frag of Object.values(iface.fragments)) {
      if (frag.type !== "error") continue;
      const selector = iface.getError(frag.name).selector.toLowerCase();
      if (!map.has(selector)) map.set(selector, frag.name);
    }
  }
  return map;
})();

// The chains this demo expects to run on. Keyed by the network name the deploy
// script reports (see deployed.json / the agorá /api/config).
export const CHAINS = {
  hardhat: { chainId: 31337, name: "Hardhat local", rpc: "http://127.0.0.1:8545" },
  localhost: { chainId: 31337, name: "Hardhat local", rpc: "http://127.0.0.1:8545" },
  sepolia: { chainId: 11155111, name: "Sepolia", rpc: "https://1rpc.io/sepolia" },
  amoy: { chainId: 80002, name: "Amoy", rpc: "https://rpc-amoy.polygon.technology" },
};

export function chainFor(network) {
  return CHAINS[network] || CHAINS.hardhat;
}

async function rawChainId(provider) {
  // Raw eth_chainId — reflects what the wallet is actually on right now,
  // without ethers' cached-network surprises.
  return Number(await provider.send("eth_chainId", []));
}

async function switchToChain(provider, chain) {
  const hex = "0x" + chain.chainId.toString(16);
  try {
    await provider.send("wallet_switchEthereumChain", [{ chainId: hex }]);
  } catch (err) {
    // 4902 = the chain is not set up in this wallet yet; add it, then switch.
    if (err?.code === 4902 || /Unrecognized chain|wallet_addEthereumChain/i.test(err?.message || "")) {
      await provider.send("wallet_addEthereumChain", [
        {
          chainId: hex,
          chainName: "Proof of a Hoof — " + chain.name,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [chain.rpc],
        },
      ]);
      await provider.send("wallet_switchEthereumChain", [{ chainId: hex }]);
    } else {
      throw new ChainError(
        `This demo runs on the “${chain.name}” chain (id ${chain.chainId}). ` +
          "Please switch your wallet to it in MetaMask and connect again."
      );
    }
  }
}

export function applyDeployed(config) {
  // The server knows the freshly deployed addresses; fall back to local defaults.
  return {
    ...DEFAULT_CONTRACTS,
    ...(config || {}),
  };
}

// Translate contract reverts and ethers internals into plain English for the
// UI toast. Custom error names can arrive via err.info.error / err.error, or
// inlined in the message as 'CustomError()'.
export function friendlyError(err) {
  if (err instanceof ChainError) return err.message;

  const message = err?.shortMessage || err?.reason || err?.message || String(err);
  const name =
    err?.info?.error?.name ||
    err?.error?.name ||
    (typeof message === "string" && message.match(/'([A-Za-z]+)(?:\(\))?'/)?.[1]) ||
    "";

  const known = {
    InsufficientFree: "You don't have enough free Stasis for that. Score is earned by steady activity; this demo seeds it to the demo accounts listed when the node starts.",
    InsufficientBonded: "You don't have that much Stasis locked as collateral.",
    ConcentrationCap: "One account may hold at most 20% of a cow's backing — this cow needs more, different raters.",
    CooldownActive: "Your voting power is spent. It refills continuously — come back in a few hours.",
    NoVotingPower: "Your voting power is spent — every thumbs-up uses 20% of it. It refills continuously over the next day.",
    InvalidBoost: "A thumbs-up must use between 1% and 10% of your score.",
    WeightTooLow: "Your score is too low to add any weight right now.",
    PeriodNotElapsed: "The funding need can only be re-recorded once per 30-day period.",
    IsMemorial: "Memorial cows are frozen — no actions can be taken on them.",
    ZeroAmount: "The amount must be greater than zero.",
    InsufficientStake: "You have not staked that much on this cow.",
    NotTokenOwner: "This action requires the cow's owner.",
    AlreadySupported: "You already supported this claim.",
    AlreadyRegistered: "This post is already anchored on-chain by someone else — first claim wins.",
    AuthorMismatch: "That vote names the wrong author for this post. Check who anchored it first.",
    UnknownContent: "This post isn't anchored on-chain yet — register it first, then vote.",
    DormantContent: "This thread went dormant (no activity inside the window). A heartbeat reactivates it.",
    VoiceBudgetExceeded: "Your voice is fully locked elsewhere. Unvote something or let dilution free it.",
    NothingLocked: "You have no voice locked on that yet.",
    TierMismatch: "Top-ups must keep the original conviction tier. Unstake first to switch tiers.",
    BadTier: "Unknown conviction tier (0 flexible, 1 = 90d, 2 = 180d).",
    TooManyKeys: "Reap at most 20 locks per transaction.",
    NoAnchor: "That cow has no live protection anchor (fresh Care quorum, Labor or need record) — payoffs are locked until protectors report.",
    NoProtection: "The gas rebate subsidises protectors: do protection work first (care, labor, need reports, protection-linked curation).",
    NoProof: "Cite an executed protection claim id as proof for this release.",
    ProofMismatch: "That proof concerns a different cow than this cause serves.",
    NotApproved: "Large releases need a prior approval in an earlier block. Approve first, then release.",
    UnknownItem: "That photo or post isn't anchored on-chain yet — only anchored items can be moderated.",
    ItemMismatch: "That item belongs to a different cow.",
    ProposalOpen: "There's already an open moderation case on this item — vote on it instead of opening another.",
    AlreadyVoted: "You've already taken a side on this case.",
    TooEarly: "Not executable yet — the timelock (dominant) or challenge window (contested) hasn't passed.",
    WindowClosed: "The challenge window has closed — execute or accept the outcome.",
    QuorumNotMet: "A contested case needs a majority plus distinct raters before it can execute.",
    AlreadyClaimed: "You can only claim the gas rebate once per period.",
    NoMomentum: "The gas rebate goes to raters with sustained momentum — your 1x is not enough yet. Stay active and claim again later.",
    EmptyPool: "The GeneralPool treasury is empty for that action.",
    NotAMember: "Only members of that herd (cow owners in it) may do this.",
    NotAResident: "Reputation weight is calculated from cows you own in that herd.",
    AlreadyVoted: "Each member votes once per proposal.",
    VotingClosed: "The vote window has closed (or the proposal does not exist yet).",
    AlreadyProposed: "A proposal with this hash already exists.",
    NotExecutable: "This proposal cannot be finalized (unknown or already decided).",
    NoSuchEvent: "That cause does not exist on-chain.",
    EventClosed: "That cause has been closed by its creator.",
    NotEventCreator: "Only the creator of a cause can release its escrow.",
    CannotSpend: "A cause can only release what was actually raised.",
    CycleNotElapsed: "The cycle has not rolled over yet — settle again after the period.",
    EmptyCid: "A metadata reference (cid) is required for the cause.",
  };

  if (name && known[name]) return known[name];

  // ethers v6.17 often carries the raw revert data on err.data even when it
  // reports "(unknown custom error)" — resolve the selector ourselves.
  const data = err?.data;
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    const revertName = ERROR_SELECTORS.get(data.slice(0, 10).toLowerCase());
    if (revertName && known[revertName]) return known[revertName];
  }

  if (/missing revert data|call exception/i.test(message)) {
    return "The chain call returned nothing — your wallet is probably on the wrong chain. You should be on Hardhat local (id 31337).";
  }
  return message;
}

export async function connectWallet(networkName = "hardhat") {
  if (!window.ethereum) {
    throw new ChainError("No wallet found. Install MetaMask (or another injected wallet).");
  }
  const provider = new BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);

  const target = chainFor(networkName);
  if ((await rawChainId(provider)) !== target.chainId) {
    await switchToChain(provider, target);
    // Poll briefly for the switch to land (MetaMask fires chainChanged async).
    for (let i = 0; i < 5; i++) {
      if ((await rawChainId(provider)) === target.chainId) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  const signer = await provider.getSigner();
  const account = await signer.getAddress();
  return { provider, signer, account, chainId: await rawChainId(provider) };
}

export function getContracts(signer, config) {
  const c = applyDeployed(config);
  return {
    stasis: new Contract(c.stasis, abis.stasis, signer),
    cowNFT: new Contract(c.cowNFT, abis.cowNFT, signer),
    cowRating: new Contract(c.cowRating, abis.cowRating, signer),
    attestation: new Contract(c.attestation, abis.attestation, signer),
    generalPool: new Contract(c.generalPool, abis.generalPool, signer),
    herdCouncil: new Contract(c.herdCouncil, abis.herdCouncil, signer),
    moderation: c.moderation && abis.moderation ? new Contract(c.moderation, abis.moderation, signer) : null,
    academy: c.academy && abis.academy ? new Contract(c.academy, abis.academy, signer) : null,
  };
}

export async function enrichCow(record, contracts) {
  const { cowNFT, cowRating, generalPool } = contracts;
  const tokenId = record.tokenId;
  const [status, rating, backing, funding, owner, carePool, cow] = await Promise.all([
    cowNFT.statusOf(tokenId),
    cowRating.ratingOf(tokenId),
    cowRating.totalStaked(tokenId),
    cowRating.funding(tokenId),
    cowNFT.ownerOf(tokenId),
    generalPool.carePoolOf(tokenId),
    cowNFT.cows(tokenId),
  ]);
  return {
    ...record,
    status: Number(status),
    statusName: STATUS_NAMES[Number(status)],
    rating: Number(rating),
    backing: Number(backing),
    fundingNeed: Number(funding.need),
    carePool: Number(carePool),
    herdId: Number(cow.herdId),
    onChainOwner: owner,
  };
}

export async function myReputation(contracts, account) {
  const { stasis, cowRating } = contracts;
  const [score, bonded, voiced, free, votingPower, momentum, locked, budget, protection] = await Promise.all([
    stasis.effectiveScore(account),
    stasis.bonded(account),
    stasis.voiced(account),
    stasis.freeScore(account),
    cowRating.votingPowerOf(account),
    cowRating.momentumBps(account),
    cowRating.voiceLocked(account),
    cowRating.voiceBudget(account),
    cowRating.protectionActivity(account),
  ]);
  return {
    score: Number(score),
    bonded: Number(bonded),
    voiced: Number(voiced),
    free: Number(free),
    votingPower: Number(votingPower),
    momentum: Number(momentum),
    voiceLocked: Number(locked),
    voiceBudget: Number(budget),
    protection: Number(protection),
  };
}

// Preview a content/cow vote without sending: the credited rating (kind-weighted),
// the damped author award, voice use and whether it dilutes priors. All view
// calls — no gas. The curve is flat unless the owner has switched it on.
export async function previewVote(contracts, account, kind, bps) {
  const { stasis, cowRating } = contracts;
  const [score, momentum, locked, budget, total, dBps, eBps, cBps] = await Promise.all([
    stasis.effectiveScore(account),
    cowRating.momentumBps(account),
    cowRating.voiceLocked(account),
    cowRating.voiceBudget(account),
    cowRating.totalRatingPoints(),
    cowRating.discussionBps().catch(() => 4000n),
    cowRating.evidenceBps().catch(() => 10000n),
    cowRating.cowVoteBps().catch(() => 10000n),
  ]);
  const raw = Math.floor((Number(score) * bps * Number(momentum)) / 1e8);
  // kind: 1 = evidence (full), 2 = discussion (softened), else cow boost (full).
  const kindBps = kind === 2 ? Number(dBps) : kind === 1 ? Number(eBps) : Number(cBps);
  const weight = Math.floor((raw * kindBps) / 10000);
  const totalN = Number(total);
  const award = totalN > 0 && weight > 0
    ? Math.floor((weight * 1000 * totalN) / (10000 * (totalN + weight)))
    : 0;
  return {
    weight,
    rawWeight: raw,
    authorAward: award,
    locked: Number(locked),
    budget: Number(budget),
    dilutes: Number(locked) + weight > Number(budget),
    overBudget: Number(locked) > Number(budget),
  };
}

export async function voiceLocks(contracts, account) {
  const [keys, amounts, locked, budget] = await contracts.cowRating.voterLocks(account);
  return {
    keys: [...keys],
    amounts: amounts.map(Number),
    locked: Number(locked),
    budget: Number(budget),
  };
}

// ---------------------------------------------------------------- actions ---

export async function mintCow(contracts, cid, account) {
  const tx = await contracts.cowNFT.mintCow(cid);
  const rc = await tx.wait();
  // Find the token id in the mint logs (CowMinted(tokenId, minter, cid)).
  const iface = contracts.cowNFT.interface;
  for (const log of rc.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "CowMinted") {
        return Number(parsed.args.tokenId);
      }
    } catch {
      /* not our event */
    }
  }
  throw new ChainError("Mint succeeded but the token id could not be read.");
}

export async function stake(contracts, tokenId, amount, tier = 0) {
  const tx = tier > 0
    ? await contracts.cowRating.stakeRatingTiered(tokenId, amount, tier)
    : await contracts.cowRating.stakeRating(tokenId, amount);
  await tx.wait();
}

export async function pokeStake(contracts, tokenId, account) {
  const tx = await contracts.cowRating.pokeStake(tokenId, account);
  await tx.wait();
}

export async function unstake(contracts, tokenId, amount) {
  const tx = await contracts.cowRating.unstakeRating(tokenId, amount);
  await tx.wait();
}

export async function boost(contracts, tokenId, bps) {
  const category = encodeBytes32String("general");
  const tx = await contracts.cowRating.boost(tokenId, category, bps);
  await tx.wait();
}

// Vote on an image (1) or post (2); cow votes go through boost().
// Attributed when the author is known (must match the on-chain registry).
export async function voteContent(contracts, tokenId, kind, cidHash, bps, author = null) {
  const c = contracts.cowRating;
  const tx = author
    ? await c.getFunction("vote(uint256,uint8,bytes32,uint256,address)")(tokenId, kind, cidHash, bps, author)
    : await c.getFunction("vote(uint256,uint8,bytes32,uint256)")(tokenId, kind, cidHash, bps);
  await tx.wait();
}

export async function registerContent(contracts, tokenId, kind, cidHash, protectionLinked) {
  const tx = await contracts.cowRating.registerContent(tokenId, kind, cidHash, protectionLinked);
  await tx.wait();
}

export async function unvote(contracts, key) {
  const tx = await contracts.cowRating.unvote(key);
  await tx.wait();
}

// ---------------------------------------------------------- moderation ---

// Propose hiding (0) or restoring (1) an anchored photo/post. The proposer
// counts as the first vote with their full reputation standing.
export async function proposeModeration(contracts, tokenId, itemKey, action) {
  if (!contracts.moderation) throw new ChainError("Moderation is not deployed on this chain.");
  const tx = await contracts.moderation.propose(tokenId, itemKey, action);
  const rc = await tx.wait();
  for (const log of rc.logs) {
    try {
      const parsed = contracts.moderation.interface.parseLog(log);
      if (parsed && parsed.name === "ModerationProposed") return Number(parsed.args.id);
    } catch {
      /* not our event */
    }
  }
  throw new ChainError("Proposal created but its id could not be read.");
}

export async function challengeModeration(contracts, id, support) {
  if (!contracts.moderation) throw new ChainError("Moderation is not deployed on this chain.");
  const tx = await contracts.moderation.challenge(id, support);
  await tx.wait();
}

export async function executeModeration(contracts, id) {
  if (!contracts.moderation) throw new ChainError("Moderation is not deployed on this chain.");
  const tx = await contracts.moderation.execute(id);
  await tx.wait();
}

export async function attestLabor(contracts, tokenId, hours, worker) {
  const tx = await contracts.attestation.attest(
    tokenId,
    6, // Kind.Labor — subject = worker, value = hours
    "ipfs://labor-evidence",
    hours,
    worker,
    100 // min bond
  );
  await tx.wait();
}

// Choose how much (0..10000 bps) of each future labor reward to commit back to
// the cow as a locked rating lien. 10000 = commit it all.
export async function setLaborCommitBps(contracts, bps) {
  const tx = await contracts.cowRating.setLaborCommitBps(bps);
  await tx.wait();
}

export async function laborCommitBps(contracts, account) {
  return Number(await contracts.cowRating.laborCommitBps(account).catch(() => 0n));
}

// Permissionless, batched burn of the liens on a hidden item. Anyone can call
// it; each voter loses at most the policy's capped share.
export async function slashContent(contracts, key, maxVoters = 50) {
  const tx = await contracts.cowRating.slashContent(key, maxVoters);
  await tx.wait();
}

// Burn Stasis to release real care money to the caller (the claim's worker or
// the cow's owner). One redemption per claim; burned Stasis is gone for good.
export async function redeemCare(contracts, tokenId, stasisAmount, claimRef) {
  const tx = await contracts.generalPool.redeemCare(tokenId, stasisAmount, claimRef);
  await tx.wait();
}

// One cow's care credit: live pool balance, the rate and the credit line.
export async function careStatus(contracts, tokenId) {
  const [poolWei, rateWei, rating, anchorLive] = await Promise.all([
    contracts.generalPool.carePoolOf(tokenId).catch(() => 0n),
    contracts.generalPool.careRateWei().catch(() => 10n ** 15n),
    contracts.cowRating.ratingOf(tokenId).catch(() => 0n),
    contracts.cowRating.protectionAnchorLive(tokenId).catch(() => false),
  ]);
  return {
    poolWei,
    rateWei,
    creditLine: Number(rating),
    anchorLive: !!anchorLive,
  };
}



export async function claimGasRebate(contracts) {
  const tx = await contracts.generalPool.claimGasRebate();
  await tx.wait();
}

// --------------------------------------------------------------- academy ---

// Submit a grader-signed quiz completion on-chain. The signature comes from
// the server (POST /api/academy/submit) — it only ever signs a *pass*.
export async function completeLesson(contracts, lessonId, signature) {
  if (!contracts.academy) throw new ChainError("Academy is not deployed on this chain.");
  const tx = await contracts.academy.complete(lessonId, signature);
  await tx.wait();
}

// On-chain completion state for one account: which lessons are done and
// whether the certified badge has been earned.
export async function academyProgress(contracts, account) {
  if (!contracts.academy) return null;
  const count = Number(await contracts.academy.lessonCount());
  const rows = [];
  for (let id = 1; id <= count; id++) {
    const [contentHash, reward, exists, cert] = await contracts.academy.lessonInfo(id);
    if (!exists) continue;
    rows.push({
      id,
      contentHash,
      reward: Number(reward),
      cert,
      done: await contracts.academy.completed(account, id),
    });
  }
  return { lessons: rows, certified: await contracts.academy.isCertified(account) };
}

// ---------------------------------------------------------- fund events / cycles ---

export async function createFundEvent(contracts, cid, goalWei, linkedTokenId = 0) {
  const tx = linkedTokenId > 0
    ? await contracts.generalPool.createEventForCow(cid, goalWei, linkedTokenId)
    : await contracts.generalPool.createEvent(cid, goalWei);
  const rc = await tx.wait();
  const iface = contracts.generalPool.interface;
  for (const log of rc.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "FundEventCreated") return Number(parsed.args.id);
    } catch {
      /* not our event */
    }
  }
  throw new ChainError("Event created but its id could not be read.");
}

export async function contributeEvent(contracts, eventId, valueWei) {
  const tx = await contracts.generalPool.contribute(eventId, { value: valueWei });
  await tx.wait();
  return valueWei;
}

export async function approveSpend(contracts, eventId, amountWei, to, claimRef) {
  const tx = await contracts.generalPool.approveSpend(eventId, amountWei, to, claimRef);
  await tx.wait();
}

// Releases cite an executed protection claim id as proof. Amounts above the
// large-spend threshold need a prior approveSpend in an earlier block.
export async function spendEvent(contracts, eventId, amountWei, to, claimRef) {
  const tx = await contracts.generalPool.spend(eventId, amountWei, to, claimRef);
  await tx.wait();
}

export async function closeEventAction(contracts, eventId) {
  const tx = await contracts.generalPool.closeEvent(eventId);
  await tx.wait();
}

export async function settleCycle(contracts) {
  const tx = await contracts.generalPool.settleCycle();
  await tx.wait();
}

export async function listFundEvents(contracts) {
  const count = Number(await contracts.generalPool.eventCount());
  const rows = [];
  for (let id = 1; id <= count; id++) {
    const e = await contracts.generalPool.events(id);
    rows.push({
      id: Number(e.id),
      creator: e.creator,
      metadataCid: e.metadataCid,
      goal: e.goal.toString(),
      raised: e.raised.toString(),
      spent: e.spent.toString(),
      closed: e.closed,
      linkedTokenId: Number(e.linkedTokenId ?? 0),
    });
  }
  return rows;
}

export async function cycleState(contracts) {
  const g = contracts.generalPool;
  const [
    period,
    share,
    ratio,
    cap,
    lastAt,
    movement,
    credit,
    backerShare,
    raterShare,
    backers,
    raters,
    raised,
  ] = await Promise.all([
    g.cyclePeriod(),
    g.backerShareBps(),
    g.creditRatioBps(),
    g.maxCycleCredit(),
    g.lastCycleAt(),
    g.lastCycleMovement(),
    g.lastCycleCredit(),
    g.lastCycleBackerShare(),
    g.lastCycleRaterShare(),
    g.lastCycleBackers(),
    g.lastCycleRaters(),
    g.cycleRaised(),
  ]);
  return {
    period: Number(period),
    share: Number(share),
    ratio: Number(ratio),
    cap: Number(cap),
    lastAt: Number(lastAt),
    movement: Number(movement),
    credit: Number(credit),
    backerShare: Number(backerShare),
    raterShare: Number(raterShare),
    backers: Number(backers),
    raters: Number(raters),
    raised: raised.toString(),
  };
}

// ------------------------------------------------------------------ council ---

// A hash of the proposal body (posted off-chain) serves as the on-chain id.
export function councilHash(text) {
  return keccak256(toUtf8Bytes(text));
}

// Content (a post or image) is identified the same way: hash of its id.
export function contentHash(text) {
  return keccak256(toUtf8Bytes(text));
}

// Wallet-sign a plain-text message (evidence files use `evidence:<sha256>`).
export async function signMessage(contracts, message) {
  const runner = contracts.stasis.runner;
  if (!runner || typeof runner.signMessage !== "function") {
    throw new ChainError("Connect your wallet to sign evidence.");
  }
  return runner.signMessage(message);
}

// Browser SHA-256 of an uploaded file, hex without `0x` prefix to match the
// server's verification (evidence:<sha256-hex>).
export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex;
}

export async function proposeCouncil(contracts, herdId, text, durationDays = 3) {
  const hash = councilHash(text);
  const tx = await contracts.herdCouncil.propose(herdId, hash, durationDays);
  await tx.wait();
  return hash;
}

export async function councilVote(contracts, proposalId, support) {
  const tx = await contracts.herdCouncil.vote(proposalId, support);
  await tx.wait();
}

export async function councilFinalize(contracts, proposalId) {
  const tx = await contracts.herdCouncil.finalize(proposalId);
  await tx.wait();
}

export async function transferCow(contracts, tokenId, to, from) {
  const { cowNFT } = contracts;
  const tx = await cowNFT.transferFrom(from, to, tokenId);
  await tx.wait();
}

export async function attestDeath(contracts, tokenId, bond = 100) {
  const tx = await contracts.attestation.attest(
    tokenId,
    3, // Kind.Death
    "ipfs://death-evidence",
    0,
    ZeroAddress,
    bond
  );
  await tx.wait();
}

export async function attestFundingNeed(contracts, tokenId, need, bond = 100) {
  const tx = await contracts.attestation.attest(
    tokenId,
    5, // Kind.FundingNeed
    "ipfs://funding-evidence",
    need,
    ZeroAddress,
    bond
  );
  await tx.wait();
}
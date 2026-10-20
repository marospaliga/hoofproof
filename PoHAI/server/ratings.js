// Rating indexer — the off-chain half of the protection-gated rating system.
//
// The chain enforces (budgets, dilution, anchors, proofs). This module *reads*:
// it replays contract events into per-cow breakdowns, author earnings, curator
// boards, trending order and the protection -> payout money trail.
//
// Trust model: every figure here is recomputed from public logs (see
// METHODOLOGY.md and scripts/recomputeRatings.js). If this server ever lies,
// the chain + its events overrule it.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const DEPLOYED = path.join(ROOT, "deployed.json");
const RPC = process.env.CHAIN_RPC || "http://127.0.0.1:8545";

const NAMES = ["Stasis", "CowNFT", "CowRating", "Attestation", "GeneralPool", "Moderation"];

function loadAddrs() {
  try {
    return JSON.parse(fs.readFileSync(DEPLOYED, "utf8"));
  } catch {
    return {};
  }
}

function loadAbi(name) {
  const file = path.join(ROOT, "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8")).abi;
}

let provider = null;
let ifaces = null;
let addrs = null;

function chain() {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(RPC);
    ifaces = Object.fromEntries(NAMES.map((n) => [n, new ethers.Interface(loadAbi(n))]));
    addrs = loadAddrs();
  }
  return { provider, ifaces, addrs };
}

function addrOf(key) {
  const { addrs } = chain();
  return { stasis: addrs.stasis, cowNFT: addrs.cowNFT, cowRating: addrs.cowRating, attestation: addrs.attestation, generalPool: addrs.generalPool, moderation: addrs.moderation }[key];
}

// ------------------------------------------------------------------ log cache

let cache = { block: -1, events: [] };

async function syncLogs() {
  const { provider, ifaces, addrs } = chain();
  const head = await provider.getBlockNumber().catch(() => -1);
  if (head < 0) return cache; // chain down: serve stale
  if (head === cache.block) return cache;
  const byAddr = {};
  for (const name of NAMES) {
    const key = name[0].toLowerCase() + name.slice(1);
    if (addrs[key]) byAddr[addrs[key].toLowerCase()] = name;
  }
  const logs = await provider.getLogs({ fromBlock: 0, toBlock: head }).catch(() => []);
  const events = [];
  for (const log of logs) {
    const name = byAddr[(log.address || "").toLowerCase()];
    if (!name) continue;
    try {
      const parsed = ifaces[name].parseLog(log);
      // ethers v6 Result arrays don't enumerate named keys reliably —
      // decode positionally from the fragment instead.
      const frag = ifaces[name].getEvent(parsed.name);
      const args = {};
      frag.inputs.forEach((inp, i) => {
        args[inp.name] = parsed.args[i];
      });
      events.push({
        contract: name,
        name: parsed.name,
        args,
        block: log.blockNumber,
        tx: log.transactionHash,
      });
    } catch {
      /* unknown topic */
    }
  }
  cache = { block: head, events };
  return cache;
}

const num = (v) => {
  try {
    return Number(v);
  } catch {
    return 0;
  }
};

// ----------------------------------------------------------------- breakdown

async function cowBreakdown(tokenId) {
  const { events } = await syncLogs();
  const tid = Number(tokenId);
  const out = {
    tokenId: tid,
    stakes: { total: 0, events: 0 },
    cowVotes: { weight: 0, votes: 0 },
    content: {},
    labor: { hours: 0, rewards: 0 },
    funding: [],
    authors: {},
    curators: {},
  };
  for (const e of events) {
    const a = e.args;
    if (e.contract === "CowRating") {
      if (e.name === "Staked" && num(a.tokenId) === tid) {
        out.stakes.total += num(a.amount);
        out.stakes.events += 1;
      }
      if ((e.name === "Voted" || e.name === "Boosted") && num(a.tokenId) === tid) {
        out.cowVotes.weight += num(a.weight);
        out.cowVotes.votes += 1;
        const who = String(a.account || "").toLowerCase();
        out.curators[who] = (out.curators[who] || 0) + num(a.weight);
      }
      if (e.name === "Voted" && num(a.tokenId) === tid && num(a.kind) !== 0) {
        const k = `${a.kind}:${a.cidHash}`;
        out.content[k] = out.content[k] || { kind: num(a.kind), cidHash: String(a.cidHash), weight: 0, votes: 0 };
        out.content[k].weight += num(a.weight);
        out.content[k].votes += 1;
      }
      if (e.name === "LaborRewarded" && num(a.tokenId) === tid) {
        out.labor.hours += num(a.attestedHours);
        out.labor.rewards += num(a.reward);
      }
      if (e.name === "FundingNeedRecorded" && num(a.tokenId) === tid) {
        out.funding.push({ previous: num(a.previous), current: num(a.current), solver: a.solver, block: e.block });
      }
      if (e.name === "ContentRewarded" && num(a.tokenId) === tid) {
        const au = String(a.author || "").toLowerCase();
        out.authors[au] = out.authors[au] || { earned: 0, pieces: 0, selfVotes: 0 };
        out.authors[au].earned += num(a.award);
        out.authors[au].pieces += 1;
        if (a.isSelf) out.authors[au].selfVotes += 1;
      }
    }
  }
  // Live on-chain anchor + totals (thin reads, no log dependency).
  try {
    const { provider } = chain();
    const rating = new ethers.Contract(addrOf("cowRating"), loadAbi("CowRating"), provider);
    const [anchor, cowR, backing] = await Promise.all([
      rating.protectionAnchorLive(tid).catch(() => false),
      rating.cowRating(tid).catch(() => 0n),
      rating.totalStaked(tid).catch(() => 0n),
    ]);
    out.anchorLive = anchor;
    out.onChainRating = num(cowR);
    out.onChainBacking = num(backing);
  } catch {
    out.anchorLive = false;
  }
  return out;
}

async function contentInfo(key) {
  const { provider } = chain();
  const rating = new ethers.Contract(addrOf("cowRating"), loadAbi("CowRating"), provider);
  const t = await rating.lockTarget(key).catch(() => null);
  const info = { key, registered: false };
  if (!t || !t.set) return info;
  const [author, linked, lastActive, active, provisional] = await Promise.all([
    rating.contentAuthor(key).catch(() => ethers.ZeroAddress),
    rating.contentProtectionLinked(key).catch(() => false),
    rating.contentLastActive(key).catch(() => 0n),
    rating.contentIsActive(key).catch(() => false),
    rating.contentProvisional(key).catch(() => 0n),
  ]);
  const cred = await rating.oracleCred(author).catch(() => 0n);
  const { events } = await syncLogs();
  let weight = 0;
  let votes = 0;
  let authorEarned = 0;
  for (const e of events) {
    if (e.contract === "CowRating" && e.name === "Voted" && String(e.args.cidHash) === String(t.cidHash)) {
      weight += num(e.args.weight);
      votes += 1;
    }
    if (e.contract === "CowRating" && e.name === "ContentRewarded" && String(e.args.author || "").toLowerCase() === String(author).toLowerCase()) {
      authorEarned += num(e.args.award);
    }
  }
  return {
    key,
    registered: true,
    tokenId: num(t.tokenId),
    kind: num(t.kind),
    cidHash: String(t.cidHash),
    author,
    protectionLinked: linked,
    lastActive: num(lastActive),
    active,
    provisional: num(provisional),
    authorCred: num(cred),
    authorEarned,
    loggedWeight: weight,
    loggedVotes: votes,
  };
}

async function trending() {
  const { events } = await syncLogs();
  const { provider } = chain();
  const rating = new ethers.Contract(addrOf("cowRating"), loadAbi("CowRating"), provider);
  const head = cache.block;
  const WINDOW = 2500; // recent-blocks window (~local demo activity)
  const recent = {};
  const seen = new Set();
  for (const e of events) {
    if (e.contract !== "CowRating") continue;
    if (!["Voted", "Boosted", "Staked"].includes(e.name)) continue;
    const tid = num(e.args.tokenId);
    seen.add(tid);
    if (head - e.block > WINDOW) continue;
    recent[tid] = (recent[tid] || 0) + (e.name === "Staked" ? num(e.args.amount) : num(e.args.weight));
  }
  const rows = [];
  for (const tid of seen) {
    const [cowR, backing] = await Promise.all([
      rating.cowRating(tid).catch(() => 0n),
      rating.totalStaked(tid).catch(() => 0n),
    ]);
    rows.push({ tokenId: tid, rating: num(cowR), backing: num(backing), recent: recent[tid] || 0 });
  }
  rows.sort((a, b) => b.recent - a.recent || b.rating - a.rating);
  return { block: head, window: WINDOW, rows };
}

async function ledger(tokenId) {
  const { events } = await syncLogs();
  const tid = Number(tokenId);
  const rows = [];
  for (const e of events) {
    const a = e.args;
    if (e.contract === "CowRating") {
      if (e.name === "LaborRewarded" && num(a.tokenId) === tid) {
        rows.push({ kind: "labor", worker: a.worker, hours: num(a.attestedHours), reward: num(a.reward), block: e.block, tx: e.tx });
      }
      if (e.name === "FundingNeedRecorded" && num(a.tokenId) === tid) {
        rows.push({ kind: "funding", previous: num(a.previous), current: num(a.current), solver: a.solver, block: e.block, tx: e.tx });
      }
      if (e.name === "ContentRewarded" && num(a.tokenId) === tid) {
        rows.push({ kind: "author", author: a.author, curator: a.curator, award: num(a.award), self: !!a.isSelf, block: e.block, tx: e.tx });
      }
    }
    if (e.contract === "GeneralPool") {
      if (e.name === "CareAllocatedWithProof" && num(a.tokenId) === tid) {
        rows.push({ kind: "care", amount: num(a.amount), claimRef: num(a.claimRef), block: e.block, tx: e.tx });
      }
      if (e.name === "CareRedeemed" && num(a.tokenId) === tid) {
        rows.push({
          kind: "careRedeem",
          account: a.account,
          stasisBurned: num(a.stasisBurned),
          ethReleased: num(a.ethReleased),
          claimRef: num(a.claimRef),
          block: e.block,
          tx: e.tx,
        });
      }
      if (e.name === "FundsReleasedWithProof") {
        rows.push({ kind: "release", eventId: num(a.id), to: a.to_, amount: num(a.amount), claimRef: num(a.claimRef), block: e.block, tx: e.tx });
      }
    }
    if (e.contract === "Attestation" && e.name === "ClaimExecuted") {
      rows.push({ kind: "claim", claimId: num(a.claimId), claimKind: num(a.kind), tokenId: num(a.tokenId), block: e.block, tx: e.tx });
    }
    if (e.contract === "Moderation" && e.name === "ModerationExecuted") {
      rows.push({ kind: "moderation", proposal: num(a.id), action: num(a.action), forWeight: num(a.forWeight), againstWeight: num(a.againstWeight), block: e.block, tx: e.tx });
    }
  }
  const mine = rows.filter((r) => r.tokenId === tid || r.kind !== "claim");
  mine.sort((a, b) => a.block - b.block);
  return { tokenId: tid, rows: mine };
}

async function curators(tokenId) {
  const bd = await cowBreakdown(tokenId);
  return {
    tokenId: bd.tokenId,
    curators: Object.entries(bd.curators)
      .map(([address, weight]) => ({ address, weight }))
      .sort((a, b) => b.weight - a.weight),
  };
}

async function authorInfo(address) {
  const { events } = await syncLogs();
  const who = String(address || "").toLowerCase();
  const out = { address: who, earned: 0, pieces: [], curated: 0 };
  for (const e of events) {
    if (e.contract !== "CowRating") continue;
    if (e.name === "ContentRewarded" && String(e.args.author || "").toLowerCase() === who) {
      out.earned += num(e.args.award);
      out.pieces.push({ tokenId: num(e.args.tokenId), kind: num(e.args.kind), award: num(e.args.award), self: !!e.args.isSelf, block: e.block });
    }
    if (e.name === "ContentRegistered" && String(e.args.author || "").toLowerCase() === who) {
      out.registered = (out.registered || 0) + 1;
    }
  }
  // Live reputation (score x momentum) for badges.
  try {
    const { provider } = chain();
    const stasis = new ethers.Contract(addrOf("stasis"), loadAbi("Stasis"), provider);
    const rating = new ethers.Contract(addrOf("cowRating"), loadAbi("CowRating"), provider);
    const [score, momentum, pActivity] = await Promise.all([
      stasis.effectiveScore(address).catch(() => 0n),
      rating.momentumBps(address).catch(() => 10000n),
      rating.protectionActivity(address).catch(() => 0n),
    ]);
    out.score = num(score);
    out.momentum = num(momentum);
    out.protection = num(pActivity);
  } catch {
    out.score = 0;
    out.momentum = 10000;
    out.protection = 0;
  }
  return out;
}

// ------------------------------------------------------------ moderation

async function moderationInfo(id) {
  const { provider } = chain();
  const mod = new ethers.Contract(addrOf("moderation"), loadAbi("Moderation"), provider);
  const [p, dominance, fastDelay, window, minVoters] = await Promise.all([
    mod.proposals(id),
    mod.dominanceBps().catch(() => 6600n),
    mod.fastPathDelay().catch(() => 172800n),
    mod.challengeWindow().catch(() => 259200n),
    mod.minDistinctVoters().catch(() => 2n),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const created = num(p.createdAt);
  const total = num(p.forWeight) + num(p.againstWeight);
  const domPct = total > 0 ? (num(p.forWeight) * 100) / total : 100;
  const dominant = total > 0 && num(p.forWeight) * 10000 >= total * num(dominance);
  return {
    id: Number(id),
    tokenId: num(p.tokenId),
    itemKey: String(p.itemKey),
    action: num(p.action), // 0 Hide, 1 Restore
    state: num(p.state), // 0 Open, 1 Executed, 2 Rejected
    proposer: String(p.proposer),
    forWeight: num(p.forWeight),
    againstWeight: num(p.againstWeight),
    votersFor: num(p.votersFor),
    votersAgainst: num(p.votersAgainst),
    createdAt: created,
    dominancePct: Math.round(domPct),
    dominant,
    executableAfter: dominant ? created + num(fastDelay) : created + num(window),
    executableNow: num(p.state) === 0 && (dominant ? now >= created + num(fastDelay) : now >= created + num(window)),
    policy: { dominance: num(dominance), fastDelay: num(fastDelay), window: num(window), minVoters: num(minVoters) },
  };
}

// Verify an executed proposal on-chain, then flip the visibility flag.
// Files stay on disk; the herd stops seeing them. Fully reversible.
async function applyModeration({ proposalId }) {
  const id = Number(proposalId);
  if (!id) return { ok: false, error: "proposalId is required" };
  const info = await moderationInfo(id);
  if (info.state !== 1) return { ok: false, error: "proposal is not executed on-chain" };

  const { ethers: eth } = require("ethers");
  const store = require("./store");
  const db = store.load();
  const normKey = info.itemKey.toLowerCase();
  // Registry keys are contentKeyOf(tokenId, kind, cidHash) = keccak(abi.encode(...))
  // where the cidHash itself is keccak("evidence:<sha256>") or keccak("post:<id>").
  const coder = eth.AbiCoder.defaultAbiCoder();
  const keyOf = (tokenId, kind, cidHash) =>
    eth.keccak256(coder.encode(["uint256", "uint8", "bytes32"], [tokenId, kind, cidHash])).toLowerCase();
  for (const record of Object.values(db.records)) {
    if (!record.tokenId) continue;
    for (const ev of record.evidence || []) {
      const cidHash = eth.keccak256(eth.toUtf8Bytes(`evidence:${ev.hash}`));
      if (keyOf(record.tokenId, 1, cidHash) === normKey) {
        ev.hidden = info.action === 0;
        ev.moderationId = id;
        store.put(record.cid, record);
        return { ok: true, kind: "evidence", cid: record.cid, hidden: ev.hidden };
      }
    }
    for (const t of record.threads || []) {
      for (const post of t.posts || []) {
        const cidHash = eth.keccak256(eth.toUtf8Bytes(`post:${post.id}`));
        if (keyOf(record.tokenId, 2, cidHash) === normKey) {
          post.hidden = info.action === 0;
          post.moderationId = id;
          store.put(record.cid, record);
          return { ok: true, kind: "post", cid: record.cid, hidden: post.hidden };
        }
      }
    }
  }
  return { ok: false, error: "no server item matches that proposal" };
}

// Care credit for one cow: the live pool balance plus every one-way burn that
// converted Stasis into real money. The chain is the ledger; this just reads it.
async function careInfo(tokenId) {
  const { provider, events: _ } = chain();
  const { events } = await syncLogs();
  const tid = Number(tokenId);
  const pool = new ethers.Contract(addrOf("generalPool"), loadAbi("GeneralPool"), provider);
  const rating = new ethers.Contract(addrOf("cowRating"), loadAbi("CowRating"), provider);
  const [poolWei, rateWei, ratingPoints, anchor] = await Promise.all([
    pool.carePoolOf(tid).catch(() => 0n),
    pool.careRateWei().catch(() => 10n ** 15n),
    rating.ratingOf(tid).catch(() => 0n),
    rating.protectionAnchorLive(tid).catch(() => false),
  ]);
  const redemptions = [];
  for (const e of events) {
    if (e.contract !== "GeneralPool" || e.name !== "CareRedeemed") continue;
    if (num(e.args.tokenId) !== tid) continue;
    redemptions.push({
      account: e.args.account,
      stasisBurned: num(e.args.stasisBurned),
      ethReleased: num(e.args.ethReleased),
      claimRef: num(e.args.claimRef),
      block: e.block,
      tx: e.tx,
    });
  }
  return {
    tokenId: tid,
    carePoolWei: poolWei.toString(),
    careRateWei: rateWei.toString(),
    // The cow's rating is its credit line: you can burn at most this much.
    creditLine: num(ratingPoints),
    anchorLive: !!anchor,
    redeemableStasis: num(ratingPoints),
    redemptions,
  };
}

// Whole-field health figures for the pool indicator, read live from the
// pool contract's metrics views (no log replay needed).
async function poolStats() {
  const { provider } = chain();
  const pool = new ethers.Contract(addrOf("generalPool"), loadAbi("GeneralPool"), provider);
  const [pm, prot] = await Promise.all([
    pool.platformMetrics(),
    pool.protectionMetrics(),
  ]);
  const stasis = new ethers.Contract(addrOf("stasis"), loadAbi("Stasis"), provider);
  const totalScore = num(await stasis.totalScore());
  const totalVoiced = num(await stasis.totalVoiced().catch(() => 0n));
  return {
    block: await provider.getBlockNumber(),
    backing: num(pm.backing),
    rating: num(pm.rating),
    stasisTotal: num(pm.stasisTotal),
    activeCows: num(pm.activeCows),
    laborHours: num(prot.laborHours),
    careQuorums: num(prot.careQuorums),
    solved: num(prot.solved),
    totalScore,
    totalVoiced,
    voicedSharePct: totalScore > 0 ? Math.round((totalVoiced * 100) / totalScore) : 0,
  };
}

module.exports = { cowBreakdown, contentInfo, trending, ledger, curators, authorInfo, moderationInfo, applyModeration, poolStats, careInfo };

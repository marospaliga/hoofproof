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
    InsufficientRajas: "You don't have that many Rajas action-credits.",
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
  const { stasis, cowRating, generalPool } = contracts;
  const [score, bonded, votingPower, momentum, rajas] = await Promise.all([
    stasis.effectiveScore(account),
    stasis.bonded(account),
    cowRating.votingPowerOf(account),
    cowRating.momentumBps(account),
    generalPool.rajas(account),
  ]);
  return {
    score: Number(score),
    bonded: Number(bonded),
    votingPower: Number(votingPower),
    momentum: Number(momentum),
    rajas: Number(rajas),
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

export async function stake(contracts, tokenId, amount) {
  const tx = await contracts.cowRating.stakeRating(tokenId, amount);
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
export async function voteContent(contracts, tokenId, kind, cidHash, bps) {
  const tx = await contracts.cowRating.vote(tokenId, kind, cidHash, bps);
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

export async function convertSattvaToRajas(contracts, amount) {
  const tx = await contracts.generalPool.convertSattvaToRajas(amount);
  await tx.wait();
}

export async function convertRajasToSattva(contracts, amount) {
  const tx = await contracts.generalPool.convertRajasToSattva(amount);
  await tx.wait();
}

export async function claimGasRebate(contracts) {
  const tx = await contracts.generalPool.claimGasRebate();
  await tx.wait();
}

// ---------------------------------------------------------- fund events / cycles ---

export async function createFundEvent(contracts, cid, goalWei) {
  const tx = await contracts.generalPool.createEvent(cid, goalWei);
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

export async function spendEvent(contracts, eventId, amountWei, to) {
  const tx = await contracts.generalPool.spend(eventId, amountWei, to);
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

// Browser SHA-256 of an uploaded file, hex with a `0x` prefix to match the
// convention used elsewhere in the app.
export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hex}`;
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
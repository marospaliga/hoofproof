import { BrowserProvider, Contract, encodeBytes32String, ZeroAddress } from "ethers";
import abis from "../abis.js";
import { DEFAULT_CONTRACTS, STATUS_NAMES } from "../config.js";

export class ChainError extends Error {}

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
    CooldownActive: "You can only boost this cow once per day.",
    InvalidBoost: "A boost must be between 0% and 10% of your score.",
    WeightTooLow: "Your score is too low to boost meaningfully.",
    PeriodNotElapsed: "The funding need can only be re-recorded once per 30-day period.",
    IsMemorial: "Memorial cows are frozen — no actions can be taken on them.",
    ZeroAmount: "The amount must be greater than zero.",
    InsufficientStake: "You have not staked that much on this cow.",
    NotTokenOwner: "This action requires the cow's owner.",
    AlreadySupported: "You already supported this claim.",
  };

  if (name && known[name]) return known[name];
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
  };
}

export async function enrichCow(record, contracts) {
  const { cowNFT, cowRating } = contracts;
  const tokenId = record.tokenId;
  const [status, rating, backing, funding, owner] = await Promise.all([
    cowNFT.statusOf(tokenId),
    cowRating.ratingOf(tokenId),
    cowRating.totalStaked(tokenId),
    cowRating.funding(tokenId),
    cowNFT.ownerOf(tokenId),
  ]);
  return {
    ...record,
    status: Number(status),
    statusName: STATUS_NAMES[Number(status)],
    rating: Number(rating),
    backing: Number(backing),
    fundingNeed: Number(funding.need),
    onChainOwner: owner,
  };
}

export async function myReputation(contracts, account) {
  const { stasis } = contracts;
  const [score, bonded] = await Promise.all([
    stasis.effectiveScore(account),
    stasis.bonded(account),
  ]);
  return { score: Number(score), bonded: Number(bonded) };
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
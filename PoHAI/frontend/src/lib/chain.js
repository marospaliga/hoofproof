import { BrowserProvider, Contract, encodeBytes32String, ZeroAddress } from "ethers";
import abis from "../abis.js";
import { DEFAULT_CONTRACTS, STATUS_NAMES } from "../config.js";

export class ChainError extends Error {}

export function applyDeployed(config) {
  // The server knows the freshly deployed addresses; fall back to local defaults.
  return {
    ...DEFAULT_CONTRACTS,
    ...(config || {}),
  };
}

export async function connectWallet() {
  if (!window.ethereum) {
    throw new ChainError("No wallet found. Install MetaMask (or another injected wallet).");
  }
  const provider = new BrowserProvider(window.ethereum);
  const [account] = await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const network = await provider.getNetwork();
  return { provider, signer, account, chainId: Number(network.chainId) };
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
// Seeds the demo: ~10 synthetic cows with varied life states so the frontend
// is worth looking at right away.
//
//   terminal 1: npm run node
//   terminal 2: npm run server
//   once:       npm run deploy:local        (writes deployed.json)
//   then:       npm install --prefix frontend
//               npm run seed
//
// Idempotent: aborts if cows already exist on the chain.
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const API = process.env.SEED_API || "http://localhost:3001";
const ZERO = ethers.ZeroAddress;
const GENERAL = ethers.encodeBytes32String("general");

const COWS = [
  { name: "Blossom", breed: "Jersey", age: 4, image: "🐄", plan: "active",
    story: "The herd's milk queen — calm, curious, and absurdly good at opening gates." },
  { name: "Daisy", breed: "Holstein", age: 6, image: "🐄", plan: "active",
    story: "Classic black-and-white. Sired the last two calves everyone talks about." },
  { name: "Buttercup", breed: "Guernsey", age: 3, image: "🐂", plan: "half",
    story: "Golden butterfat. Still waiting for enough raters to call her home." },
  { name: "Hans", breed: "Brown Swiss", age: 7, image: "🐂", plan: "herd", need: 500,
    story: "Old, soft-spoken, and the herd's literal anchor. Currently needs 500/mo for hillside grazing lease." },
  { name: "Klara", breed: "Simmental", age: 5, image: "🐄", plan: "herd",
    story: "Moves like a draft horse, eats like a teenager." },
  { name: "Greta", breed: "Angus", age: 2, image: "🐂", plan: "plain",
    story: "Fresh arrival. No rating, no noise — a blank ledger." },
  { name: "Nils", breed: "Dexter", age: 8, image: "🐂", plan: "plain",
    story: "A pocket-sized bull with an oversized opinion of himself." },
  { name: "Rosa", breed: "Red Poll", age: 5, image: "🐄", plan: "plain",
    story: "Endangered breed, gentle temperament. A candidate for the conservation pool." },
  { name: "Pavla", breed: "Highland", age: 4, image: "🐃", plan: "plain",
    story: "Shaggy, stoic, and currently gazing at the fence like it owes her money." },
  { name: "Old Man Winter", breed: "Longhorn", age: 12, image: "🐃", plan: "memorial",
    story: "Founder stock. Passed peacefully in his paddock; this record stays as a memorial." },
];

async function main() {
  const deployFile = path.join(__dirname, "..", "deployed.json");
  const deploy = JSON.parse(fs.readFileSync(deployFile, "utf8"));

  const signers = await ethers.getSigners();
  const [deployer, r1, r2, r3, r4, r5, r6] = signers;
  const raters = [r1, r2, r3, r4, r5, r6];

  const stasis = await ethers.getContractAt("Stasis", deploy.stasis);
  const cowNFT = await ethers.getContractAt("CowNFT", deploy.cowNFT);
  const cowRating = await ethers.getContractAt("CowRating", deploy.cowRating);
  const attestation = await ethers.getContractAt("Attestation", deploy.attestation);
  const generalPool = await ethers.getContractAt("GeneralPool", deploy.generalPool);

  const existing = Number(await cowNFT.nextTokenId());
  if (existing > 1) {
    console.log(`Chain already has cows (nextTokenId=${existing}); seeding aborted.`);
    console.log("To reseed, reset the chain (restart the hardhat node) and redeploy.");
    return;
  }

  console.log("Granting genesis score to six demo raters…");
  for (const r of raters) {
    await stasis.grantGenesis(r.address, 20_000);
  }

  console.log("Minting cows + registering metadata…");
  for (const [i, cow] of COWS.entries()) {
    const cid = `ipfs://demo-cow-${i + 1}`;
    const tx = await cowNFT.mintCow(cid);
    const rc = await tx.wait();
    const tokenId = Number(
      rc.logs.map((l) => cowNFT.interface.parseLog(l)).find((p) => p?.name === "CowMinted").args.tokenId
    );

    const res = await fetch(`${API}/api/cows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: cow.name, breed: cow.breed, age: cow.age, story: cow.story, image: cow.image }),
    });
    const record = await res.json();

    await fetch(`${API}/api/cows/${encodeURIComponent(record.cid)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenId, owner: deployer.address }),
    });

    await applyPlan(cow.plan, tokenId, { cowNFT, cowRating, attestation, raters, r1, deployer });

    if (cow.need !== undefined) {
      // Hans carries a real, attested funding need so the lifecycle can be demoed:
      // "Report need 0" on the frontend reduces it and credits the solver.
      await attestation.connect(r1).attest(tokenId, 5, "ipfs://funding-hans", cow.need, ZERO, 100);
    }

    console.log(`  #${tokenId} ${cow.name} · ${cow.plan}`);
  }

  // The funding lifecycle lets the owner record a *new* need once per period.
  // Fast-forward 31 days so the demo's first "Report need 0" is a valid action.
  await hre.network.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]);
  await hre.network.provider.send("evm_mine", []);

  // ---- Phase A+B demo layer ------------------------------------------------
  // Voting power, sweat equity, Rajas, the care pool and the platform index.
  // Wrapped loosely so a hiccup here warns instead of aborting the seed.
  try {
    console.log("Phase A+B demo layer…");

    // r2 + r3 attest 40h of real care work on Blossom (tokenId 1): sweat
    // equity scales with the cow's rating — Blossom is boosted, so it pays 1x.
    for (const r of [r2, r3]) {
      await attestation.connect(r).attest(1, 6, "ipfs://labor-blossom", 40, r3.address, 100);
    }

    // Seed the GeneralPool treasury and earmark care allowance for Hans.
    await deployer.sendTransaction({ to: generalPool.getAddress(), value: ethers.parseEther("0.5") });
    await generalPool.allocateCare(4, ethers.parseEther("0.25"));

    // r1 converts influence into spendable Rajas credits.
    await generalPool.connect(r1).convertSattvaToRajas(1000);

    // r1 has real momentum (boosts + stakes before the +31d jump, half
    // decayed): claim the "high rating gas you less" rebate from the pool.
    await generalPool.connect(r1).claimGasRebate();

    // Open the platform value index with two snapshots.
    await generalPool.snapshotIndex();
  } catch (e) {
    console.warn("Phase A+B demo layer skipped:", e.message);
  }

  // ---- Phase C demo layer -------------------------------------------------
  // Profiles, a charitable cause, and the movement cycle in action: the pool
  // settles once to prime its baseline, the field moves (two raters stay
  // active), and the next settle pays backers + raters from that movement.
  try {
    console.log("Phase C demo layer (profiles, causes, cycle credit)…");

    // Claim names for the demo raters so threads and evidence read naturally.
    const named = [
      [r1, "Maros the Keeper"],
      [r2, "Anna the Vet"],
      [r3, "Jonas the Feeder"],
    ];
    for (const [r, name] of named) {
      await fetch(`${API}/api/profiles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: r.address,
          name,
          bio: "A founding rater on the Proof of a Hoof demo.",
        }),
      });
    }

    // A charitable cause, backed by two raters (money sits in escrow — no
    // instant rating for it).
    await generalPool.createEvent("ipfs://event-bedding", ethers.parseEther("0.5"));
    const eventId = Number(await generalPool.eventCount());
    await fetch(`${API}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: String(eventId),
        title: "Winter bedding for the herd",
        description: "Straw, blankets and rubber mats so the calves stay warm through winter.",
        goal: ethers.parseEther("0.5").toString(),
      }),
    });
    await generalPool.connect(r2).contribute(eventId, { value: ethers.parseEther("0.2") });
    await generalPool.connect(r3).contribute(eventId, { value: ethers.parseEther("0.2") });

    // r2 uploads a wallet-signed evidence photo on Blossom (tokenId 1): the
    // agent hashes the file, r2 signs the content hash, and the server keeps
    // the file in its uploads dir + points the oracle record at it.
    const blossom = (await (await fetch(`${API}/api/cows`)).json()).find((c) => c.tokenId === 1);
    if (blossom) {
      const photo = Buffer.from(
        `demo photo: winter bedding straw bales outside the stable (seeded ${Date.now()})`
      );
      const hash = crypto.createHash("sha256").update(photo).digest("hex");
      const signature = await r2.signMessage(`evidence:${hash}`);
      const form = new FormData();
      form.append("file", new Blob([photo], { type: "image/png" }), "bedding.png");
      form.append("address", r2.address);
      form.append("signature", signature);
      form.append("note", "winter bedding straw bales");
      await fetch(`${API}/api/cows/${encodeURIComponent(blossom.cid)}/evidence`, {
        method: "POST",
        body: form,
      });
    }

    // Prime the cycle baseline, let the field move (active raters), then settle.
    await generalPool.settleCycle();
    await cowRating.connect(r1).boost(1, GENERAL, 1_000);
    await cowRating.connect(r2).boost(1, GENERAL, 1_000);
    await hre.network.provider.send("evm_increaseTime", [13 * 60 * 60]);
    await hre.network.provider.send("evm_mine", []);
    await generalPool.settleCycle();

    const [movement, credit, backers] = await Promise.all([
      generalPool.lastCycleMovement(),
      generalPool.lastCycleCredit(),
      generalPool.lastCycleBackers(),
    ]);
    console.log(
      `  cause #${eventId} backed by r2+r3 · cycle paid ${credit} pts for ${movement} of field movement` +
        ` (${backers} backers)`
    );
  } catch (e) {
    console.warn("Phase C demo layer skipped:", e.message);
  }

  console.log("\nDone. Run `npm run frontend` and open http://localhost:5173");
  console.log("(chain clock advanced +31 days + a cycle so the funding lifecycle and movement cycle are demoable)");
}

async function applyPlan(plan, tokenId, c) {
  const { cowNFT, cowRating, attestation, raters, r1, deployer } = c;

  if (plan === "active" || plan === "herd" || plan === "memorial") {
    // Five independent raters × 200 pushes the cow across the activation
    // threshold (1000) — the concentration cap makes a solo activation impossible.
    for (const r of raters.slice(0, 5)) {
      await cowRating.connect(r).stakeRating(tokenId, 200);
    }
    if (plan !== "memorial") {
      await cowRating.connect(r1).boost(tokenId, GENERAL, 1_000);
    }
  } else if (plan === "half") {
    await cowRating.connect(raters[0]).stakeRating(tokenId, 200);
    await cowRating.connect(raters[1]).stakeRating(tokenId, 200);
  }

  if (plan === "herd") {
    // The cow owner joins demo Herd 7 (two+ members give everyone a bonus).
    await cowNFT.connect(deployer).setHerd(tokenId, 7);
  }

  if (plan === "memorial") {
    // Three bonded raters confirm the death → the record freezes as Memorial.
    for (const r of raters.slice(0, 3)) {
      await attestation.connect(r).attest(tokenId, 3, "ipfs://death-evidence", 0, ZERO, 100);
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
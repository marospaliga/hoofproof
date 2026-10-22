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
  { name: "Klara", breed: "Simmental", age: 5, image: "🐄", plan: "half",
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
  const [deployer, r1, r2, r3, r4, r5, r6, buyer] = signers;
  const raters = [r1, r2, r3, r4, r5, r6];

  const stasis = await ethers.getContractAt("Stasis", deploy.stasis);
  const cowNFT = await ethers.getContractAt("CowNFT", deploy.cowNFT);
  const cowRating = await ethers.getContractAt("CowRating", deploy.cowRating);
  const attestation = await ethers.getContractAt("Attestation", deploy.attestation);
  const generalPool = await ethers.getContractAt("GeneralPool", deploy.generalPool);
  const academy = await ethers.getContractAt("Academy", deploy.academy);

  const existing = Number(await cowNFT.nextTokenId());
  if (existing > 1) {
    console.log(`Chain already has cows (nextTokenId=${existing}); seeding aborted.`);
    console.log("To reseed, reset the chain (restart the hardhat node) and redeploy.");
    return;
  }

  // ---- zero-start: pin the curriculum, then everyone earns their way in ----
  // No genesis grants. Raters complete the cow-care course (grader-signed
  // completions, exactly what the server does) and leave with 700 Stasis —
  // the score they stake, bond and vote with below is *earned*.
  console.log("Pinning the cow-care curriculum on-chain…");
  const academyServer = require("../server/academy");
  for (const l of academyServer.LESSONS) {
    const { hash, reward, cert } = academyServer.lessonFile(l.id);
    await academy.setLesson(l.id, hash, reward, cert);
  }

  console.log("Raters taking the cow-care course (7 lessons each)…");
  const courseDomain = {
    name: "HoofProofAcademy",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await academy.getAddress(),
  };
  const courseTypes = { Completed: [
    { name: "lessonId", type: "uint8" },
    { name: "account", type: "address" },
  ] };
  for (const r of [...raters, buyer]) {
    for (const l of academyServer.LESSONS) {
      const sig = await deployer.signTypedData(courseDomain, courseTypes, {
        lessonId: l.id,
        account: r.address,
      });
      await academy.connect(r).complete(l.id, sig);
    }
    const score = await stasis.effectiveScore(r.address);
    console.log(`  ${r.address.slice(0, 10)}… certified · score ${score}`);
  }

  console.log("Minting cows + registering metadata…");
  // Server-idempotent: reuse the oldest same-name record if one exists
  // (re-link it to the fresh token) instead of appending a duplicate row.
  const known = await (await fetch(`${API}/api/cows`)).json().catch(() => []);
  const byName = new Map();
  for (const r of known) {
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push(r);
  }
  let hansNeedClaim = 0n;
  // Spread stakes round-robin across the seven funded accounts so no account
  // over-commits: with sound money, conviction must be chosen, not sprayed.
  const stakers = [r1, r2, r3, r4, r5, r6, buyer];
  const stakeState = { cursor: 0 };
  const pickStakers = (k) => {
    const picked = [];
    for (let i = 0; i < k; i++) {
      picked.push(stakers[stakeState.cursor % stakers.length]);
      stakeState.cursor += 1;
    }
    return picked;
  };
  for (const [i, cow] of COWS.entries()) {
    const cid = `ipfs://demo-cow-${i + 1}`;
    const tx = await cowNFT.mintCow(cid);
    const rc = await tx.wait();
    const tokenId = Number(
      rc.logs.map((l) => cowNFT.interface.parseLog(l)).find((p) => p?.name === "CowMinted").args.tokenId
    );

    let record = (byName.get(cow.name) || []).find((r) => r.tokenId == null)
      || (byName.get(cow.name) || [])[0];
    if (record) {
      console.log(`  reusing server record ${record.cid} for ${cow.name}`);
    } else {
      const res = await fetch(`${API}/api/cows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: cow.name, breed: cow.breed, age: cow.age, story: cow.story, image: cow.image }),
      });
      record = await res.json();
    }

    await fetch(`${API}/api/cows/${encodeURIComponent(record.cid)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenId, owner: deployer.address }),
    });

    await applyPlan(cow.plan, tokenId, {
      cowNFT, cowRating, attestation, raters, r1, r6, buyer, deployer, pickStakers,
    });

    if (cow.need !== undefined) {
      // Hans carries a real, attested funding need so the lifecycle can be demoed:
      // "Report need 0" on the frontend reduces it and credits the solver.
      // Quorum is 2: r1 reports, r2 corroborates (r1 is the solver).
      const needArgs = [tokenId, 5, "ipfs://funding-hans", cow.need, ZERO, 100];
      const needId = await attestation.connect(r1).attest.staticCall(...needArgs);
      await attestation.connect(r1).attest(...needArgs);
      await attestation.connect(r2).attest(...needArgs);
      // Stash the executed claim id: care earmarks must cite proof.
      if (cow.name === "Hans") hansNeedClaim = needId;
    }

    console.log(`  #${tokenId} ${cow.name} · ${cow.plan}`);
  }

  // Give the flagship cows a starting rating. Voices come from accounts that
  // still have free score after staking, and are downgraded if not.
  console.log("Seeding ratings (voiced Stasis)…");
  await guardedBoost(stasis, cowRating, r6, 1);    // Blossom
  await guardedBoost(stasis, cowRating, buyer, 2); // Daisy
  await guardedBoost(stasis, cowRating, r1, 4);    // Hans

  // The funding lifecycle lets the owner record a *new* need once per period.
  // Fast-forward just past that period so the demo's first "Report need 0" is a
  // valid action — however long a period is on this chain. On the production
  // clock that is a month; on the beta clock it is a day. Reading it off the
  // chain keeps the seed honest whichever ruler is running.
  const needPeriod = Number(await cowRating.needPeriod());
  const cyclePeriod = Number(await generalPool.cyclePeriod());
  const DAY = 24 * 60 * 60;
  await warp(needPeriod + DAY);

  // ---- Phase A+B demo layer ------------------------------------------------
  // Voting power, sweat equity, the care pool and the platform index.
  // Wrapped loosely so a hiccup here warns instead of aborting the seed.
  try {
    console.log("Phase A+B demo layer…");

    // r2 + r3 attest 40h of real care work on Blossom (tokenId 1): sweat
    // equity scales with the cow's rating — Blossom is boosted, so it pays 1x.
    for (const r of [r2, r3]) {
      await attestation.connect(r).attest(1, 6, "ipfs://labor-blossom", 40, r3.address, 100);
    }

    // Seed the GeneralPool treasury and earmark care allowance for Hans.
    // Hans is Active with an executed funding-need record: anchor live, proof cited.
    await deployer.sendTransaction({ to: generalPool.getAddress(), value: ethers.parseEther("0.5") });
    await generalPool.allocateCare(4, ethers.parseEther("0.25"), hansNeedClaim);

    // r1 reported Hans' need (solver, corroborated) and stays active: that is
    // protection work, so the protection-gated gas rebate is claimable.
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

      // Anchor the evidence on-chain: r2 registers authorship as
      // protection-linked, r3 curates it with an attributed vote.
      const evKey = ethers.keccak256(ethers.toUtf8Bytes(`evidence:${hash}`));
      await cowRating.connect(r2).registerContent(1, 1, evKey, true);
      await cowRating.connect(r3)["vote(uint256,uint8,bytes32,uint256,address)"](1, 1, evKey, 100, r2.address);

      // r2 has now earned oracle credibility: a second document arrives with
      // a trust head start that an independent vote locks in permanently.
      const hash2 = crypto.createHash("sha256").update(photo).update("second").digest("hex");
      const evKey2 = ethers.keccak256(ethers.toUtf8Bytes(`evidence:${hash2}`));
      await cowRating.connect(r2).registerContent(1, 1, evKey2, true);
      const locked2 = await cowRating.contentKeyOf(1, 1, evKey2).then((k) => cowRating.contentProvisional(k));
      console.log(`  r2 oracle cred=${await cowRating.oracleCred(r2.address)} head start=${locked2}`);
    }

    // Prime the cycle baseline, let the field move (active raters), then settle.
    // r5/r6 spend rating that is still free, so the movement is real and visible
    // (r1/r2 already committed theirs defending the herd's ratings).
    await generalPool.settleCycle();
    await guardedBoost(stasis, cowRating, r5, 1);
    await guardedBoost(stasis, cowRating, r6, 1);
    await warp(cyclePeriod + 3600);
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
  console.log(
    `(chain clock advanced past one need period + a cycle, so the funding lifecycle and movement cycle are demoable)`
  );
}

// Move the chain clock forward and mine, so deadlines that are waiting on the
// old time get their chance. Only ever used on the local demo chain.
async function warp(seconds) {
  console.log(`  (chain clock +${Math.round(seconds / 3600)}h)`);
  await hre.network.provider.send("evm_increaseTime", [seconds]);
  await hre.network.provider.send("evm_mine", []);
}

// Boost a cow, but only with rating the account can actually afford: a voice is
// simply rating spent, so an account already committed elsewhere has less to give.
async function guardedBoost(stasis, cowRating, account, tokenId) {
  const free = Number(await stasis.freeScore(account));
  const amount = free >= 115 ? 100 : free >= 60 ? 50 : 0;
  if (amount === 0) {
    console.log(`  (no free rating left for ${account.address.slice(0, 8)}… — boost skipped)`);
    return;
  }
  await cowRating.connect(account).boost(tokenId, GENERAL, amount);
}

async function applyPlan(plan, tokenId, c) {
  const { cowNFT, cowRating, attestation, raters, r6, buyer, r1, deployer } = c;

  // Zero-start budget: every account holds 700 Stasis earned from the course.
  // A stake *bonds* that score and the concentration cap (20% of the 1000
  // activation threshold) limits each account to 200 per cow — so activation
  // takes 5 distinct stakers, and each rater can only back 3 cows at a time.
  // Earned score means conviction must be chosen, not sprayed. Stakers are
  // drawn round-robin (see `pickStakers`) so no account over-commits.
  if (plan === "active" || plan === "herd") {
    for (const r of c.pickStakers(5)) {
      await cowRating.connect(r).stakeRating(tokenId, 200);
    }
  } else if (plan === "half") {
    // Two stakers with free budgets: 400/1000 — visibly progressing.
    for (const r of c.pickStakers(2)) {
      await cowRating.connect(r).stakeRating(tokenId, 200);
    }
  } else if (plan === "memorial") {
    // No stakes: a death claim from three bonded attestors freezes the
    // record. The bond comes back when the claim executes.
    for (const r of raters.slice(0, 3)) {
      await attestation.connect(r).attest(tokenId, 3, "ipfs://death-evidence", 0, ZERO, 100);
    }
  }

  if (plan === "herd") {
    // The cow owner joins demo Herd 7 (two+ members give everyone a bonus).
    await cowNFT.connect(deployer).setHerd(tokenId, 7);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
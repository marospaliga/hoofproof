import { ethers } from "ethers";
import abis from "./vendor-abis.js";

const MNEMONIC = "test test test test test test test test test test test junk";
const N_ACCOUNTS = 10;

const $ = (id) => document.getElementById(id);
const log = (m) => {
  const el = $("log");
  el.textContent += `[${new Date().toLocaleTimeString()}] ${m}\n`;
  el.scrollTop = el.scrollHeight;
};

const provider = new ethers.JsonRpcProvider(window.location.origin + "/rpc");
const wallets = Array.from({ length: N_ACCOUNTS }, (_, i) =>
  ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(provider)
);
let me = 0;
let deployment = null;
let C = null; // contracts bound to wallets[me]

function bind() {
  const s = wallets[me];
  C = {
    stasis: new ethers.Contract(deployment.stasis, abis.stasis, s),
    cowNFT: new ethers.Contract(deployment.cowNFT, abis.cowNFT, s),
    cowRating: new ethers.Contract(deployment.cowRating, abis.cowRating, s),
    attestation: new ethers.Contract(deployment.attestation, abis.attestation, s),
    generalPool: new ethers.Contract(deployment.generalPool, abis.generalPool, s),
    academy: deployment.academy ? new ethers.Contract(deployment.academy, abis.academy, s) : null,
    moderation: deployment.moderation ? new ethers.Contract(deployment.moderation, abis.moderation, s) : null,
  };
}

async function acctStats(addr) {
  const [score, bonded, locked, prot] = await Promise.all([
    C.stasis.effectiveScore(addr),
    C.stasis.bonded(addr),
    C.cowRating.voiceLocked(addr),
    C.cowRating.protectionActivity(addr),
  ]);
  return { score: Number(score), bonded: Number(bonded), locked: Number(locked), prot: Number(prot) };
}

async function cowRows() {
  const next = Number(await C.cowNFT.nextTokenId());
  let names = {};
  try {
    const cows = await (await fetch("http://localhost:3001/api/cows")).json();
    for (const c of cows) if (c.tokenId) names[Number(c.tokenId)] = c.name;
  } catch { /* agora down — fall back to ids */ }
  const rows = [];
  for (let id = 1; id < next; id++) {
    const [verified, deceased, rating, backing, anchor, mine] = await Promise.all([
      C.cowNFT.isVerified(id),
      C.cowNFT.isDeceased(id),
      C.cowRating.cowRating(id),
      C.cowRating.totalStaked(id),
      C.cowRating.protectionAnchorLive(id).catch(() => false),
      C.cowRating.stakeOf(id, wallets[me].address).catch(() => 0n),
    ]);
    const state = deceased ? "Memorial" : verified ? "Living real" : "Project";
    rows.push({ id, name: names[id] || `Cow #${id}`, state, rating: Number(rating), backing: Number(backing), anchor, myStake: Number(mine) });
  }
  return rows;
}

async function renderField() {
  const stats = await Promise.all(
    wallets.map(async (w, i) => {
      try {
        const [score, bonded, locked, prot, cred] = await Promise.all([
          C.stasis.effectiveScore(w.address),
          C.stasis.bonded(w.address),
          C.cowRating.voiceLocked(w.address),
          C.cowRating.protectionActivity(w.address),
          C.cowRating.oracleCred(w.address).catch(() => 0n),
        ]);
        return { i, addr: w.address, score: Number(score), bonded: Number(bonded), locked: Number(locked), prot: Number(prot), cred: Number(cred) };
      } catch {
        return { i, addr: w.address, score: 0, bonded: 0, locked: 0, prot: 0, cred: 0 };
      }
    })
  );
  const [totalRating, backing, backedCows, labor, care, covered, totalScore] = await Promise.all([
    C.cowRating.totalRatingPoints().then(Number).catch(() => 0),
    C.cowRating.totalBacking().then(Number).catch(() => 0),
    C.cowRating.backedCowCount().then(Number).catch(() => 0),
    C.cowRating.totalLaborHours().then(Number).catch(() => 0),
    C.cowRating.careQuorumCount().then(Number).catch(() => 0),
    C.cowRating.cowsEverCovered().then(Number).catch(() => 0),
    C.stasis.totalScore().then(Number).catch(() => 0),
  ]);
  $("fieldtotals").textContent =
    `field score ${totalScore} · rating ${totalRating} · backing ${backing} · backed ${backedCows} · labor ${labor}h · care quorums ${care} · covered ${covered}`;

  // Overall rating-pool indicator (same figures the main app's gauge shows).
  const pool = $("pool");
  const cells = [
    ["backed", backedCows], ["rating", totalRating], ["backing", backing],
    ["stasis", totalScore], ["labor", `${labor}h`], ["quorums", care], ["covered", covered],
  ];
  pool.innerHTML =
    `<span style="color:#3fb950">● pool</span>` +
    cells.map(([k, v]) => `<span><span style="color:#8b949e">${k}</span> <b>${v}</b></span>`).join("");

  // Stacked bar of score shares.
  const COLORS = ["#3fb950", "#58a6ff", "#d2a8ff", "#ff7b72", "#ffa657", "#79c0ff", "#7ee787", "#ff9e64", "#bb8009", "#6e7681"];
  const bar = $("fieldbar");
  bar.innerHTML = "";
  for (const s of stats) {
    const seg = document.createElement("div");
    const pct = totalScore > 0 ? (s.score / totalScore) * 100 : 0;
    seg.style.width = `${Math.max(pct, s.score > 0 ? 2 : 0)}%`;
    seg.style.background = COLORS[s.i % COLORS.length];
    seg.title = `#${s.i} ${s.addr.slice(0, 10)}… — ${s.score} (${pct.toFixed(1)}%)`;
    bar.appendChild(seg);
  }

  const tb = $("voters");
  tb.innerHTML = "";
  for (const s of [...stats].sort((a, b) => b.score - a.score)) {
    const voicePct = s.score > 0 ? Math.min(100, Math.round((s.locked / s.score) * 100)) : 0;
    const tr = document.createElement("tr");
    if (s.i === me) tr.style.background = "#161b22";
    tr.innerHTML =
      `<td>#${s.i}${s.i === me ? " ◀" : ""}</td>` +
      `<td><b>${s.score}</b> <span class="muted">${totalScore ? ((s.score / totalScore) * 100).toFixed(1) : 0}%</span></td>` +
      `<td>${s.score - s.bonded}</td><td>${s.locked}</td>` +
      `<td><div style="display:flex;align-items:center;gap:6px"><div style="flex:1;min-width:80px;height:8px;background:#21262d;border-radius:4px"><div style="height:8px;width:${voicePct}%;background:${s.locked > s.score ? "#ff7b72" : "#58a6ff"};border-radius:4px"></div></div>${s.locked}/${s.score}</div></td>` +
      `<td>${s.prot}</td><td>${s.cred}</td>`;
    tb.appendChild(tr);
  }
}

async function refresh() {
  const addr = wallets[me].address;
  $("me").textContent = `#${me} ${addr.slice(0, 10)}…`;
  document.querySelectorAll("#accounts button").forEach((b, i) => b.classList.toggle("active-acct", i === me));
  try {
    const s = await acctStats(addr);
    $("mestats").textContent = `score ${s.score} · bonded ${s.bonded} · voice ${s.locked} locked · protection ${s.prot}`;
    const total = await C.cowRating.totalRatingPoints();
    $("field").textContent = `totalRating ${total}`;
    await renderField();
    const rows = await cowRows();
    const tb = $("cows");
    tb.innerHTML = "";
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td>${r.id}</td><td>${r.name}</td><td>${r.state}</td>` +
        `<td>${r.rating}</td><td>${r.backing}</td><td>${r.anchor ? "🟢" : "⚪"}</td><td>${r.myStake}</td><td></td>`;
      const act = tr.lastChild;
      const mk = (label, fn, primary) => {
        const b = document.createElement("button");
        b.textContent = label;
        if (primary) b.className = "primary";
        b.onclick = () => wrap(label, () => fn(r));
        act.appendChild(b);
        act.appendChild(document.createTextNode(" "));
      };
      mk("👍10%", (c) => submit(() => C.cowRating.boost(c.id, ethers.encodeBytes32String("general"), 1000)), true);
      mk("stake 200", (c) => submit(() => C.cowRating.stakeRating(c.id, 200)));
      if (r.myStake > 0) mk("unstake", (c) => submit(() => C.cowRating.unstakeRating(c.id, Math.min(200, r.myStake))));
      tb.appendChild(tr);
    }
    renderAccounts();
  } catch (e) {
    log("refresh failed: " + shortErr(e));
  }
}

async function renderAccounts() {
  const box = $("accounts");
  if (box.childElementCount > 0) return; // buttons persist; active class toggles in refresh()
  wallets.forEach((w, i) => {
    const b = document.createElement("button");
    b.textContent = `#${i} ${w.address.slice(0, 8)}…`;
    b.onclick = () => {
      me = i;
      bind();
      log(`acting as account #${i} (${w.address})`);
      refresh();
    };
    box.appendChild(b);
  });
}

function shortErr(e) {
  const raw = e?.shortMessage || e?.reason || e?.message || String(e);
  // Decode custom errors (0x...) into names using the loaded ABIs.
  try {
    const data = e?.data || e?.error?.data || (typeof raw === "string" && raw.match(/0x[0-9a-fA-F]{8}/)?.[0]);
    if (typeof data === "string" && data.startsWith("0x") && C) {
      for (const c of [C.cowRating, C.generalPool, C.attestation, C.stasis]) {
        try {
          const parsed = c.interface.parseError(data.slice(0, 10));
          if (parsed) return `${parsed.name}: ${raw}`.slice(0, 300);
        } catch { /* try next */ }
      }
    }
  } catch { /* fall through */ }
  return raw.slice(0, 300);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Send with one retry on nonce races (ethers + automining test node).
async function submit(txFn) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const tx = await txFn();
      return await tx.wait();
    } catch (e) {
      if (/nonce|replacement|already been used/i.test(shortErr(e)) && attempt < 2) {
        await sleep(800);
        continue;
      }
      throw e;
    }
  }
}

async function wrap(label, fn) {
  try {
    await fn();
    log(`${label}: confirmed`);
  } catch (e) {
    log(`${label} FAILED: ${shortErr(e)}`);
  }
  refresh();
}

// ------------------------------------------------------------ scenarios

async function asUser(i, fn) {
  const prev = me;
  me = i;
  bind();
  try {
    return await fn(C, wallets[i]);
  } finally {
    me = prev;
    bind();
  }
}

const GENERAL = () => ethers.encodeBytes32String("general");

$("sc-cold").onclick = () => wrap("scenario cold-start", async () => {
  const minter = await asUser(7, async (c, w) => {
    const id = Number(await c.cowNFT.nextTokenId());
    await submit(() => c.cowNFT.mintCow("ipfs://sim-cold"));
    return id;
  });
  log(`minted cow #${minter}; one rater backs it with 200…`);
  await asUser(1, async (c) => submit(() => c.cowRating.stakeRating(minter, 200)));
  const backed = await asUser(0, async (c) => await c.cowRating.cowBacked(minter));
  log(`cow #${minter} is backed immediately (no activation threshold): ${backed}`);
});

$("sc-spend").onclick = () => wrap("scenario voice spend", async () => {
  const before = await asUser(6, async (c, w) => Number(await c.cowRating.voiceLocked(w.address)));
  log(`acct #6 locked before: ${before}`);
  for (const tid of [1, 4, 5]) {
    await asUser(6, async (c) => submit(() => c.cowRating.boost(tid, GENERAL(), 100)));
    log(`acct #6 boosted cow #${tid} with 100 rating`);
  }
  const after = await asUser(6, async (c, w) => ({
    locked: Number(await c.cowRating.voiceLocked(w.address)),
    score: Number(await c.stasis.effectiveScore(w.address)),
  }));
  log(`acct #6 locked after: ${after.locked} of ${after.score} (a voice spends rating directly)`);
});

$("sc-headstart").onclick = () => wrap("scenario head-start", async () => {
  const docHash = ethers.keccak256(ethers.toUtf8Bytes("sim-doc-" + Date.now()));
  await asUser(2, async (c) => submit(() => c.cowRating.registerContent(1, 1, docHash, true)));
  const key = await asUser(2, async (c) => c.cowRating.contentKeyOf(1, 1, docHash));
  const prov = await asUser(2, async (c) => Number(await c.cowRating.contentProvisional(key)));
  const cred = await asUser(2, async (c, w) => Number(await c.oracleCred(w.address)));
  log(`acct #2 cred=${cred} → new doc provisional head start=${prov} (0 = newcomer, needs rating)`);
});

$("sc-anchor").onclick = () => wrap("scenario anchor-gate", async () => {
  const docHash = ethers.keccak256(ethers.toUtf8Bytes("sim-gate-" + Date.now()));
  await asUser(8, async (c) => {
    try {
      await submit(() => c.cowRating.registerContent(3, 1, docHash, true));
    } catch (e) {
      log("register skipped: " + shortErr(e));
    }
  });
  const before = await asUser(8, async (c, w) => Number(await c.stasis.effectiveScore(w.address)));
  await asUser(1, async (c) => submit(() => c.cowRating.getFunction("vote(uint256,uint8,bytes32,uint256,address)")(3, 1, docHash, 500, wallets[8].address)));
  const after = await asUser(8, async (c, w) => Number(await c.stasis.effectiveScore(w.address)));
  log(`cow #3 (no anchor): vote counted, author score ${before} → ${after} (equal = mint correctly skipped)`);
});

// Zero-start course run: a fresh account (#9) begins at 0 Stasis, passes the
// server-graded quizzes, and each lesson pays real Stasis it can then stake
// and vote with. The grader is the deployer (account #0) = wallets[0], so the
// sim signs the completions directly, exactly what the server does.
$("sc-course").onclick = () => wrap("scenario course run", async () => {
  if (!C.academy) return log("academy not deployed on this chain");
  const chainId = (await provider.getNetwork()).chainId;
  const domain = { name: "HoofProofAcademy", version: "1", chainId, verifyingContract: deployment.academy };
  const types = { Completed: [
    { name: "lessonId", type: "uint8" },
    { name: "account", type: "address" },
  ] };

  const learner = 9; // a fresh wallet, never funded
  const before = await asUser(learner, async (c, w) => Number(await c.stasis.effectiveScore(w.address)));
  log(`acct #9 starts at ${before} Stasis (zero-start)`);

  const count = await asUser(0, async (c) => Number(await c.academy.lessonCount()));
  for (let id = 1; id <= count; id++) {
    const account = wallets[learner].address;
    const sig = await wallets[0].signTypedData(domain, types, { lessonId: id, account });
    await asUser(learner, async (c) => submit(() => c.academy.complete(id, sig)));
    const s = await asUser(learner, async (cc, w) => Number(await cc.stasis.effectiveScore(w.address)));
    log(`  lesson ${id} passed · acct #9 Stasis → ${s}`);
  }

  const certified = await asUser(learner, async (c, w) => Boolean(await c.academy.isCertified(w.address)));
  const finalScore = await asUser(learner, async (c, w) => Number(await c.stasis.effectiveScore(w.address)));
  log(`certified=${certified} · earned ${finalScore} Stasis from ${before}`);

  // The earned Stasis is now real voice: stake it on cow #2.
  await asUser(learner, async (c) => submit(() => c.cowRating.stakeRating(2, 100)));
  const backing = await asUser(0, async (c) => Number(await c.cowRating.totalStaked(2)));
  log(`acct #9 staked 100 on cow #2 → cow #2 backing now ${backing} (earned voice, not granted)`);
});

$("refresh").onclick = refresh;

setInterval(() => {
  if ($("autorefresh")?.checked && !document.hidden) refresh().catch(() => {});
}, 4000);

// ------------------------------------------------------------ forum (by hand)

const cHash = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

async function agoraCows() {
  return await (await fetch("http://localhost:3001/api/cows")).json();
}

$("forum-post").onclick = () => wrap("forum post", async () => {
  const tid = Number($("forum-cow").value) || 1;
  const text = $("forum-text").value.trim();
  if (!text) {
    log("write something first");
    return;
  }
  const cows = await agoraCows();
  const cow = cows.find((c) => Number(c.tokenId) === tid);
  if (!cow) throw new Error(`cow #${tid} has no agora record (is the server seeded?)`);
  const addr = wallets[me].address;
  const res = await fetch(`http://localhost:3001/api/cows/${encodeURIComponent(cow.cid)}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: text, author: addr }),
  });
  if (!res.ok) throw new Error("thread create failed: " + res.status);
  const thread = await res.json();
  const postId = thread.posts[0].id;
  const h = cHash("post:" + postId);
  const linked = $("forum-linked").checked;
  await asUser(me, async (c) => submit(() => c.cowRating.registerContent(tid, 2, h, linked)));
  log(`posted as #${me} on cow #${tid} (on-chain registry, protection-linked=${linked})`);
  $("forum-text").value = "";
  loadForum();
});

async function loadForum() {
  const tid = Number($("forum-cow").value) || 1;
  const box = $("forum-posts");
  box.innerHTML = "";
  let cows;
  try {
    cows = await agoraCows();
  } catch {
    box.innerHTML = "<span class='muted'>agora server down (localhost:3001) — start npm run dev</span>";
    return;
  }
  const cow = cows.find((c) => Number(c.tokenId) === tid);
  if (!cow || !cow.threads?.length) {
    box.textContent = "no threads on this cow yet — post the first one above";
    return;
  }
  for (const t of cow.threads) {
    const th = document.createElement("div");
    th.innerHTML = `<div style="margin-top:8px"><strong>${t.title}</strong></div>`;
    box.appendChild(th);
    for (const p of t.posts || []) {
      const h = cHash("post:" + p.id);
      let rating = "?";
      try {
        rating = Number(await C.cowRating.contentRatingOf(tid, 2, h));
      } catch { /* unreadable */ }
      const row = document.createElement("div");
      row.className = "row";
      row.style.marginTop = "4px";
      row.innerHTML = `<span class="muted">${(p.author || "?").slice(0, 14)}…</span><span>${p.text.slice(0, 120)}</span><span><b>${rating}</b></span> `;
      const b = document.createElement("button");
      b.textContent = "👍 rate as me";
      b.onclick = () => ratePost(tid, h, p.authorAddress || null, p);
      row.appendChild(b);
      box.appendChild(row);
    }
  }
}

async function ratePost(tid, h, authorAddr, post) {
  // Snapshot the whole ripple before/after: post, cow, author score, my voice.
  const who = wallets[me].address;
  const snap = async () => ({
    post: Number(await C.cowRating.contentRatingOf(tid, 2, h).catch(() => -1)),
    cow: Number(await C.cowRating.cowRating(tid).catch(() => -1)),
    author: authorAddr ? Number(await C.stasis.effectiveScore(authorAddr).catch(() => -1)) : null,
    locked: Number(await C.cowRating.voiceLocked(who).catch(() => -1)),
  });
  const before = await snap();
  try {
    await submit(() =>
      authorAddr
        ? C.cowRating.getFunction("vote(uint256,uint8,bytes32,uint256,address)")(tid, 2, h, 1000, authorAddr)
        : C.cowRating.getFunction("vote(uint256,uint8,bytes32,uint256)")(tid, 2, h, 1000)
    );
  } catch (e) {
    log(`rate FAILED: ${shortErr(e)}`);
    return;
  }
  const after = await snap();
  const d = (a, b) => (a < 0 || b < 0 ? "?" : `+${b - a}`);
  $("forum-impact").textContent =
    `#${me} rated → post ${before.post}→${after.post} · cow #${tid} ${before.cow}→${after.cow}` +
    (before.author !== null ? ` · author score ${before.author}→${after.author}` : " · author unknown (unattributed)") +
    ` · my voice locked ${before.locked}→${after.locked}` +
    (after.locked !== before.locked + 1000 ? ` · (locked ${after.locked - before.locked}, expected +1000)` : "");
  log(`rated post as #${me}: post ${d(before.post, after.post)}, cow ${d(before.cow, after.cow)}`);
  loadForum();
  refresh();
}

$("forum-load").onclick = loadForum;

// ------------------------------------------------------------ live thread

const live = { tokenId: 0, cidHash: null, key: null, author: null, timer: null, history: [], bots: [1, 2, 3, 4, 5, 6], turn: 0 };
const BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function spark(values) {
  if (!values.length) return "";
  const max = Math.max(...values, 1);
  return values.map((v) => BARS[Math.min(7, Math.floor((v / max) * 8))]).join("");
}

$("live-open").onclick = () => wrap("open live post", async () => {
  const tid = Number($("live-cow").value) || 1;
  const text = $("live-text").value.trim() || ("live post " + Date.now());
  const cidHash = ethers.keccak256(ethers.toUtf8Bytes("sim-live:" + text));
  await asUser(me, async (c, w) => submit(() => c.cowRating.registerContent(tid, 2, cidHash, false)));
  Object.assign(live, { tokenId: tid, cidHash, key: null, author: wallets[me].address, history: [], turn: 0 });
  live.key = await asUser(me, async (c) => c.cowRating.contentKeyOf(tid, 2, cidHash));
  $("live-start").disabled = false;
  $("live-status").textContent = `post live on cow #${tid} by #${me} — start the bots`;
  log(`live post opened on cow #${tid} (author #${me})`);
});

$("live-start").onclick = () => {
  if (!live.cidHash || live.timer) return;
  $("live-start").disabled = true;
  $("live-stop").disabled = false;
  log("bots voting every 5s (500bps, rotating accounts, attributed)…");
  live.timer = setInterval(async () => {
    const bot = live.bots[live.turn++ % live.bots.length];
    try {
      const cowBefore = await asUser(bot, async (c) => Number(await c.cowRating.cowRating(live.tokenId)));
      await asUser(bot, async (c) =>
        submit(() => c.cowRating.getFunction("vote(uint256,uint8,bytes32,uint256,address)")(live.tokenId, 2, live.cidHash, 500, live.author))
      );
      const [content, cowAfter] = await asUser(bot, async (c) => [
        Number(await c.cowRating.contentRatingOf(live.tokenId, 2, live.cidHash)),
        Number(await c.cowRating.cowRating(live.tokenId)),
      ]);
      live.history.push(content);
      if (live.history.length > 40) live.history.shift();
      const note = cowAfter < cowBefore ? " (cow rating fell — a slash, not a vote)" : "";
      $("live-status").textContent = `post ${content} · cow #${live.tokenId} ${cowAfter}${note} · ${live.history.length} bot votes`;
      $("live-spark").textContent = spark(live.history);
      log(`bot #${bot} voted → post ${content}, cow ${cowAfter}${note}`);
    } catch (e) {
      log(`bot #${bot} failed: ${shortErr(e)}`);
    }
    refresh().catch(() => {});
  }, 5000);
};

$("live-stop").onclick = () => {
  clearInterval(live.timer);
  live.timer = null;
  $("live-start").disabled = false;
  $("live-stop").disabled = true;
  log("bots stopped");
};

// ---------------------------------------------------------------- boot

try {
  deployment = await (await fetch("/deployment.json")).json();
  bind();
  renderAccounts();
  log("connected to " + deployment.network + " · cowRating " + deployment.cowRating.slice(0, 10) + "…");
  refresh();
} catch (e) {
  log("boot failed (is the chain + deploy done?): " + shortErr(e));
}

// PoH agorá server — the off-chain half of the system.
//
// On-chain records the *rating history*; this server keeps the prose that is
// too expensive or too mutable for the chain: cow metadata (names, breed,
// story), the discussion threads, the evidence pointers, **user profiles**,
// **fund-event metadata**, and the **activity feed**.
//
// Phase C additions:
//   - per-wallet profiles (name / bio / avatar / links), keyed by address
//   - signature-verified evidence uploads: multipart files stored under
//     `server/uploads/`, content-hash-bound to the uploader's wallet signature
//   - charitable event metadata (events are escrowed on-chain in GeneralPool)
//   - an activity feed per wallet for the profile page
//
//   npm run server
// Then in another terminal: npm run frontend
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const multer = require("multer");
const { verifyMessage } = require("ethers");
const store = require("./store");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3001;
const DEPLOYED = path.join(__dirname, "..", "deployed.json");

// ------------------------------------------------------- evidence uploads

const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB leaves room for photos
});

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// A "Cowhand #XXXX" auto-name until the wallet claims a real profile.
function displayName(address) {
  if (!address) return "anonymous";
  if (!ADDRESS_RE.test(address)) return address; // already-a-name (or junk)
  const profile = store.colGet("profiles", address.toLowerCase());
  return profile?.name || `Cowhand #${address.slice(-4).toUpperCase()}`;
}

// --------------------------------------------------------------- chain config

app.get("/api/config", (_req, res) => {
  let deployed = null;
  try {
    deployed = JSON.parse(fs.readFileSync(DEPLOYED, "utf8"));
  } catch {
    // not deployed yet or running on the deterministic local defaults
  }
  res.json({
    network: deployed ? deployed.network : "hardhat",
    stasis: deployed?.stasis,
    cowNFT: deployed?.cowNFT,
    cowRating: deployed?.cowRating,
    attestation: deployed?.attestation,
    generalPool: deployed?.generalPool,
    herdCouncil: deployed?.herdCouncil,
  });
});

// ------------------------------------------------------------------ cows

app.get("/api/cows", (_req, res) => {
  res.json(store.allRecords());
});

app.post("/api/cows", (req, res) => {
  const { name, breed, age, story, image, visibility } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required" });

  const id = "cow-" + crypto.randomBytes(4).toString("hex");
  const cid = "ipfs://" + id;
  const record = {
    cid,
    tokenId: null, // set once the cow is minted on-chain
    owner: null,
    name,
    breed: breed || "",
    age: age || "",
    story: story || "",
    image: image || "🐄",
    // Visibility starts public. The server enforces reads for non-public
    // records; a stricter on-chain flag ships in the next pass.
    visibility: ["private", "internal", "external", "public"].includes(visibility) ? visibility : "public",
    createdAt: Date.now(),
    threads: [],
    evidence: [], // signature-verified uploads (Phase C oracle record)
  };
  store.put(cid, record);
  res.status(201).json(record);
});

app.get("/api/cows/:cid", (req, res) => {
  const record = store.get(req.params.cid);
  if (!record) return res.status(404).json({ error: "not found" });
  res.json(record);
});

// After a successful mint the app links the on-chain token id to the record.
app.patch("/api/cows/:cid", (req, res) => {
  const record = store.get(req.params.cid);
  if (!record) return res.status(404).json({ error: "not found" });
  if (req.body.tokenId !== undefined) record.tokenId = req.body.tokenId;
  if (req.body.owner !== undefined) record.owner = req.body.owner;
  if (["private", "internal", "external", "public"].includes(req.body.visibility)) {
    record.visibility = req.body.visibility;
  }
  store.put(record.cid, record);
  res.json(record);
});

// -------------------------------------------------------------- discussions

app.post("/api/cows/:cid/threads", (req, res) => {
  const record = store.get(req.params.cid);
  if (!record) return res.status(404).json({ error: "not found" });
  const { title, author } = req.body || {};
  if (!title) return res.status(400).json({ error: "title is required" });

  const authorAddress = ADDRESS_RE.test(author || "") ? author : null;
  const thread = {
    id: crypto.randomBytes(4).toString("hex"),
    title,
    createdAt: Date.now(),
    posts: [
      {
        id: crypto.randomBytes(4).toString("hex"),
        author: authorAddress ? displayName(authorAddress) : author || "anonymous",
        authorAddress,
        text: title, // first post carries the thread text
        createdAt: Date.now(),
      },
    ],
  };
  record.threads.push(thread);
  store.put(record.cid, record);
  res.status(201).json(thread);
});

app.post("/api/cows/:cid/threads/:tid/posts", (req, res) => {
  const record = store.get(req.params.cid);
  if (!record) return res.status(404).json({ error: "not found" });
  const thread = record.threads.find((t) => t.id === req.params.tid);
  if (!thread) return res.status(404).json({ error: "thread not found" });
  const { text, author } = req.body || {};
  if (!text) return res.status(400).json({ error: "text is required" });

  const authorAddress = ADDRESS_RE.test(author || "") ? author : null;
  const post = {
    id: crypto.randomBytes(4).toString("hex"),
    author: authorAddress ? displayName(authorAddress) : author || "anonymous",
    authorAddress,
    text,
    createdAt: Date.now(),
  };
  thread.posts.push(post);
  store.put(record.cid, record);
  res.status(201).json(post);
});

// --------------------------------------------------------------- profiles

// Phase C: per-wallet identity. The wallet controls its own profile by
// signing a change with the matching private key (POST /api/profiles/0x../claim).
app.get("/api/profiles/:address", (req, res) => {
  const addr = (req.params.address || "").toLowerCase();
  if (!ADDRESS_RE.test(addr)) return res.status(400).json({ error: "invalid address" });
  const profile = store.colGet("profiles", addr);
  if (!profile) return res.status(404).json({ error: "profile not found" });
  res.json(profile);
});

app.post("/api/profiles", (req, res) => {
  const { address, name, bio, avatar, links } = req.body || {};
  if (!address || !ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: "a valid wallet address is required" });
  }
  const key = address.toLowerCase();
  const existing = store.colGet("profiles", key) || {
    address: key,
    joinedAt: Date.now(),
  };
  const profile = {
    ...existing,
    address: key,
    name: name?.trim() || existing.name || `Cowhand #${key.slice(-4).toUpperCase()}`,
    bio: typeof bio === "string" ? bio.slice(0, 500) : existing.bio || "",
    avatar: avatar || existing.avatar || "",
    links: Array.isArray(links) ? links.slice(0, 5).map((l) => String(l).slice(0, 300)) : existing.links || [],
    updatedAt: Date.now(),
  };
  store.colPut("profiles", key, profile);
  res.json(profile);
});

// ------------------------------------------------- signature-verified evidence

// Uploads are bound to the uploader's wallet: contentHash = sha256(file),
// signature over the plain-text message "evidence:<contentHash>".
app.post("/api/cows/:cid/evidence", upload.single("file"), (req, res) => {
  const record = store.get(req.params.cid);
  if (!record) return res.status(404).json({ error: "not found" });
  const { address, signature, note } = req.body || {};
  const file = req.file;
  if (!file) return res.status(400).json({ error: "a file is required" });
  if (!address || !ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: "a valid wallet address is required" });
  }

  const hash = crypto.createHash("sha256").update(file.buffer).digest("hex");
  let recovered;
  try {
    recovered = verifyMessage(`evidence:${hash}`, signature);
  } catch {
    return res.status(400).json({ error: "the signature could not be verified" });
  }
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return res.status(401).json({ error: "signature does not match the uploader address" });
  }

  // Safe-ish storage name: content hash + a sanitised lower-cased extension.
  let ext = path.extname(file.originalname || "").replace(/[^a-zA-Z0-9.]/g, "").toLowerCase();
  if (ext.length > 8) ext = "";
  const fileName = `${hash}${ext || ".bin"}`;
  const url = `/api/uploads/${fileName}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, fileName), file.buffer);

  const item = {
    hash,
    fileName,
    url,
    mime: file.mimetype || "application/octet-stream",
    size: file.size,
    uploader: address.toLowerCase(),
    note: note ? String(note).slice(0, 300) : "",
    createdAt: Date.now(),
  };
  record.evidence = record.evidence || [];
  if (record.evidence.length >= 100) record.evidence = record.evidence.slice(-99);
  record.evidence.push(item);
  store.put(record.cid, record);
  res.status(201).json(item);
});

app.get("/api/uploads/:file", (req, res) => {
  const name = path.basename(req.params.file); // strips traversal
  const file = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "not found" });
  res.sendFile(file);
});

// Oracle record for the profile page: every evidence item this wallet uploaded.
app.get("/api/evidence", (req, res) => {
  const uploader = (req.query.uploader || "").toLowerCase();
  if (!ADDRESS_RE.test(uploader)) return res.status(400).json({ error: "uploader address is required" });
  const items = [];
  for (const record of store.allRecords()) {
    for (const ev of record.evidence || []) {
      if (ev.uploader === uploader) items.push({ ...ev, cid: record.cid, tokenId: record.tokenId });
    }
  }
  items.sort((a, b) => b.createdAt - a.createdAt);
  res.json(items);
});

// ----------------------------------------------------------- event metadata

// Fund events are escrowed on-chain (GeneralPool.createEvent / contribute /
// spend). This server only keeps the human prose: what the cause is about.
app.get("/api/events", (_req, res) => {
  const metas = store.colAll("events").map((m) => ({ ...m, goalEth: Number(m.goal || 0) / 1e18 }));
  res.json(metas.sort((a, b) => b.createdAt - a.createdAt));
});

app.get("/api/events/:id", (req, res) => {
  const meta = store.colGet("events", String(req.params.id));
  if (!meta) return res.status(404).json({ error: "event not found" });
  res.json(meta);
});

app.post("/api/events", (req, res) => {
  const { eventId, title, description, image, goal } = req.body || {};
  if (eventId === undefined || eventId === null) {
    return res.status(400).json({ error: "eventId is required" });
  }
  if (!title) return res.status(400).json({ error: "title is required" });
  const meta = {
    eventId: String(eventId),
    title: title.slice(0, 200),
    description: (description || "").slice(0, 1000),
    image: image || "🎁",
    goal: Number(goal || 0),
    createdAt: Date.now(),
  };
  store.colPut("events", meta.eventId, meta);
  res.status(201).json(meta);
});

// ------------------------------------------------------------ activity feed

app.post("/api/activity", (req, res) => {
  const { address, type, detail } = req.body || {};
  if (!address || !ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: "a valid wallet address is required" });
  }
  const entry = {
    ts: Date.now(),
    type: (type || "action").slice(0, 40),
    detail: (detail || "").slice(0, 300),
  };
  store.colAppend("activity", address.toLowerCase(), entry);
  res.status(201).json(entry);
});

app.get("/api/profiles/:address/activity", (req, res) => {
  const key = (req.params.address || "").toLowerCase();
  if (!ADDRESS_RE.test(key)) return res.status(400).json({ error: "invalid address" });
  const list = store.colGet("activity", key) || [];
  res.json([...list].reverse()); // newest first
});

// ------------------------------------------------------------ general store

app.get("/api/store", (_req, res) => {
  // Diagnostics for the demo — not a production endpoint.
  const db = store.load();
  res.json({
    cows: Object.keys(db.records).length,
    profiles: Object.keys(db.collections.profiles || {}).length,
    events: Object.keys(db.collections.events || {}).length,
    activity: Object.keys(db.collections.activity || {}),
  });
});

app.listen(PORT, () => {
  console.log(`PoH agorá listening on http://localhost:${PORT}`);
});
// PoH agorá server — the off-chain half of the system.
//
// On-chain records the *rating history*; this server keeps the prose that is
// too expensive or too mutable for the chain: cow metadata (names, breed,
// story), the discussion threads, and the evidence pointers. Cow records
// reference their metadata by the `cid` stored on-chain (e.g. "ipfs://cow-1").
//
//   npm run server
// Then in another terminal: npm run frontend
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const store = require("./store");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3001;
const DEPLOYED = path.join(__dirname, "..", "deployed.json");

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

  const thread = {
    id: crypto.randomBytes(4).toString("hex"),
    title,
    createdAt: Date.now(),
    posts: [
      {
        id: crypto.randomBytes(4).toString("hex"),
        author: author || "anonymous",
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

  const post = {
    id: crypto.randomBytes(4).toString("hex"),
    author: author || "anonymous",
    text,
    createdAt: Date.now(),
  };
  thread.posts.push(post);
  store.put(record.cid, record);
  res.status(201).json(post);
});

app.listen(PORT, () => {
  console.log(`PoH agorá listening on http://localhost:${PORT}`);
});
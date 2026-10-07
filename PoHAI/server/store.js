// Tiny persistence layer: a JSON file at server/data.json.
// Deliberately zero native dependencies — swap for SQLite/Postgres in the pilot
// without touching the endpoints above it (see server/index.js).
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "data.json");

const EMPTY = { records: {} };

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return JSON.parse(JSON.stringify(EMPTY));
  }
}

function save(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE); // atomic-ish: readers never see a half-written file
}

function allRecords() {
  return Object.values(load().records);
}

function get(cid) {
  return load().records[cid] || null;
}

function put(cid, record) {
  const db = load();
  db.records[cid] = record;
  save(db);
  return record;
}

module.exports = { load, save, allRecords, get, put, EMPTY };
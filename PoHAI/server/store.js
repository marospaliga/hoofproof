// Tiny persistence layer: a JSON file at server/data.json.
// Deliberately zero native dependencies — swap for SQLite/Postgres in the pilot
// without touching the endpoints above it (see server/index.js).
//
// Two namespaces:
//   records      — cow metadata records, keyed by cid (the original store)
//   collections  — flat maps for profiles / event metadata / activity feeds
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "data.json");

const EMPTY = { records: {}, collections: {} };

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

// ------------------------------------------------------------------ records

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

// -------------------------------------------------------------- collections

/** Every value of a named collection (e.g. { profiles: { [address]: profile } }). */
function colAll(name) {
  return Object.values(load().collections[name] || {});
}

function colGet(name, key) {
  return (load().collections[name] || {})[key] || null;
}

function colPut(name, key, value) {
  const db = load();
  if (!db.collections[name]) db.collections[name] = {};
  db.collections[name][key] = value;
  save(db);
  return value;
}

/** Append to a per-key array collection (e.g. activity[address]), newest last. */
function colAppend(name, key, value, max = 100) {
  const db = load();
  if (!db.collections[name]) db.collections[name] = {};
  if (!db.collections[name][key]) db.collections[name][key] = [];
  const arr = db.collections[name][key];
  arr.push(value);
  while (arr.length > max) arr.shift(); // keep recent history only
  save(db);
  return value;
}

module.exports = { load, save, allRecords, get, put, EMPTY, colAll, colGet, colPut, colAppend };
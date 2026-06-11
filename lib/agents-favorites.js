// Agent favorites — list of agents the user has marked as chat-eligible.
// Surfaces in the "Start agent chat" picker on the project view.
//
// Storage: ~/.clagentic/agents/chattable.json.
//
// Schema v1 (legacy, plugin-marketplace era):
//   { "version": 1, "favorites": [{ "name", "kind", "pluginName", "addedAt" }],
//     "recents": [{ "name", "kind", "pluginName", "lastUsedAt" }] }
//
// Schema v2 (lr-8e39, flat catalog — plugin marketplace removed in lr-635a):
//   { "version": 2, "favorites": [{ "name", "addedAt" }],
//     "recents": [{ "name", "lastUsedAt" }] }
//
//   Identity key is `name` only. kind/pluginName are dropped because the SDK
//   catalog (supportedAgents()) exposes a flat list with no plugin distinction.
//   Migration from v1 → v2 runs automatically on first readStore(): entries
//   are deduplicated by name (earliest addedAt wins), kind/pluginName dropped.
//
// Concurrency: single-process daemon; no locking. Writes are atomic via
// rename() to avoid torn reads if a reader races with a writer.

var fs = require("fs");
var path = require("path");
var os = require("os");

var REAL_HOME = process.env.SUDO_USER
  ? path.join("/home", process.env.SUDO_USER)
  : os.homedir();

var FAVORITES_PATH = path.join(REAL_HOME, ".clagentic", "agents", "chattable.json");
var SCHEMA_VERSION = 2;
var RECENTS_LIMIT = 8;

function ensureDir() {
  fs.mkdirSync(path.dirname(FAVORITES_PATH), { recursive: true });
}

function emptyStore() {
  return { version: SCHEMA_VERSION, favorites: [], recents: [] };
}

// Migrate v1 (kind/pluginName keyed) entries to v2 (name-only).
// Deduplicates by name — for favorites, keeps the entry with the earliest
// addedAt; for recents, keeps the entry with the latest lastUsedAt.
// Returns a new store object at version 2. Writes it back to disk.
function migrateV1toV2(store) {
  var seen = {};
  var newFavs = [];
  for (var i = 0; i < store.favorites.length; i++) {
    var f = store.favorites[i];
    if (!f || !f.name) continue;
    var n = f.name;
    if (seen[n] === undefined) {
      seen[n] = newFavs.length;
      newFavs.push({ name: n, addedAt: f.addedAt || Date.now() });
    } else {
      // Keep earliest addedAt
      var existing = newFavs[seen[n]];
      if (f.addedAt && f.addedAt < existing.addedAt) {
        existing.addedAt = f.addedAt;
      }
    }
  }
  var seenR = {};
  var newRecents = [];
  for (var j = 0; j < store.recents.length; j++) {
    var r = store.recents[j];
    if (!r || !r.name) continue;
    var rn = r.name;
    if (seenR[rn] === undefined) {
      seenR[rn] = newRecents.length;
      newRecents.push({ name: rn, lastUsedAt: r.lastUsedAt || Date.now() });
    } else {
      // Keep latest lastUsedAt
      var existingR = newRecents[seenR[rn]];
      if (r.lastUsedAt && r.lastUsedAt > existingR.lastUsedAt) {
        existingR.lastUsedAt = r.lastUsedAt;
      }
    }
  }
  var migrated = { version: SCHEMA_VERSION, favorites: newFavs, recents: newRecents };
  try {
    writeStore(migrated);
    console.log("[agents-favorites] migrated chattable.json v1→v2 (" + newFavs.length + " favorites, " + newRecents.length + " recents)");
  } catch (e) {
    console.error("[agents-favorites] migration write failed:", e.message);
  }
  return migrated;
}

function readStore() {
  var raw;
  try { raw = fs.readFileSync(FAVORITES_PATH, "utf8"); }
  catch (e) {
    if (e.code === "ENOENT") return emptyStore();
    console.error("[agents-favorites] read failed:", e.message);
    return emptyStore();
  }
  var parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    console.error("[agents-favorites] corrupt JSON, returning empty store:", e.message);
    return emptyStore();
  }
  if (!parsed || typeof parsed !== "object") return emptyStore();
  if (!Array.isArray(parsed.favorites)) parsed.favorites = [];
  if (!Array.isArray(parsed.recents)) parsed.recents = [];
  if (typeof parsed.version !== "number") parsed.version = 1;
  // Migrate v1 → v2 on first read.
  if (parsed.version < 2) return migrateV1toV2(parsed);
  return parsed;
}

function writeStore(store) {
  ensureDir();
  var tmp = FAVORITES_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
  fs.renameSync(tmp, FAVORITES_PATH);
}

// Identity match: name is the sole key in v2.
function sameAgent(a, b) {
  if (!a || !b) return false;
  return a.name === b.name;
}

function listFavorites() {
  return readStore().favorites.slice();
}

function isFavorite(agent) {
  var favs = readStore().favorites;
  for (var i = 0; i < favs.length; i++) {
    if (sameAgent(favs[i], agent)) return true;
  }
  return false;
}

// Add an agent to favorites. No-op if already present. Returns true if added,
// false if already present or input invalid.
function addFavorite(agent) {
  if (!agent || !agent.name) return false;
  var store = readStore();
  for (var i = 0; i < store.favorites.length; i++) {
    if (sameAgent(store.favorites[i], agent)) return false;
  }
  store.favorites.push({ name: agent.name, addedAt: Date.now() });
  writeStore(store);
  return true;
}

// Remove an agent from favorites. Returns true if removed, false if not present.
// Note: schema v2 entries have only {name, addedAt} — no kind field — so we
// guard on name only (matching addFavorite and sameAgent).
function removeFavorite(agent) {
  if (!agent || !agent.name) return false;
  var store = readStore();
  var before = store.favorites.length;
  store.favorites = store.favorites.filter(function (f) { return !sameAgent(f, agent); });
  if (store.favorites.length === before) return false;
  writeStore(store);
  return true;
}

// Idempotent toggle — flips membership and returns the new state.
function toggleFavorite(agent) {
  if (isFavorite(agent)) {
    removeFavorite(agent);
    return false;
  }
  addFavorite(agent);
  return true;
}

function listRecents() {
  return readStore().recents.slice();
}

// Bump usage. Moves the agent to the head of recents and trims to RECENTS_LIMIT.
function touchRecent(agent) {
  if (!agent || !agent.name) return;
  var store = readStore();
  store.recents = store.recents.filter(function (r) { return !sameAgent(r, agent); });
  store.recents.unshift({ name: agent.name, lastUsedAt: Date.now() });
  if (store.recents.length > RECENTS_LIMIT) {
    store.recents = store.recents.slice(0, RECENTS_LIMIT);
  }
  writeStore(store);
}

module.exports = {
  FAVORITES_PATH: FAVORITES_PATH,
  RECENTS_LIMIT: RECENTS_LIMIT,
  listFavorites: listFavorites,
  isFavorite: isFavorite,
  addFavorite: addFavorite,
  removeFavorite: removeFavorite,
  toggleFavorite: toggleFavorite,
  listRecents: listRecents,
  touchRecent: touchRecent,
};


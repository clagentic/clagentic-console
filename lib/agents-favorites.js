// Agent favorites — Clay-side list of agents the user has marked as
// chat-eligible. Surfaces in the "Start agent chat" picker on the project
// view; everything not on this list is discovered but not promoted.
//
// Storage: ~/.clay/agents/chattable.json. Schema:
//   {
//     "version": 1,
//     "favorites": [
//       { "name": "gemini-researcher", "kind": "user", "addedAt": 1735000000000 },
//       { "name": "amos", "kind": "plugin", "pluginName": "amos", "addedAt": 1735000000001 }
//     ],
//     "recents": [
//       { "name": "gemini-researcher", "kind": "user", "lastUsedAt": 1735000000500 }
//     ]
//   }
//
// Identity key for an agent across the file is (kind, pluginName, name).
// Built-in agents are not eligible — they have no source .md and the
// favorites surface is for user-installed agents.
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
var SCHEMA_VERSION = 1;
var RECENTS_LIMIT = 8;

function ensureDir() {
  fs.mkdirSync(path.dirname(FAVORITES_PATH), { recursive: true });
}

function emptyStore() {
  return { version: SCHEMA_VERSION, favorites: [], recents: [] };
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
  if (typeof parsed.version !== "number") parsed.version = SCHEMA_VERSION;
  return parsed;
}

function writeStore(store) {
  ensureDir();
  var tmp = FAVORITES_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
  fs.renameSync(tmp, FAVORITES_PATH);
}

// Identity match. pluginName is only meaningful for kind="plugin".
function sameAgent(a, b) {
  if (!a || !b) return false;
  if (a.name !== b.name) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "plugin" && (a.pluginName || null) !== (b.pluginName || null)) return false;
  return true;
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
  if (!agent || !agent.name || !agent.kind) return false;
  if (agent.kind === "builtin") return false;
  var store = readStore();
  for (var i = 0; i < store.favorites.length; i++) {
    if (sameAgent(store.favorites[i], agent)) return false;
  }
  store.favorites.push({
    name: agent.name,
    kind: agent.kind,
    pluginName: agent.kind === "plugin" ? (agent.pluginName || null) : null,
    addedAt: Date.now(),
  });
  writeStore(store);
  return true;
}

// Remove an agent from favorites. Returns true if removed, false if not present.
function removeFavorite(agent) {
  if (!agent || !agent.name || !agent.kind) return false;
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
  if (!agent || !agent.name || !agent.kind) return;
  var store = readStore();
  store.recents = store.recents.filter(function (r) { return !sameAgent(r, agent); });
  store.recents.unshift({
    name: agent.name,
    kind: agent.kind,
    pluginName: agent.kind === "plugin" ? (agent.pluginName || null) : null,
    lastUsedAt: Date.now(),
  });
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

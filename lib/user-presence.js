var fs = require("fs");
var path = require("path");
var config = require("./config");

// In-memory store: { slug: { userId: { sessionId, mateDm } } }
var store = {};
var presencePath = path.join(config.CONFIG_DIR, "user-presence.json");
var saveTimer = null;

// Load from disk on startup
function load() {
  try {
    if (fs.existsSync(presencePath)) {
      var raw = fs.readFileSync(presencePath, "utf8");
      store = JSON.parse(raw);
    }
  } catch (e) {
    store = {};
  }
}

// Debounced save to disk (200ms)
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    try {
      config.ensureConfigDir();
      fs.writeFileSync(presencePath, JSON.stringify(store, null, 2), "utf8");
    } catch (e) {
      // Silently ignore write errors
    }
  }, 200);
}

function setPresence(slug, userId, sessionId, mateDm) {
  if (!slug || !userId) return;
  if (!store[slug]) store[slug] = {};
  store[slug][userId] = {
    sessionId: sessionId || null,
    mateDm: mateDm !== undefined ? mateDm : null,
  };
  scheduleSave();
}

function getPresence(slug, userId) {
  if (!slug || !userId) return null;
  if (!store[slug]) return null;
  return store[slug][userId] || null;
}

function clearPresence(slug, userId) {
  if (!slug || !userId) return;
  if (store[slug]) {
    delete store[slug][userId];
    if (Object.keys(store[slug]).length === 0) delete store[slug];
    scheduleSave();
  }
}

// Remove all presence entries referencing a deleted session
function clearSession(slug, sessionId) {
  if (!slug || !store[slug]) return;
  var keys = Object.keys(store[slug]);
  for (var i = 0; i < keys.length; i++) {
    if (store[slug][keys[i]].sessionId === sessionId) {
      store[slug][keys[i]].sessionId = null;
    }
  }
  scheduleSave();
}

load();

module.exports = {
  setPresence: setPresence,
  getPresence: getPresence,
  clearPresence: clearPresence,
  clearSession: clearSession,
};

// agent-roster.js - every agent identity the console has seen, with when and
// where, and the avatar the operator chose for it.
//
// Built only from what is observed. An identity is recorded under the exact key
// it arrived with (a session's agent name, a Task or Agent tool call's
// subagent_type, an injected sender's name); nothing is guessed, merged or
// case-folded. Nothing in this file names an agent.
//
// Observation is read-only: callers report a sighting and carry on, and a
// sighting that cannot be recorded is logged, never thrown into the session or
// delivery that produced it.
//
// Persistence is one file under the console data dir. daemon.json is not used:
// the daemon rewrites it wholesale from its in-memory config, which would drop
// entries written from here. The file holds the roster and each agent's avatar
// reference together, so a restart restores both.
//
// An avatar reference is {style, seed} (a built-in robot style) or {custom}
// (a slug in the global custom-icon store, /api/custom-emoji). The store keeps
// the image; this file only keeps the slug.

var fs = require("fs");

var FILE_VERSION = 1;

var SOURCE = Object.freeze({ SESSION: "session", SUBAGENT: "subagent", SENDER: "sender" });
var SOURCES = Object.freeze(Object.keys(SOURCE).map(function (k) { return SOURCE[k]; }));

var MAX_AGENTS = 1000;
var MAX_KEY_LENGTH = 128;
var MAX_PLACES = 20;
var MAX_PLACE_FIELD_LENGTH = 128;
var MAX_SEED_LENGTH = 128;
var PERSIST_DELAY_MS = 500;

// Mirrors the custom-icon store's slug rule (lib/server-settings.js).
var SLUG_RE = /^[a-z0-9_-]{1,64}$/;
var STYLE_RE = /^[a-z0-9-]{1,32}$/;
var CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

function isUsableKey(key) {
  return typeof key === "string" && key.length > 0 && key.length <= MAX_KEY_LENGTH
    && key.trim().length > 0 && !CONTROL_CHARS.test(key);
}

function fieldOf(value) {
  if (value === undefined || value === null) return null;
  var text = String(value);
  return text.length > 0 && text.length <= MAX_PLACE_FIELD_LENGTH ? text : null;
}

// Returns { ok: true, avatar } (avatar null clears the choice) or { ok: false, error }.
function validateAvatar(ref) {
  if (ref === null || ref === undefined) return { ok: true, avatar: null };
  if (typeof ref !== "object" || Array.isArray(ref)) return { ok: false, error: "avatar must be an object or null" };
  if (ref.custom !== undefined) {
    if (typeof ref.custom !== "string" || !SLUG_RE.test(ref.custom)) return { ok: false, error: "custom must be a custom-icon slug" };
    return { ok: true, avatar: { custom: ref.custom } };
  }
  if (typeof ref.style !== "string" || !STYLE_RE.test(ref.style)) return { ok: false, error: "style must be a built-in avatar style id" };
  if (typeof ref.seed !== "string" || ref.seed.length === 0 || ref.seed.length > MAX_SEED_LENGTH || CONTROL_CHARS.test(ref.seed)) {
    return { ok: false, error: "seed must be a non-empty string of at most " + MAX_SEED_LENGTH + " characters" };
  }
  return { ok: true, avatar: { style: ref.style, seed: ref.seed } };
}

function placeFromStored(raw) {
  if (!raw || typeof raw !== "object" || SOURCES.indexOf(raw.source) === -1) return null;
  var lastSeen = typeof raw.lastSeen === "number" ? raw.lastSeen : null;
  if (lastSeen === null) return null;
  return { source: raw.source, project: fieldOf(raw.project), session: fieldOf(raw.session), lastSeen: lastSeen };
}

function entryFromStored(raw) {
  if (!raw || !isUsableKey(raw.key) || typeof raw.firstSeen !== "number" || typeof raw.lastSeen !== "number") return null;
  var avatar = validateAvatar(raw.avatar);
  var places = Array.isArray(raw.places) ? raw.places.map(placeFromStored).filter(Boolean).slice(0, MAX_PLACES) : [];
  return { key: raw.key, firstSeen: raw.firstSeen, lastSeen: raw.lastSeen, places: places, avatar: avatar.ok ? avatar.avatar : null };
}

// The roster key of an injected sender, from the fields lib/injected-sender.js
// records. An extracted sender is keyed by its agent name: its fromName is the
// "<agent or vendor>@<project>" label and names no agent by itself. A declared
// sender is keyed by the name it gave. Every other kind (undeclared, the
// console's own automations, unrecorded) names no agent and has no key.
// lib/public/modules/agent-avatar.js (senderAgentKey) applies the same rule in
// the browser; test/agent-roster.test.js holds the two together.
function senderKey(sender) {
  if (!sender) return null;
  if (sender.senderKind === "extracted") return sender.senderAgent || sender.fromName || null;
  if (sender.senderKind === "declared") return sender.fromName || null;
  return null;
}

// The roster as one reader may see it. A place names a project and a session, so
// it is kept only when mayReadProject(slug) says the reader can read that
// project (slug is null for a sighting that named none); an agent left with no readable place is left out, since its
// existence would say where it was seen. Avatar references name no project.
function filterForReader(agents, mayReadProject) {
  var out = [];
  agents.forEach(function (entry) {
    var places = entry.places.filter(function (p) { return mayReadProject(p.project) === true; });
    if (places.length === 0) return;
    out.push(Object.assign({}, entry, { places: places }));
  });
  return out;
}

function loadFile(file) {
  var raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code !== "ENOENT") console.error("[agent-roster] could not read " + file + ":", e.message);
    return [];
  }
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error("[agent-roster] " + file + " is not valid JSON; starting with an empty roster:", e.message);
    return [];
  }
  var stored = parsed && Array.isArray(parsed.agents) ? parsed.agents : [];
  return stored.map(entryFromStored).filter(Boolean).slice(0, MAX_AGENTS);
}

function copyEntry(entry) {
  return {
    key: entry.key,
    firstSeen: entry.firstSeen,
    lastSeen: entry.lastSeen,
    places: entry.places.map(function (p) { return { source: p.source, project: p.project, session: p.session, lastSeen: p.lastSeen }; }),
    avatar: entry.avatar ? Object.assign({}, entry.avatar) : null,
  };
}

// deps: {
//   file                  absolute path of the roster file
//   writeJson(file, obj)  returns a promise (lib/store.js writeJsonAt)
//   clock()               ms since epoch; defaults to Date.now
//   onChange()            called after the roster or an avatar changed
// }
function createAgentRoster(deps) {
  var clock = typeof deps.clock === "function" ? deps.clock : Date.now;
  var agents = new Map();
  loadFile(deps.file).forEach(function (entry) { agents.set(entry.key, entry); });

  var timer = null;
  var lastWrite = Promise.resolve();
  var fullLogged = false;

  function changed() {
    if (typeof deps.onChange !== "function") return;
    try { deps.onChange(); }
    catch (e) { console.error("[agent-roster] change hook failed:", e && e.message ? e.message : e); }
  }

  function persistNow() {
    if (timer) { clearTimeout(timer); timer = null; }
    var body = { version: FILE_VERSION, agents: list() };
    lastWrite = Promise.resolve(deps.writeJson(deps.file, body)).catch(function (e) {
      console.error("[agent-roster] could not write " + deps.file + ":", e && e.message ? e.message : e);
    });
    return lastWrite;
  }

  // Sightings repeat on every Task call; the file is written once per burst.
  function persistSoon() {
    if (timer) return;
    timer = setTimeout(persistNow, PERSIST_DELAY_MS);
    if (typeof timer.unref === "function") timer.unref();
  }

  function list() {
    return Array.from(agents.values())
      .sort(function (a, b) { return b.lastSeen - a.lastSeen || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); })
      .map(copyEntry);
  }

  function recordPlace(entry, sighting, now) {
    var project = fieldOf(sighting.project);
    var session = fieldOf(sighting.sessionId);
    var found = null;
    for (var i = 0; i < entry.places.length; i++) {
      var p = entry.places[i];
      if (p.source === sighting.source && p.project === project && p.session === session) { found = p; break; }
    }
    if (found) {
      found.lastSeen = now;
      return;
    }
    entry.places.push({ source: sighting.source, project: project, session: session, lastSeen: now });
    if (entry.places.length > MAX_PLACES) {
      entry.places.sort(function (a, b) { return b.lastSeen - a.lastSeen; });
      entry.places.length = MAX_PLACES;
    }
  }

  // sighting: { key, source, project?, sessionId? }. Returns true when recorded.
  function observe(sighting) {
    try {
      if (!sighting || !isUsableKey(sighting.key) || SOURCES.indexOf(sighting.source) === -1) return false;
      var now = clock();
      var entry = agents.get(sighting.key);
      if (!entry) {
        if (agents.size >= MAX_AGENTS) {
          if (!fullLogged) {
            fullLogged = true;
            console.warn("[agent-roster] roster holds " + MAX_AGENTS + " agents; new identities are not recorded");
          }
          return false;
        }
        entry = { key: sighting.key, firstSeen: now, lastSeen: now, places: [], avatar: null };
        agents.set(entry.key, entry);
      }
      entry.lastSeen = now;
      recordPlace(entry, sighting, now);
      persistSoon();
      changed();
      return true;
    } catch (e) {
      console.error("[agent-roster] could not record a sighting:", e && e.message ? e.message : e);
      return false;
    }
  }

  // Returns { ok: true, agent } or { ok: false, error }. An agent that was never
  // seen has no entry to carry a choice, so it is reported, not created.
  function setAvatar(key, ref) {
    var entry = typeof key === "string" ? agents.get(key) : null;
    if (!entry) return { ok: false, error: "that agent has not been seen" };
    var checked = validateAvatar(ref);
    if (!checked.ok) return checked;
    entry.avatar = checked.avatar;
    persistNow();
    changed();
    return { ok: true, agent: copyEntry(entry) };
  }

  // The custom-icon store renamed a slug: choices that named it follow it.
  function renameCustomIcon(oldSlug, newSlug) {
    var moved = 0;
    agents.forEach(function (entry) {
      if (entry.avatar && entry.avatar.custom === oldSlug) {
        entry.avatar = { custom: newSlug };
        moved++;
      }
    });
    if (moved > 0) {
      persistNow();
      changed();
    }
    return moved;
  }

  // Resolves once everything recorded so far is on disk.
  function flush() {
    if (timer) return persistNow();
    return lastWrite;
  }

  return { observe: observe, setAvatar: setAvatar, renameCustomIcon: renameCustomIcon, list: list, flush: flush };
}

module.exports = {
  createAgentRoster: createAgentRoster,
  validateAvatar: validateAvatar,
  senderKey: senderKey,
  filterForReader: filterForReader,
  SOURCE: SOURCE,
  MAX_AGENTS: MAX_AGENTS,
  MAX_PLACES: MAX_PLACES,
  MAX_KEY_LENGTH: MAX_KEY_LENGTH,
};

"use strict";

// Per-user notification preferences, kept on the server so the phone and the
// desktop of one user agree and so push can be filtered where it is sent.
//
// A preference is a boolean for each (surface, category): the surfaces are the
// in-app banner, the sound and push; the categories group the notification
// types that exist. Muting a category never hides the item: the notifications
// panel and the session's prompt card still show it. Only the alert, the sound
// and the push are suppressed (the client reads this for the first two, the
// push module for the third).
//
// Store: <CONFIG_DIR>/notification-prefs.json, i.e. ~/.clagentic/console/
// notification-prefs.json, written atomically with mode 0600:
//   { "version": 1, "users": { "<userId or _default>": { "banner": {...}, "sound": {...}, "push": {...} } } }
// The key "_default" is the one user of a daemon that has no accounts.

var fs = require("fs");
var path = require("path");
var config = require("./config");
var store = require("./store");

var FILE_NAME = "notification-prefs.json";
var DEFAULT_USER = "_default";

var SURFACES = ["banner", "sound", "push"];
var CATEGORIES = ["turn_done", "approval", "approval_reminder", "loop", "messages", "system"];

// Display names for the settings panel; the client renders these.
var CATEGORY_LABELS = {
  turn_done: "Turn finished",
  approval: "Approval prompts and questions",
  approval_reminder: "Approval reminders",
  loop: "Loop and schedule results",
  messages: "Messages and mentions",
  system: "Account and system notices",
};

// The category of a notification type comes from the type's registration
// (lib/notify/types.js), for the banner and the push alike. Only a type no
// emitter registers is listed here: one that is not raised through the core
// (the system notices) and the type names rows saved by earlier versions carry.
var UNREGISTERED_CATEGORY = {
  mate_dm: "messages",
  mention_response: "messages",
  auth_required: "system",
};

function registeredCategory(type) {
  // Required here, not at load: the core loads the push modules that load this one.
  var registered = require("./notify").getType(type);
  return registered ? registered.category : null;
}

// Today's behaviour: every banner and push is on; the sound plays for a
// finished turn only.
function defaultPrefs() {
  var out = {};
  SURFACES.forEach(function (surface) {
    out[surface] = {};
    CATEGORIES.forEach(function (category) {
      out[surface][category] = surface === "sound" ? category === "turn_done" : true;
    });
  });
  return out;
}

// The categories each preset switches on, on every surface. "system" is left
// as the user has it: an expired login or a failed update needs the operator
// whatever else is muted.
var PRESETS = {
  all: { label: "Everything (default)", enabled: null },
  approval_prompts: { label: "Approval prompts only", enabled: ["approval", "approval_reminder"] },
  approval_reminders: { label: "Approval reminders only", enabled: ["approval_reminder"] },
};

function applyPreset(prefs, presetName) {
  // presetName comes from a client: only a preset this module defines counts.
  if (!Object.prototype.hasOwnProperty.call(PRESETS, presetName)) return null;
  var preset = PRESETS[presetName];
  var base = defaultPrefs();
  var next = {};
  SURFACES.forEach(function (surface) {
    next[surface] = {};
    CATEGORIES.forEach(function (category) {
      if (category === "system") next[surface][category] = prefs[surface][category];
      else if (preset.enabled === null) next[surface][category] = base[surface][category];
      else next[surface][category] = preset.enabled.indexOf(category) !== -1;
    });
  });
  return next;
}

// Which preset the preferences equal, or null for a custom mix.
function presetOf(prefs) {
  var names = Object.keys(PRESETS);
  for (var i = 0; i < names.length; i++) {
    var applied = applyPreset(prefs, names[i]);
    if (JSON.stringify(applied) === JSON.stringify(prefs)) return names[i];
  }
  return null;
}

// Stored data is whatever a file or a client held; only known booleans count.
function normalize(raw) {
  var out = defaultPrefs();
  if (!raw || typeof raw !== "object") return out;
  SURFACES.forEach(function (surface) {
    var row = raw[surface];
    if (!row || typeof row !== "object") return;
    CATEGORIES.forEach(function (category) {
      if (typeof row[category] === "boolean") out[surface][category] = row[category];
    });
  });
  return out;
}

function categoryOfNotification(type) {
  var registered = registeredCategory(type);
  if (registered) return registered;
  return Object.prototype.hasOwnProperty.call(UNREGISTERED_CATEGORY, type) ? UNREGISTERED_CATEGORY[type] : null;
}

// A push payload's category is its type's. A type no one registers (the silent
// "test" validation push) is never filtered.
function categoryOfPush(payload) {
  if (!payload || typeof payload.type !== "string") return null;
  // A close push follows the preference of the notification it closes.
  if (payload.type === "notify_close") return categoryOfPush({ type: payload.closes });
  return registeredCategory(payload.type);
}

function userKey(userId) {
  return typeof userId === "string" && userId ? userId : DEFAULT_USER;
}

/**
 * @param {object} [o]
 * @param {string} [o.file] absolute path of the store file (tests); default is
 *   the console config directory's notification-prefs.json.
 * @param {function(object)} [o.persist] writes the whole document; default is
 *   store.js, which queues and writes atomically.
 */
function createPrefsStore(o) {
  o = o || {};
  var file = o.file || path.join(config.CONFIG_DIR, FILE_NAME);
  var persist = o.persist || function (doc) {
    return store.writeJsonAt(file, doc).catch(function (err) {
      process.stderr.write("[notification-prefs] save failed: " + (err && err.message ? err.message : err) + "\n");
    });
  };
  var users = Object.create(null);

  try {
    var saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved && saved.users && typeof saved.users === "object") {
      Object.keys(saved.users).forEach(function (id) { users[id] = normalize(saved.users[id]); });
    }
  } catch (e) {
    if (e.code !== "ENOENT") process.stderr.write("[notification-prefs] ignoring unreadable " + file + ": " + e.message + "\n");
  }

  function save() {
    return persist({ version: 1, users: users });
  }

  function get(userId) {
    var key = userKey(userId);
    return users[key] ? normalize(users[key]) : defaultPrefs();
  }

  function view(userId) {
    var prefs = get(userId);
    return {
      prefs: prefs,
      preset: presetOf(prefs),
      known: Object.prototype.hasOwnProperty.call(users, userKey(userId)),
    };
  }

  /**
   * Change a user's preferences by preset name or by per-cell patch
   * ({surface: {category: boolean}}). Unknown names and non-booleans are
   * ignored. Returns the user's resulting view.
   */
  function set(userId, change) {
    var key = userKey(userId);
    var prefs = get(userId);
    if (change && typeof change.preset === "string") {
      var applied = applyPreset(prefs, change.preset);
      if (applied) prefs = applied;
    }
    if (change && change.surfaces && typeof change.surfaces === "object") {
      prefs = normalize(Object.assign({}, prefs, mergeSurfaces(prefs, change.surfaces)));
    }
    users[key] = prefs;
    save();
    return view(userId);
  }

  function mergeSurfaces(prefs, patch) {
    var out = {};
    SURFACES.forEach(function (surface) {
      out[surface] = Object.assign({}, prefs[surface], patch[surface] && typeof patch[surface] === "object" ? patch[surface] : {});
    });
    return out;
  }

  /**
   * Seed a user's preferences from what the browser held before they lived on
   * the server, once: only when the user has none stored. Today's globals map
   * as far as they mean anything per user: the sound switch is the turn-done
   * sound. The browser-alert and push switches describe this browser's
   * permission and subscription, not a choice about types, and stay with it.
   */
  function migrateLegacy(userId, legacy) {
    if (Object.prototype.hasOwnProperty.call(users, userKey(userId))) return view(userId);
    var prefs = defaultPrefs();
    if (legacy && legacy.sound === false) prefs.sound.turn_done = false;
    users[userKey(userId)] = prefs;
    save();
    return view(userId);
  }

  function allows(userId, surface, category) {
    if (!category) return true;
    var row = get(userId)[surface];
    return !row || row[category] !== false;
  }

  return {
    get: get,
    view: view,
    set: set,
    migrateLegacy: migrateLegacy,
    allows: allows,
  };
}

module.exports = {
  createPrefsStore: createPrefsStore,
  categoryOfNotification: categoryOfNotification,
  categoryOfPush: categoryOfPush,
  defaultPrefs: defaultPrefs,
  userKey: userKey,
  SURFACES: SURFACES,
  CATEGORIES: CATEGORIES,
  CATEGORY_LABELS: CATEGORY_LABELS,
  PRESETS: PRESETS,
  DEFAULT_USER: DEFAULT_USER,
  FILE_NAME: FILE_NAME,
};

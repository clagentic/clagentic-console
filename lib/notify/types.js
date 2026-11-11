"use strict";

// The notification types registered with the core. Adding a type is adding an
// entry here; emitters then call notify()/resolve() with its name.

var PROMPT_TYPES = {
  permission_request: { category: "approval", collapse: "request", persistent: true, banner: true, liveInState: true },
  permission_reminder: { category: "approval_reminder", collapse: "session", persistent: true, renotify: true, banner: true, liveInState: true },
  ask_user: { category: "approval", collapse: "request", persistent: true, banner: true, liveInState: true },
  elicitation: { category: "approval", collapse: "request", persistent: true, banner: true, liveInState: true },
};

// What happened in a session, a loop or a conversation. Nothing waits on the
// person, so none is closed when a prompt resolves; a repeat for the same
// session replaces the earlier one.
var ACTIVITY_TYPES = {
  response_done: { category: "turn_done", collapse: "session", renotify: true, banner: true, closeOnResolve: false },
  loop_complete: { category: "loop", collapse: "session", renotify: true, banner: true, closeOnResolve: false },
  loop_error: { category: "loop", collapse: "session", renotify: true, banner: true, closeOnResolve: false },
  mate_dm: { category: "messages", collapse: "session", renotify: true, banner: true, closeOnResolve: false },
  user_mention: { category: "messages", collapse: "session", renotify: true, banner: true, closeOnResolve: false, pushUnlessOnline: true },
};

// What the console itself needs the operator for. None is tied to a prompt, so
// a prompt resolving never closes one: each closes only by its own resolve
// (resolve(target, audience, { type })), whose tag derives from the target
// alone and so works from any process.
//
// The page does not reconcile these against its notification list (liveInState
// is off): the reconcile is scoped to the page's own project (see
// notify-client.js), and a system target has no project (slug null).
var SYSTEM_TYPES = {
  // A sign-in is missing for a session's agent. Target: that session; owner only.
  auth_required: { category: "system", collapse: "session", persistent: true, renotify: true, banner: true, closeOnResolve: false, audience: "target" },
  // The installed build is newer than the running one. Target: the console
  // itself (slug and session null). Only an admin can restart, so only admins
  // are told. Closed when the build is adopted or the offer is declined.
  build_update_offer: { category: "system", collapse: "session", persistent: true, banner: true, closeOnResolve: false, audience: "admins", ephemeral: true },
  // A newer release exists. Target: the console itself; admins only. Ephemeral:
  // after the update the banner would announce the version already running.
  update_available: { category: "system", collapse: "session", banner: true, closeOnResolve: false, audience: "admins", ephemeral: true },
};

function registerBuiltins(registry) {
  Object.keys(PROMPT_TYPES).forEach(function (name) {
    registry.register(name, PROMPT_TYPES[name]);
  });
  Object.keys(ACTIVITY_TYPES).forEach(function (name) {
    registry.register(name, ACTIVITY_TYPES[name]);
  });
  Object.keys(SYSTEM_TYPES).forEach(function (name) {
    registry.register(name, SYSTEM_TYPES[name]);
  });
  return registry;
}

module.exports = { registerBuiltins: registerBuiltins, PROMPT_TYPES: PROMPT_TYPES, ACTIVITY_TYPES: ACTIVITY_TYPES, SYSTEM_TYPES: SYSTEM_TYPES };

"use strict";

// The notification types registered with the core. Adding a type is adding an
// entry here; emitters then call notify()/resolve() with its name.

var PROMPT_TYPES = {
  permission_request: { category: "approval", collapse: "request", persistent: true, banner: true, liveInState: true },
  permission_reminder: { category: "approval_reminder", collapse: "session", persistent: true, renotify: true, banner: true, liveInState: true },
  ask_user: { category: "approval", collapse: "request", persistent: true, liveInState: true },
  elicitation: { category: "approval", collapse: "request", persistent: true, liveInState: true },
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

function registerBuiltins(registry) {
  Object.keys(PROMPT_TYPES).forEach(function (name) {
    registry.register(name, PROMPT_TYPES[name]);
  });
  Object.keys(ACTIVITY_TYPES).forEach(function (name) {
    registry.register(name, ACTIVITY_TYPES[name]);
  });
  return registry;
}

module.exports = { registerBuiltins: registerBuiltins, PROMPT_TYPES: PROMPT_TYPES, ACTIVITY_TYPES: ACTIVITY_TYPES };

"use strict";

// The notification types registered with the core. Adding a type is adding an
// entry here; emitters then call notify()/resolve() with its name.

var PROMPT_TYPES = {
  permission_request: { category: "approval", collapse: "request", persistent: true, liveInState: true },
  permission_reminder: { category: "approval_reminder", collapse: "session", persistent: true, renotify: true, liveInState: true },
  ask_user: { category: "approval", collapse: "request", persistent: true },
  elicitation: { category: "approval", collapse: "request", persistent: true },
};

function registerBuiltins(registry) {
  Object.keys(PROMPT_TYPES).forEach(function (name) {
    registry.register(name, PROMPT_TYPES[name]);
  });
  return registry;
}

module.exports = { registerBuiltins: registerBuiltins, PROMPT_TYPES: PROMPT_TYPES };

"use strict";

// Resolver values for the kinds whose vendor callback is a tool-permission
// check (Claude's canUseTool and the Codex approvals routed through it): the
// callback receives {behavior: "allow", updatedInput} or {behavior: "deny",
// message}.

var { ownValue } = require("./codecs");

var CANCEL_MESSAGES = {
  aborted: "Request cancelled",
  expired: "Permission request timed out",
  turn_ended: "Session turn ended",
  query_ended: "Query ended",
  rewind: "Session rewound",
  cleared: "Context cleared",
  session_deleted: "Session deleted",
  shutdown: "Daemon shut down",
};

function allow(input) {
  return { behavior: "allow", updatedInput: input };
}

function deny(message) {
  return { behavior: "deny", message: message };
}

/** A prompt that ended without an operator answer always stops the call. */
function cancelled(reason) {
  return deny(ownValue(CANCEL_MESSAGES, reason) || "Request cancelled");
}

module.exports = {
  allow: allow,
  deny: deny,
  cancelled: cancelled,
};

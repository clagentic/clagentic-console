"use strict";

// Every prompt kind the registry knows. A kind is an adapter: how a request
// is described on the wire, how a response is parsed and validated, what the
// vendor's callback receives for it, and what it receives when the prompt
// ends without an answer. A kind's parse() returns {invalid: reason} for an
// answer that cannot stand; the prompt then stays pending. Lifecycle,
// ownership and storage are the registry's (lib/prompt-registry.js).

var KINDS = {
  permission: require("./permission"),
  plan: require("./plan"),
  ask_user: require("./ask-user"),
  elicitation: require("./elicitation"),
  extension: require("./extension"),
};

// Plan approval rides the tool-permission callback; it is its own kind
// because its decisions and their side effects differ.
function toolApprovalKind(toolName) {
  return toolName === "ExitPlanMode" ? "plan" : "permission";
}

/** Session fields that hold pending prompts, one per store. */
function sessionStores() {
  var seen = {};
  var out = [];
  Object.keys(KINDS).forEach(function (name) {
    var kind = KINDS[name];
    if (kind.scope !== "session" || seen[kind.store]) return;
    seen[kind.store] = true;
    out.push(kind.store);
  });
  return out;
}

/**
 * The kind of a stored record. A record carries its kind from open(); one
 * without (written before kinds existed) is classified by the store it sits
 * in.
 */
function kindOfRecord(record, store) {
  if (record && record.kind && KINDS[record.kind]) return KINDS[record.kind];
  if (store === "pendingAskUser") return KINDS.ask_user;
  if (store === "pendingElicitations") return KINDS.elicitation;
  return KINDS[toolApprovalKind(record && record.toolName)];
}

module.exports = {
  KINDS: KINDS,
  toolApprovalKind: toolApprovalKind,
  sessionStores: sessionStores,
  kindOfRecord: kindOfRecord,
};

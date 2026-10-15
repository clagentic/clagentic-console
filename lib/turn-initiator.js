// turn-initiator.js - who started a turn, carried per turn from the entry point
// that created it to the agent adapter that delivers it.
//
// The initiator is a property of ONE turn, never of a session: a session can
// take a typed turn, then a scheduled one, then a typed one again. Each entry
// point (the WebSocket "message" handler, the scheduled-message timer, a Ralph
// loop iteration, an external trigger) names its initiator and passes it with
// the turn; an adapter maps it to the vendor's own provenance field. A turn
// whose entry point names none is delivered unstamped.
//
// This module owns the console-side vocabulary and the Claude mapping. Where a
// vendor carries provenance in a different place (the Codex adapter), the
// adapter maps from the same vocabulary.

var pkg = require("../package.json");
var runtimeEnv = require("./runtime-env");
// Required for its constant only: nothing of the identity surface runs from here.
var IDENTITY_DIR_ENV = require("./identity/contract").IDENTITY_DIR_ENV;

var INITIATORS = Object.freeze({
  // Text a person typed into the console.
  HUMAN: "human",
  // A message the console sent at the time the person scheduled it.
  SCHEDULED: "scheduled",
  // A scheduled message the person chose to send now.
  SCHEDULED_NOW: "scheduled-now",
  // One iteration of an automated loop.
  LOOP: "loop",
  // A turn delivered by an external trigger.
  TRIGGER: "trigger",
});

var KNOWN = Object.keys(INITIATORS).map(function (k) { return INITIATORS[k]; });

function isInitiator(value) {
  return KNOWN.indexOf(value) !== -1;
}

// The Claude Agent SDK's SDKMessageOrigin for a turn. Undefined when the turn
// names no initiator: the SDK treats an absent origin as unattributed, so only
// a turn the console knows the source of is stamped.
function claudeOrigin(initiator) {
  switch (initiator) {
    case INITIATORS.HUMAN:
      return { kind: "human" };
    case INITIATORS.SCHEDULED:
      return { kind: "task-notification", subkind: "scheduled-trigger", fireReason: "scheduled" };
    case INITIATORS.SCHEDULED_NOW:
      return { kind: "task-notification", subkind: "scheduled-trigger", fireReason: "manual" };
    case INITIATORS.LOOP:
      return { kind: "task-notification", subkind: "scheduled-trigger", fireReason: "loop" };
    case INITIATORS.TRIGGER:
      return { kind: "task-notification", subkind: "scheduled-trigger", fireReason: "trigger" };
    default:
      return undefined;
  }
}

// Whether the CLI must deliver the turn's text as written (no @path expansion,
// no slash-command dispatch): true for every turn a person did not type.
function isClientComposed(initiator) {
  return isInitiator(initiator) && initiator !== INITIATORS.HUMAN;
}

// Identifies this product to the Claude Agent SDK ("<app>/<version>").
function clientAppId() {
  return "clagentic-console/" + pkg.version;
}

// The environment additions the console always makes for a Claude process.
// Laid over the process's own environment by the caller, never in place of it.
//
// CLAUDE_CODE_HOST_SCHEDULED_RUN is declared on every process, whatever turn
// starts it. The CLI keeps a host-declared scheduled-trigger origin only in a
// process started with it, and the environment cannot change once the process
// runs, while turns of any initiator reach a live process (a typed turn starts
// it, a trigger or scheduled turn is pushed in later; messages buffered between
// turns are replayed into whichever process starts next). A typed turn's human
// origin is kept regardless of the variable. The variable's only other effect
// in the CLI is to switch off an oversized-attachment diagnostic event.
function claudeHostEnv() {
  return {
    CLAUDE_AGENT_SDK_CLIENT_APP: clientAppId(),
    CLAUDE_CODE_HOST_SCHEDULED_RUN: "1",
  };
}

// The complete environment for a Claude process: the process's own, then the
// Settings overlay, then the console's additions. The SDK replaces the CLI's
// environment with options.env, so this is always the whole environment.
//
// `identity` exists only when an identity provider is configured:
// { dir: <delivery directory> | null }. A directory is delivered as
// CLAGENTIC_IDENTITY_DIR; none (the provider could not supply one) removes the
// variable, so a session never carries an identity the console did not just
// issue for it. Without `identity` the environment is untouched.
function claudeProcessEnv(base, overlay, identity) {
  var env = Object.assign(runtimeEnv.composeRuntimeEnv(base, overlay), claudeHostEnv());
  if (identity && typeof identity === "object") {
    if (typeof identity.dir === "string" && identity.dir) env[IDENTITY_DIR_ENV] = identity.dir;
    else delete env[IDENTITY_DIR_ENV];
  }
  return env;
}

// A streamed Claude user message for a turn, with its provenance stamped.
function stampClaudeUserMessage(message, initiator) {
  var origin = claudeOrigin(initiator);
  if (origin) message.origin = origin;
  if (isClientComposed(initiator)) message.client_composed = true;
  return message;
}

module.exports = {
  INITIATORS: INITIATORS,
  isInitiator: isInitiator,
  claudeOrigin: claudeOrigin,
  isClientComposed: isClientComposed,
  clientAppId: clientAppId,
  claudeHostEnv: claudeHostEnv,
  claudeProcessEnv: claudeProcessEnv,
  stampClaudeUserMessage: stampClaudeUserMessage,
};

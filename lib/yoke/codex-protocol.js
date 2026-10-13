"use strict";

// codex-protocol.js - what the Codex app-server protocol allows at the version
// that is actually running. The console drives the Codex the user installed, so
// a wire field or config key that exists only from some version on is sent only
// when the running version has it. Every decision is a lookup in the table
// below by version; nothing here or in a caller branches on an agent's name.
//
// The minimums come from a protocol comparison across Codex releases that was
// made from the project's published sources, not from running those releases;
// each one is checked against the installed Codex after it is merged.

var versions = require("./codex-version");
var turnInitiator = require("../turn-initiator");

var FEATURE_MINIMUMS = Object.freeze({
  // Untrusted projects supply no project AGENTS.md from this version on.
  projectTrustGate: "0.150.0",
  // turn/start accepts a free-text turnTrigger.
  turnTrigger: "0.151.0",
  // The plan tool is off unless tools.update_plan.enabled is set.
  updatePlanTool: "0.152.0",
});

/**
 * The protocol features a running Codex has. An unreadable or missing version
 * is taken to be the oldest supported one, never a newer one.
 * @param {?(string|object)} version
 * @returns {{projectTrustGate: boolean, turnTrigger: boolean, updatePlanTool: boolean}}
 */
function protocolFeatures(version) {
  var v = versions.parseVersion(typeof version === "string" ? version : "") ||
    (version && typeof version === "object" ? version : null) ||
    versions.parseVersion(versions.MIN_CODEX_VERSION);
  var out = {};
  Object.keys(FEATURE_MINIMUMS).forEach(function (name) {
    out[name] = versions.atLeast(v, FEATURE_MINIMUMS[name]);
  });
  return out;
}

// Codex classifies a turn as automated only for this value; any other string,
// or none, is a user turn.
var AUTOMATED_TURN_TRIGGER = "automation_heartbeat_scheduled";

/**
 * The turnTrigger for a turn. A typed turn, and a turn that names no initiator,
 * carry none. Every other initiator is automated; Codex has no finer
 * distinction, so which kind of automation it was is not carried.
 * @param {?string} initiator  a turn-initiator.js INITIATORS value
 * @returns {?string}
 */
function turnTriggerFor(initiator) {
  if (!turnInitiator.isInitiator(initiator)) return null;
  if (initiator === turnInitiator.INITIATORS.HUMAN) return null;
  return AUTOMATED_TURN_TRIGGER;
}

var DEFAULT_APPROVAL_POLICY = "on-request";
var APPROVAL_POLICIES = ["untrusted", "on-request", "never"];

/**
 * An approval policy value the running app-server accepts. "on-failure" is an
 * alias of "on-request" in current releases and is not a variant of its own, so
 * it is sent as the value it means; a value nobody recognizes asks rather than
 * running unattended.
 * @param {*} value
 * @returns {string}
 */
function normalizeApprovalPolicy(value) {
  if (value === "on-failure") return DEFAULT_APPROVAL_POLICY;
  return APPROVAL_POLICIES.indexOf(value) !== -1 ? value : DEFAULT_APPROVAL_POLICY;
}

/**
 * The --config overrides the running version needs for the console's features.
 * @param {object} features  protocolFeatures()
 * @param {{projectDir: ?string, trustProject: boolean}} options
 *   trustProject: mark the project the user opened in the console as trusted, so
 *   Codex keeps reading the project's AGENTS.md (see architecture.md)
 * @returns {object} nested config, flattened by the app-server client
 */
function sessionConfig(features, options) {
  var config = {};
  if (features.updatePlanTool) config.tools = { update_plan: { enabled: true } };
  if (features.projectTrustGate && options && options.trustProject && options.projectDir) {
    var projects = {};
    projects[options.projectDir] = { trust_level: "trusted" };
    config.projects = projects;
  }
  return config;
}

module.exports = {
  FEATURE_MINIMUMS: FEATURE_MINIMUMS,
  AUTOMATED_TURN_TRIGGER: AUTOMATED_TURN_TRIGGER,
  DEFAULT_APPROVAL_POLICY: DEFAULT_APPROVAL_POLICY,
  protocolFeatures: protocolFeatures,
  turnTriggerFor: turnTriggerFor,
  normalizeApprovalPolicy: normalizeApprovalPolicy,
  sessionConfig: sessionConfig,
};

// lib/cli/compact-output.js
//
// The compact form of what the listing verbs print: list-sessions, list-outbound
// and schedule-input list. A caller reads a compact row by default and the full
// record with --verbose, so no pipe or filter is needed to cut a long history
// down. Pure: each function takes the daemon's result and returns a new one.
// Only a "listed" result is projected; a refusal or error passes through whole.

var SESSION_ROW = ["consoleSessionId", "sessionId", "project", "label", "name", "state", "lastActivity", "pendingPrompts"];
var OUTBOUND_ROW = ["ts", "kind", "result", "reason", "initiator", "prompt", "promptWithheld"];
var OUTBOUND_TARGET = ["project", "sessionId", "agent", "name", "address"];
var SCHEDULED_ROW = ["id", "project", "sessionId", "kind", "state", "preview", "nextAt", "every", "firedCount"];

// The listed keys of obj that it holds, in that order.
function pick(obj, keys) {
  var out = {};
  keys.forEach(function (k) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  });
  return out;
}

function isListed(res) {
  return !!res && res.ok === true && res.result === "listed";
}

function compactSessions(res) {
  if (!isListed(res) || !Array.isArray(res.sessions)) return res;
  var out = Object.assign({}, res);
  out.sessions = res.sessions.map(function (s) { return pick(s, SESSION_ROW); });
  return out;
}

function compactOutboundMessage(m) {
  var row = pick(m, OUTBOUND_ROW);
  row.target = pick(m && m.target, OUTBOUND_TARGET);
  return row;
}

// The calls whose sender only named itself are counted (unattributedCount) and
// listed with --verbose.
function compactOutbound(res) {
  if (!isListed(res)) return res;
  var out = {};
  ["ok", "result", "session", "count", "unattributedCount", "note"].forEach(function (k) {
    if (Object.prototype.hasOwnProperty.call(res, k)) out[k] = res[k];
  });
  out.messages = (res.messages || []).map(compactOutboundMessage);
  return out;
}

// A project whose list cannot be saved (store, storeErrors) is kept: it says
// nothing of that project is delivered.
function compactScheduled(res) {
  if (!isListed(res) || !Array.isArray(res.inputs)) return res;
  var out = Object.assign({}, res);
  out.inputs = res.inputs.map(function (r) { return pick(r, SCHEDULED_ROW); });
  return out;
}

module.exports = {
  compactSessions: compactSessions,
  compactOutbound: compactOutbound,
  compactScheduled: compactScheduled,
  SESSION_ROW: SESSION_ROW,
  OUTBOUND_ROW: OUTBOUND_ROW,
  OUTBOUND_TARGET: OUTBOUND_TARGET,
  SCHEDULED_ROW: SCHEDULED_ROW,
};

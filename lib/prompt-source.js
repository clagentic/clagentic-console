"use strict";

// Who or what settled a prompt. The prompt registry (lib/prompt-registry.js)
// logs a source for every prompt it settles and records the one for an answer
// in the session history (the prompt_resolved event), so "who allowed this"
// can be answered after the fact.
//
//   { kind: "ws", clientId, user }      an answer from a browser connection
//   { kind: "push", action, user }      an answer from a push notification
//
// A prompt that ends without an answer carries a cancel source instead: one
// string from a stable vocabulary, recorded on the prompt_cancel event, in the
// journal line and in the replayed promptState.
//
//   user            the operator ended it (a rewind, a context clear)
//   timeout         the prompt's own timer ran out
//   session_end     the scope that owned it ended (turn, query, session abort
//                   or close, session deletion)
//   daemon_restart  the daemon is going away
//   worker          the worker or app-server process stopped waiting for it
//   caller:<name>   an outside caller ended it; <name> is the caller's own
//                   string (1-64 of A-Z a-z 0-9 . _ @ / + -), never interpreted
//   unspecified     the fallback for a cancel that named no valid source (it is
//                   logged as a warning); also what a replay reports for an
//                   ending recorded before cancels carried a source
//
// clientId is a per-connection label made here, not a credential; user is the
// authenticated user's id, or null in single-user mode. Prompt content never
// appears in a source.

var crypto = require("crypto");
var { logField } = require("./log-field");

function clientIdOf(ws) {
  if (!ws) return null;
  if (!ws._clagenticClientId) ws._clagenticClientId = "c-" + crypto.randomBytes(4).toString("hex");
  return ws._clagenticClientId;
}

function userIdOf(user) {
  return user && user.id !== undefined && user.id !== null ? String(user.id) : null;
}

function fromWs(ws) {
  return { kind: "ws", clientId: clientIdOf(ws), user: userIdOf(ws && ws._clagenticUser) };
}

// req is the HTTP request the answer arrived on.
function fromPush(req, action) {
  return { kind: "push", action: action, user: userIdOf(req && req._clagenticUser) };
}

var CANCEL = Object.freeze({
  USER: "user",
  TIMEOUT: "timeout",
  SESSION_END: "session_end",
  DAEMON_RESTART: "daemon_restart",
  WORKER: "worker",
  UNSPECIFIED: "unspecified",
});

var FIXED_CANCEL_SOURCES = Object.keys(CANCEL).map(function (k) { return CANCEL[k]; });
var CALLER_SOURCE = /^caller:[A-Za-z0-9._@\/+-]{1,64}$/;

function isCancelSource(value) {
  return typeof value === "string" && (FIXED_CANCEL_SOURCES.indexOf(value) !== -1 || CALLER_SOURCE.test(value));
}

// The one rule for a cancel's source: a value from the vocabulary is kept; a
// missing or unknown one becomes "unspecified" and is warned about, so a
// settle always carries a source and never an undefined one.
function cancelSource(value, reason) {
  if (isCancelSource(value)) return value;
  console.warn("[prompt-source] cancel (reason=" + logField(reason) + ") named "
    + (value === undefined || value === null ? "no source" : "an unknown source " + logField(value))
    + "; recorded as " + CANCEL.UNSPECIFIED);
  return CANCEL.UNSPECIFIED;
}

// The source as log fields, "source=ws client=c-1a2b user=u1". A cancel's
// reason is its own field on the settle line, not repeated here.
function describe(source) {
  if (!source) return "source=unspecified";
  if (typeof source === "string") return "source=" + logField(source);
  var out = "source=" + logField(source.kind);
  if (source.clientId) out += " client=" + logField(source.clientId);
  if (source.action) out += " action=" + logField(source.action);
  if (source.kind === "ws" || source.kind === "push") out += " user=" + logField(source.user);
  return out;
}

module.exports = {
  fromWs: fromWs,
  fromPush: fromPush,
  CANCEL: CANCEL,
  isCancelSource: isCancelSource,
  cancelSource: cancelSource,
  describe: describe,
  clientIdOf: clientIdOf,
};

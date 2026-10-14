"use strict";

// Who or what settled a prompt. The prompt registry (lib/prompt-registry.js)
// logs a source for every prompt it settles and records the one for an answer
// in the session history (the prompt_resolved event), so "who allowed this"
// can be answered after the fact.
//
//   { kind: "ws", clientId, user }      an answer from a browser connection
//   { kind: "push", action, user }      an answer from a push notification
//   { kind: "timeout" }                 the prompt's own timer ran out
//   { kind: "cancel", reason }          the scope that owned the prompt ended
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

function fromTimeout() {
  return { kind: "timeout" };
}

function fromCancel(reason) {
  return { kind: "cancel", reason: reason };
}

// The source as log fields, "source=ws client=c-1a2b user=u1". A cancel's
// reason is its own field on the settle line, not repeated here.
function describe(source) {
  if (!source) return "source=unspecified";
  var out = "source=" + logField(source.kind);
  if (source.clientId) out += " client=" + logField(source.clientId);
  if (source.action) out += " action=" + logField(source.action);
  if (source.kind === "ws" || source.kind === "push") out += " user=" + logField(source.user);
  return out;
}

module.exports = {
  fromWs: fromWs,
  fromPush: fromPush,
  fromTimeout: fromTimeout,
  fromCancel: fromCancel,
  describe: describe,
  clientIdOf: clientIdOf,
};

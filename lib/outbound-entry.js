// outbound-entry.js - builds one outbound-ledger entry (lib/outbound-ledger.js)
// from what session-input.js knows at the moment a request is answered.
//
// Pure: no clock, no I/O. The sender fields are the ones senderFields() in
// injected-sender.js produced for the history entry, so the ledger and the
// target's history can never name different senders.

var { SENDER_KIND } = require("./injected-sender");

var VERB = Object.freeze({ SEND_INPUT: "send_input", OPEN_SESSION: "open_session" });

// target.runsAs for a session that runs as the daemon's own OS user; any other
// value is the name of the OS user it runs as.
var RUNS_AS_DAEMON = "daemon";

function put(obj, key, value) {
  if (value !== undefined && value !== null && value !== "") obj[key] = value;
}

// How far the sender can be trusted. "extracted" is derived from the console's
// own records for a process it started; a same-user process can copy that
// reference. Anything else is whatever the caller said about itself.
function attributionOf(senderKind) {
  return senderKind === SENDER_KIND.EXTRACTED ? "extracted" : "unverified";
}

function senderOf(fields) {
  var s = { kind: fields.senderKind || SENDER_KIND.UNDECLARED, attribution: attributionOf(fields.senderKind) };
  put(s, "name", fields.fromName);
  put(s, "project", fields.senderProject);
  put(s, "sessionId", fields.senderSessionId);
  put(s, "cliSessionId", fields.senderCliSessionId);
  put(s, "agent", fields.senderAgent);
  put(s, "vendor", fields.senderVendor);
  put(s, "declaredName", fields.declaredName);
  // Self-reported on a declared sender; the console's own record on an extracted one.
  put(s, "fromSession", fields.fromSession);
  return s;
}

// args:
//   verb         VERB.*
//   ts           ISO time of the request's outcome
//   req          the request as the caller gave it
//   out          the result (absent for a delivery, recorded before it is built)
//   initiator    the resolved initiator, or null when it was refused
//   messageId    set for a delivery
//   sender       senderFields() output
//   target       { project, consoleSessionId, sessionId, agent, vendor, name, runsAs } of the
//                session that took (or was meant to take) the prompt
function buildEntry(args) {
  var req = args.req || {};
  var out = args.out || {};
  var entry = {
    formatVersion: 1,
    ts: args.ts,
    verb: args.verb,
    result: out.result || (args.verb === VERB.OPEN_SESSION ? "opened" : "delivered"),
  };
  put(entry, "reason", out.reason);
  if (out.retryable === true) entry.retryable = true;
  put(entry, "messageId", args.messageId);
  put(entry, "initiator", args.initiator);
  put(entry, "contextNote", typeof req.contextNote === "string" ? req.contextNote : undefined);
  entry.sender = senderOf(args.sender || {});

  var t = args.target || {};
  var target = {};
  put(target, "project", t.project || req.projectSlug);
  put(target, "sessionId", t.consoleSessionId);
  put(target, "cliSessionId", t.sessionId);
  put(target, "agent", t.agent);
  put(target, "vendor", t.vendor);
  put(target, "name", t.name);
  // Recorded at write time: a console id is renumbered by a restart, so the
  // reader cannot work out later which OS user the target ran as.
  put(target, "runsAs", t.runsAs);
  // What the caller asked for, kept when it differs from what it resolved to.
  put(target, "address", typeof req.to === "string" ? req.to : undefined);
  put(target, "requestedSessionId", typeof req.sessionId === "string" ? req.sessionId : undefined);
  if (req.reply) target.reply = true;
  entry.target = target;

  // Only a prompt the request actually carried; a refusal for a missing prompt has none.
  if (typeof req.prompt === "string" && req.prompt) entry.prompt = req.prompt;
  return entry;
}

module.exports = { VERB: VERB, RUNS_AS_DAEMON: RUNS_AS_DAEMON, buildEntry: buildEntry };

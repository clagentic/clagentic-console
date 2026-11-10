// outbound-entry.js - builds one outbound-ledger entry (lib/outbound-ledger.js)
// from what session-input.js knows at the moment a request is answered.
//
// Pure: no clock, no I/O. The sender fields are the ones senderFields() in
// injected-sender.js produced for the history entry, so the ledger and the
// target's history can never name different senders.

var { SENDER_KIND } = require("./injected-sender");

var VERB = Object.freeze({ SEND_INPUT: "send_input", OPEN_SESSION: "open_session", END_SESSION: "end_session", ANSWER_PROMPT: "answer_prompt" });

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

// Why message text is not stored for a target, or null when it is stored. An
// absent runsAs is treated as another OS user: it cannot be shown to be the daemon's.
function withholdReasonFor(runsAs) {
  if (runsAs === RUNS_AS_DAEMON) return null;
  if (typeof runsAs === "string" && runsAs) return "the target session runs as another OS user";
  return "the OS user the target session runs as was not recorded, so it cannot be established";
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
  // An answer-prompt names the request and its kind, never the decision, which
  // can be the text of an answer.
  if (args.verb === VERB.ANSWER_PROMPT) {
    put(entry, "requestId", out.requestId);
    put(entry, "promptKind", out.kind);
  }
  if (out.retryable === true) entry.retryable = true;
  if (Array.isArray(out.failures) && out.failures.length) entry.failures = out.failures;
  put(entry, "messageId", args.messageId);
  put(entry, "initiator", args.initiator);
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

  // Message text (the prompt and the context note) is stored only for a target
  // known to run as the daemon's OS user. For any other target, or one whose OS
  // user was not recorded, it is never written: the access decision is made here,
  // at write time, so no read path and no later mode can return it.
  var withholdReason = withholdReasonFor(t.runsAs);
  var hasPrompt = typeof req.prompt === "string" && req.prompt;
  var hasNote = typeof req.contextNote === "string" && req.contextNote;
  if (withholdReason) {
    if (hasPrompt) entry.promptWithheld = true;
    if (hasNote) entry.contextNoteWithheld = true;
    if (hasPrompt || hasNote) entry.promptWithheldReason = withholdReason;
  } else {
    if (hasNote) entry.contextNote = req.contextNote;
    if (hasPrompt) entry.prompt = req.prompt;
  }
  return entry;
}

module.exports = { VERB: VERB, RUNS_AS_DAEMON: RUNS_AS_DAEMON, buildEntry: buildEntry };

// turn-origin.js - how each turn a session was handed was started, kept so a
// hook that runs inside the session can ask.
//
// The vendor CLI reports a console turn to its hooks as an SDK turn whoever
// started it, because every console turn enters through the SDK. The console
// knows better: each turn carries its initiator (lib/turn-initiator.js). This
// module keeps, per session, the initiator of the turns it delivered and
// answers "who started the turn with this prompt text" in the vendor's own
// hook-source words.
//
// The record is read-only from outside: only the delivery code (lib/sdk-bridge.js)
// writes it, there is no IPC command or CLI flag that does, and a lookup never
// changes a turn. It is held in memory only: a daemon restart forgets it, and
// an earlier turn then answers "unknown".
//
// Bound: the newest MAX_TURNS_PER_SESSION turns of a session. A turn's text is
// kept as a SHA-256 digest, not as text, so a long prompt costs the same as a
// short one. The record is released with the session (release()), and is keyed
// by the session object so a session that is dropped takes it along.

var crypto = require("crypto");
var turnInitiator = require("./turn-initiator");

var MAX_TURNS_PER_SESSION = 64;

var INITIATORS = turnInitiator.INITIATORS;

// The answers, in the vendor's hook-source vocabulary (UserPromptSubmit `source`).
var ORIGIN = Object.freeze({
  USER: "user",
  SCHEDULE_WAKEUP: "schedule_wakeup",
  LOOP_WAKEUP: "loop_wakeup",
  SYSTEM: "system",
  UNKNOWN: "unknown",
});

// A turn with no initiator, or one this table does not know, is unknown.
function originFor(initiator) {
  switch (initiator) {
    case INITIATORS.HUMAN: return ORIGIN.USER;
    case INITIATORS.SCHEDULED:
    case INITIATORS.SCHEDULED_NOW: return ORIGIN.SCHEDULE_WAKEUP;
    case INITIATORS.LOOP: return ORIGIN.LOOP_WAKEUP;
    case INITIATORS.TRIGGER: return ORIGIN.SYSTEM;
    default: return ORIGIN.UNKNOWN;
  }
}

function digest(text) {
  return crypto.createHash("sha256").update(String(text).trim()).digest("hex");
}

var records = new WeakMap();

// Notes one turn handed to the agent. Never throws: a failure here must not
// stop the turn, so it is logged and dropped.
function record(session, turn) {
  try {
    if (!session || typeof session !== "object" || !turn || typeof turn.text !== "string") return;
    var turns = records.get(session);
    if (!turns) {
      turns = [];
      records.set(session, turns);
    }
    turns.push({
      digest: digest(turn.text),
      initiator: typeof turn.initiator === "string" ? turn.initiator : null,
      messageId: typeof turn.messageId === "string" ? turn.messageId : null,
      at: Date.now(),
    });
    if (turns.length > MAX_TURNS_PER_SESSION) turns.splice(0, turns.length - MAX_TURNS_PER_SESSION);
  } catch (err) {
    console.error("[turn-origin] could not record a turn:", err && err.message ? err.message : String(err));
  }
}

// Drops a session's record (the session was deleted).
function release(session) {
  if (session && typeof session === "object") records.delete(session);
}

// How many turns are held for a session.
function sizeOf(session) {
  var turns = session && typeof session === "object" ? records.get(session) : null;
  return turns ? turns.length : 0;
}

// The origin of the most recent turn of this session whose text is `prompt`.
function lookup(session, prompt) {
  if (typeof prompt !== "string" || !session || typeof session !== "object") return ORIGIN.UNKNOWN;
  var turns = records.get(session);
  if (!turns) return ORIGIN.UNKNOWN;
  var wanted = digest(prompt);
  for (var i = turns.length - 1; i >= 0; i--) {
    if (turns[i].digest === wanted) return originFor(turns[i].initiator);
  }
  return ORIGIN.UNKNOWN;
}

function findInProject(project, predicate) {
  if (!project || !project.sm || !project.sm.sessions) return null;
  var found = null;
  project.sm.sessions.forEach(function (s) {
    if (!found && predicate(s)) found = s;
  });
  return found;
}

// The session a request names: the console reference (project + console id)
// when it is given, else the vendor session id. null when the console does not
// host it. deps: getProject(slug) -> project | null, forEachProject(fn(project)).
function findSession(deps, req) {
  if (req.project !== undefined || req.sessionId !== undefined) {
    if (typeof req.project !== "string" || !req.project) return null;
    var id = typeof req.sessionId === "number" ? String(req.sessionId) : req.sessionId;
    if (typeof id !== "string" || !id) return null;
    return findInProject(deps.getProject(req.project), function (s) { return String(s.localId) === id; });
  }
  if (typeof req.cliSessionId !== "string" || !req.cliSessionId) return null;
  var cliId = req.cliSessionId;
  var hit = null;
  deps.forEachProject(function (project) {
    if (hit) return;
    hit = findInProject(project, function (s) { return s.cliSessionId === cliId; });
  });
  return hit;
}

// The daemon's answer to a lookup. req: { project, sessionId } (the console's
// reference) or { cliSessionId }, plus { prompt }. Always an answer: a session
// the console does not host, or a prompt it holds no turn for, is "unknown".
function answer(deps, req) {
  req = req || {};
  var session = findSession(deps, req);
  return { ok: true, result: "answered", origin: session ? lookup(session, req.prompt) : ORIGIN.UNKNOWN };
}

module.exports = {
  MAX_TURNS_PER_SESSION: MAX_TURNS_PER_SESSION,
  ORIGIN: ORIGIN,
  originFor: originFor,
  record: record,
  release: release,
  sizeOf: sizeOf,
  lookup: lookup,
  findSession: findSession,
  answer: answer,
};

// records.js - the shape of a scheduled input, the rules that change it, and
// which session it names. Pure: nothing here reads a clock or a file.
//
// One record type for both kinds:
//   once       fires one time, at `at`
//   recurring  fires every `every` ms, and always has an end: `until` (an
//              absolute time) or `count` (a number of firings)
//
// A record is armed until it ends:
//   done   it ran its course (the once fired, or the until/count was reached)
//   ended  its session was closed or deleted before that
// Cancelling a record deletes it.

var crypto = require("crypto");

var KIND = Object.freeze({ ONCE: "once", RECURRING: "recurring" });
var STATE = Object.freeze({ ARMED: "armed", DONE: "done", ENDED: "ended" });

// How a record names its session. A session that has not run a turn yet has no
// vendor session id, only the console's own id, which is not stable across a
// daemon restart; such a record is upgraded once the id exists (see service.js).
var ID_KIND = Object.freeze({ VENDOR: "vendor", CONSOLE: "console" });

var LIMITS = Object.freeze({
  MIN_EVERY_MS: 60 * 1000,
  MAX_EVERY_MS: 24 * 60 * 60 * 1000,
  MAX_ARMED_PER_SESSION: 5,
  MAX_AHEAD_MS: 366 * 24 * 60 * 60 * 1000,
  MAX_COUNT: 1000,
  MAX_TEXT_CHARS: 50000,
  MAX_NOTE_CHARS: 200,
});

function isFiniteNumber(value) {
  return typeof value === "number" && isFinite(value);
}

function newId() {
  return "si_" + crypto.randomBytes(5).toString("hex");
}

function minutesText(ms) {
  return Math.round(ms / 60000) + " min";
}

// spec: { sessionId, sessionIdKind, kind, text, note?, createdBy, at?, every?,
//         until?, count? }
// ctx:  { now, armedForSession, exemptFromCap? }
// Returns { record } or { error }.
function buildRecord(spec, ctx) {
  var now = ctx.now;
  if (spec.kind !== KIND.ONCE && spec.kind !== KIND.RECURRING) {
    return { error: "kind must be " + KIND.ONCE + " or " + KIND.RECURRING };
  }
  if (typeof spec.sessionId !== "string" || !spec.sessionId) return { error: "a session id is required" };
  if (typeof spec.text !== "string" || !spec.text.trim()) return { error: "the text to send must not be empty" };
  if (spec.text.length > LIMITS.MAX_TEXT_CHARS) return { error: "the text is longer than " + LIMITS.MAX_TEXT_CHARS + " characters" };
  var note = typeof spec.note === "string" ? spec.note.slice(0, LIMITS.MAX_NOTE_CHARS) : "";
  if (!ctx.exemptFromCap && ctx.armedForSession >= LIMITS.MAX_ARMED_PER_SESSION) {
    return { error: "this session already has " + LIMITS.MAX_ARMED_PER_SESSION + " armed scheduled inputs (the limit); cancel one first" };
  }

  var record = {
    id: newId(),
    sessionId: spec.sessionId,
    sessionIdKind: spec.sessionIdKind === ID_KIND.CONSOLE ? ID_KIND.CONSOLE : ID_KIND.VENDOR,
    kind: spec.kind,
    text: spec.text,
    note: note,
    createdBy: typeof spec.createdBy === "string" && spec.createdBy ? spec.createdBy.slice(0, 120) : "unknown",
    createdAt: now,
    nextAt: null,
    lastFiredAt: null,
    lastOutcome: null,
    firedCount: 0,
    failures: 0,
    state: STATE.ARMED,
    endedAt: null,
    endReason: null,
  };

  if (spec.kind === KIND.ONCE) {
    if (!isFiniteNumber(spec.at)) return { error: "a once input needs the time to send at" };
    if (spec.at - now > LIMITS.MAX_AHEAD_MS) return { error: "a scheduled input can be at most 366 days ahead" };
    if (spec.every !== undefined || spec.until !== undefined || spec.count !== undefined) {
      return { error: "every, until and count belong to a recurring input" };
    }
    record.at = spec.at;
    // A time that is already past fires on the next check rather than being lost.
    record.nextAt = Math.max(spec.at, now);
    return { record: record };
  }

  if (!isFiniteNumber(spec.every) || spec.every < LIMITS.MIN_EVERY_MS || spec.every > LIMITS.MAX_EVERY_MS) {
    return { error: "every must be between 1 minute and 24 hours" };
  }
  var hasUntil = spec.until !== undefined && spec.until !== null;
  var hasCount = spec.count !== undefined && spec.count !== null;
  if (hasUntil === hasCount) {
    return { error: "a recurring input needs an end: give exactly one of until (a time) or count (a number of times)" };
  }
  record.every = spec.every;
  record.nextAt = now + spec.every;
  record.until = null;
  record.count = null;
  if (hasUntil) {
    if (!isFiniteNumber(spec.until)) return { error: "until must be a time" };
    if (spec.until < record.nextAt) {
      return { error: "until is before the first firing (" + minutesText(spec.every) + " from now); nothing would be sent" };
    }
    if (spec.until - now > LIMITS.MAX_AHEAD_MS) return { error: "until can be at most 366 days ahead" };
    record.until = spec.until;
  } else {
    if (!Number.isInteger(spec.count) || spec.count < 1 || spec.count > LIMITS.MAX_COUNT) {
      return { error: "count must be a whole number from 1 to " + LIMITS.MAX_COUNT };
    }
    record.count = spec.count;
  }
  return { record: record };
}

function finish(record, state, reason, now) {
  record.state = state;
  record.endReason = reason;
  record.endedAt = now;
  record.nextAt = null;
  return record;
}

// The input was delivered to its session at `now`. The next firing of a
// recurring input is the delivery time plus `every`, so a late or skipped
// firing is never made up.
function afterDelivery(record, now, outcome) {
  record.lastFiredAt = now;
  record.lastOutcome = outcome;
  record.firedCount += 1;
  record.failures = 0;
  if (record.kind === KIND.ONCE) return finish(record, STATE.DONE, "sent", now);
  if (record.count !== null && record.firedCount >= record.count) {
    return finish(record, STATE.DONE, "reached " + record.count + " times", now);
  }
  record.nextAt = now + record.every;
  if (record.until !== null && record.nextAt > record.until) {
    return finish(record, STATE.DONE, "reached its end time", now);
  }
  return record;
}

// A recurring record whose end time passed while it waited (a daemon that was
// down, a session that was busy) is done without a late firing.
function pastItsEnd(record, now) {
  return record.kind === KIND.RECURRING && record.until !== null && now > record.until;
}

function endReached(record, now) {
  return finish(record, STATE.DONE, "reached its end time", now);
}

function sessionGone(record, now, reason) {
  return finish(record, STATE.ENDED, reason, now);
}

function isArmed(record) {
  return record.state === STATE.ARMED;
}

// --- Which session a record names ---
//
// A record is bound to one session and never moves. The stable name is the
// session's vendor session id (cliSessionId): it is what the console's store
// and send-input use, and it survives a daemon restart. The console's own id
// (localId) is a per-project counter that restarts at 1, so it can only name a
// session that has not run a turn yet (and so has no vendor id); service.js
// upgrades such a record as soon as the id exists.

// { sessionId, sessionIdKind } for a session object.
function targetOf(session) {
  if (session.cliSessionId) return { sessionId: session.cliSessionId, sessionIdKind: ID_KIND.VENDOR };
  return { sessionId: String(session.localId), sessionIdKind: ID_KIND.CONSOLE };
}

function recordIsFor(record, session) {
  if (record.sessionIdKind === ID_KIND.VENDOR) {
    return !!session.cliSessionId && record.sessionId === session.cliSessionId;
  }
  return record.sessionId === String(session.localId);
}

function sameTarget(record, target) {
  return record.sessionId === target.sessionId && record.sessionIdKind === target.sessionIdKind;
}

// The session in memory a record names, or null.
function liveSessionOf(sm, record) {
  var found = null;
  sm.sessions.forEach(function (s) {
    if (!found && recordIsFor(record, s)) found = s;
  });
  return found;
}

// The session in memory an id names: the vendor session id or the console id,
// as send-input accepts either. Null when none is held.
function liveSessionById(sm, id) {
  var byVendor = null;
  var byConsole = null;
  sm.sessions.forEach(function (s) {
    if (!byVendor && s.cliSessionId === id) byVendor = s;
    if (!byConsole && String(s.localId) === id) byConsole = s;
  });
  return byVendor || byConsole;
}

// The fields a client or the CLI needs, without the text of a long prompt.
var PREVIEW_CHARS = 80;
function summarize(record) {
  var text = record.text;
  return {
    id: record.id,
    sessionId: record.sessionId,
    kind: record.kind,
    state: record.state,
    preview: text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + "..." : text,
    createdBy: record.createdBy,
    at: record.at === undefined ? null : record.at,
    nextAt: record.nextAt,
    every: record.every === undefined ? null : record.every,
    until: record.until === undefined ? null : record.until,
    count: record.count === undefined ? null : record.count,
    firedCount: record.firedCount,
    lastFiredAt: record.lastFiredAt,
    lastOutcome: record.lastOutcome,
    endReason: record.endReason,
  };
}

module.exports = {
  KIND: KIND,
  STATE: STATE,
  ID_KIND: ID_KIND,
  LIMITS: LIMITS,
  buildRecord: buildRecord,
  afterDelivery: afterDelivery,
  pastItsEnd: pastItsEnd,
  endReached: endReached,
  sessionGone: sessionGone,
  isArmed: isArmed,
  summarize: summarize,
  targetOf: targetOf,
  recordIsFor: recordIsFor,
  sameTarget: sameTarget,
  liveSessionOf: liveSessionOf,
  liveSessionById: liveSessionById,
};

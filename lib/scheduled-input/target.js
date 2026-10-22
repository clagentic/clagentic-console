// target.js - how a scheduled input names its session, and how a record is
// matched to a session object. Pure.
//
// A record is bound to one session and never moves. The stable name is the
// session's vendor session id (cliSessionId): it is what the console's store
// and send-input use, and it survives a daemon restart. The console's own id
// (localId) is a per-project counter that restarts at 1, so it can only name a
// session that has not run a turn yet (and so has no vendor id); service.js
// upgrades such a record as soon as the id exists.

var { ID_KIND } = require("./records");

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

module.exports = {
  targetOf: targetOf,
  recordIsFor: recordIsFor,
  sameTarget: sameTarget,
  liveSessionOf: liveSessionOf,
  liveSessionById: liveSessionById,
};

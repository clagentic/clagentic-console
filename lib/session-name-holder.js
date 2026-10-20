// session-name-holder.js - the one collision rule for a session name. A name
// has at most one holder in a project. A claim is refused while a non-reaped
// session (live, see sender-ref.isLive) holds it, and otherwise takes it from
// every reaped holder; a reaped session coming back yields to a current holder.
// Every path that gives a session a name asks here.

var senderRef = require("./sender-ref");

// The session of `sessions` (a Map or anything with forEach) that holds `name`,
// or null. A hidden session and the session `exceptLocalId` never hold it.
function findNameHolder(sessions, name, exceptLocalId) {
  var holder = null;
  sessions.forEach(function (s) {
    if (holder || s.hidden || s.localId === exceptLocalId) return;
    if (s.sessionName === name && (senderRef.isLive(s) || s._nameReserved)) holder = s;
  });
  return holder;
}

// A name has at most one holder in a project. A claim of `name` (the caller has
// already refused it when findNameHolder finds a non-reaped holder) takes it
// from every reaped session that still carries it: the name is cleared and the
// clear logged, and `persist(session)` is called so the stored meta follows.
// Returns the sessions it cleared.
function releaseReapedHolders(sessions, name, persist) {
  var cleared = [];
  sessions.forEach(function (s) {
    if (s.sessionName !== name || senderRef.isLive(s) || s._nameReserved) return;
    s.sessionName = null;
    console.warn("[sessions] session " + s.localId + " is reaped: name " + JSON.stringify(name) +
      " moved to a newly opened session");
    cleared.push(s);
  });
  if (typeof persist === "function") cleared.forEach(persist);
  return cleared;
}

// A reaped session gets a runtime again (a turn is about to start on it). If it
// holds a name that another non-reaped session now holds, it comes back
// unnamed: the name is cleared and the clear logged; the holder keeps the name.
// Returns the holder it yielded to, or null when nothing changed. The caller
// persists the session.
function yieldNameOnRevival(sessions, session) {
  if (!session.sessionName) return null;
  var holder = findNameHolder(sessions, session.sessionName, session.localId);
  if (!holder) return null;
  console.warn("[sessions] session " + session.localId + " restarted: name " + JSON.stringify(session.sessionName) +
    " is held by session " + holder.localId + "; continuing unnamed");
  session.sessionName = null;
  return holder;
}

// Revival in one synchronous step: the collision check and the mark that the
// session holds its name happen together, before any await, so a second
// same-named revival in the same tick finds the first as a holder. Returns
// { holder, release }. `holder` is who the session yielded to (or null);
// `release` drops the mark and is safe to call more than once. The caller calls
// it when the start ends: a session that started is held by being live, one
// that failed stays reaped and must not keep holding the name.
function reserveNameOnRevival(sessions, session) {
  var holder = yieldNameOnRevival(sessions, session);
  var owned = !!session.sessionName && !session._nameReserved;
  if (owned) session._nameReserved = true;
  return {
    holder: holder,
    release: function () {
      if (!owned) return;
      owned = false;
      session._nameReserved = false;
    },
  };
}

module.exports = {
  findNameHolder: findNameHolder,
  releaseReapedHolders: releaseReapedHolders,
  yieldNameOnRevival: yieldNameOnRevival,
  reserveNameOnRevival: reserveNameOnRevival,
};

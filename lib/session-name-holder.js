// session-name-holder.js - the one collision check for a session name. A name
// is unique among a project's sessions that are not reaped (not live, see
// sender-ref.isLive); every path that gives a session a name asks here.

var senderRef = require("./sender-ref");

// The session of `sessions` (a Map or anything with forEach) that holds `name`,
// or null. A hidden session and the session `exceptLocalId` never hold it.
function findNameHolder(sessions, name, exceptLocalId) {
  var holder = null;
  sessions.forEach(function (s) {
    if (holder || s.hidden || s.localId === exceptLocalId) return;
    if (s.sessionName === name && senderRef.isLive(s)) holder = s;
  });
  return holder;
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

module.exports = { findNameHolder: findNameHolder, yieldNameOnRevival: yieldNameOnRevival };

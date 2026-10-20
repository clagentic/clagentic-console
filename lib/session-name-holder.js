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

module.exports = { findNameHolder: findNameHolder };

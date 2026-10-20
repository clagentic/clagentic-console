// scheduled-turn.js - the turn the console starts from a scheduled message, when
// its timer fires (SCHEDULED) or when a person sends it early (SCHEDULED_NOW).
//
// The history entry and the query are made here from one initiator value, so
// the entry the chat shows and the origin the vendor is told cannot disagree.
// The turn is the console's, not the operator's, even when a person pressed the
// button: the text is the one scheduled earlier.

var { consoleTurnEntry, forClient } = require("./injected-sender");

// deps: { sm, sdk, sendToSession, onProcessingChanged, ensureProjectAccessForSession }
// Returns fire(session, scheduled, initiator) where scheduled is { text, note }.
function createScheduledTurn(deps) {
  var sm = deps.sm;

  return function fire(session, scheduled, initiator) {
    var entry = consoleTurnEntry(initiator, scheduled.text, scheduled.note);
    // Routes through the shared history-cap helper so a long-running session's
    // heap history stays bounded.
    sm.recordHistoryEntry(session, entry, true);
    sm.appendToSessionFile(session, entry);
    deps.sendToSession(session.localId, forClient(entry));
    session.isProcessing = true;
    deps.onProcessingChanged();
    deps.sendToSession(session.localId, { type: "status", status: "processing" });
    deps.sdk.startQuery(session, scheduled.text, null, deps.ensureProjectAccessForSession(session), initiator);
    sm.broadcastSessionList();
  };
}

// What the chat says an automatic "continue" after a rate limit is.
var RATE_LIMIT_RESUME_NOTE = "automatic resume after rate limit";

module.exports = { createScheduledTurn: createScheduledTurn, RATE_LIMIT_RESUME_NOTE: RATE_LIMIT_RESUME_NOTE };

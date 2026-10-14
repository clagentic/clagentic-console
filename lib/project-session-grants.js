"use strict";

// WS entry point for a session's "Allow for Session" grants: list them and
// revoke one. The grants themselves live in the prompt registry
// (lib/prompt-registry.js, session.allowedTools); this module only maps the
// wire messages onto it and applies the same access rule as answering a
// prompt (lib/prompt-access.js), because revoking is the operator's decision
// about that session and listing shows what its agent may do unasked.

var { promptsFor } = require("./prompt-registry");
var { mayAnswerPrompt } = require("./prompt-access");

/**
 * ctx fields: sm, sendTo, sendToSessionOthers, getSessionForWs
 */
function attachSessionGrants(ctx) {
  var sm = ctx.sm;
  var sendTo = ctx.sendTo;
  var sendToSessionOthers = ctx.sendToSessionOthers;
  var getSessionForWs = ctx.getSessionForWs;

  // The session a message names (the connection's own when it names none), if
  // the connection may act on it.
  function sessionFor(ws, msg) {
    var session = msg.sessionId === undefined || msg.sessionId === null
      ? getSessionForWs(ws)
      : (typeof msg.sessionId === "number" && sm.sessions ? sm.sessions.get(msg.sessionId) : null);
    if (!session || !mayAnswerPrompt(ws && ws._clagenticUser, session)) return null;
    return session;
  }

  function grantsMessage(session) {
    return { type: "session_grants", sessionId: session.localId, grants: promptsFor(sm).listGrants(session) };
  }

  /** Returns true when msg was a grants message (handled). */
  function handleGrantMessage(ws, msg) {
    if (msg.type === "list_session_grants") {
      var listed = sessionFor(ws, msg);
      if (listed) sendTo(ws, grantsMessage(listed));
      return true;
    }
    if (msg.type === "revoke_session_grant") {
      var session = sessionFor(ws, msg);
      if (!session) {
        // Said, not dropped, so the client can re-enable its Revoke button. It
        // names nothing about the session, which this user may not see.
        sendTo(ws, { type: "session_grants", sessionId: msg.sessionId, error: "that session is not available to you" });
        return true;
      }
      promptsFor(sm).revokeGrant(session, msg.key);
      // Every client viewing the session sees the list as it now is, whether
      // or not the key was still there.
      var now = grantsMessage(session);
      sendTo(ws, now);
      sendToSessionOthers(ws, session.localId, now);
      return true;
    }
    return false;
  }

  return { handleGrantMessage: handleGrantMessage };
}

module.exports = { attachSessionGrants: attachSessionGrants };

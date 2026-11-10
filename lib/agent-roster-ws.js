// agent-roster-ws.js - the browser's side of the Team view's agent roster
// (lib/agent-roster.js).
//
//   agent_roster_request     c2s  ask for the roster
//   agent_avatar_set         c2s  {key, avatar}: choose an avatar for a seen agent;
//                                 avatar is {style, seed}, {custom} or null (clear)
//   agent_roster             s2c  the roster as this connection may read it:
//                                 {agents: [{key, firstSeen, lastSeen, places,
//                                 avatar}]}, a place being {source, project,
//                                 lastSeen}. Sent on connect and on request; each
//                                 place is limited to projects the connection can
//                                 read, and an agent with none is left out.
//   agent_roster_changed     s2c  the roster changed; ask again. It carries no
//                                 content, so what a connection may read is decided
//                                 only when it asks, never by a broadcast.
//   agent_avatar_set_result  s2c  {key, ok, error?} to the client that asked

var REQUEST = "agent_roster_request";
var SET_AVATAR = "agent_avatar_set";
var ROSTER = "agent_roster";
var CHANGED = "agent_roster_changed";
var SET_RESULT = "agent_avatar_set_result";

// The caller of a socket, as lib/outbound-access.js reads it.
function callerOf(ws) {
  return { user: (ws && ws._clagenticUser) || null, authenticated: !!ws && ws._clagenticAuthenticated === true };
}

// service: { listFor(caller) } or null. A service that cannot say what a caller
// may read answers nothing rather than everything.
function rosterMessage(service, caller) {
  return { type: ROSTER, agents: service && typeof service.listFor === "function" ? service.listFor(caller) : [] };
}

// deps: { service ({ listFor(caller), setAvatar(caller, key, avatar) }, or null), sendTo(ws, obj) }
function createWsHandlers(deps) {
  var service = deps.service;

  // Answers true when the message was one of ours.
  function handle(ws, msg) {
    if (!msg) return false;
    if (msg.type === REQUEST) {
      var message;
      try {
        message = rosterMessage(service, callerOf(ws));
      } catch (e) {
        console.error("[agent-roster] reading the roster failed:", e && e.message ? e.message : e);
        message = { type: ROSTER, agents: [] };
      }
      deps.sendTo(ws, message);
      return true;
    }
    if (msg.type === SET_AVATAR) {
      var key = typeof msg.key === "string" ? msg.key : "";
      if (!service) {
        deps.sendTo(ws, { type: SET_RESULT, key: key, ok: false, error: "the agent roster is not available here" });
        return true;
      }
      var outcome;
      try {
        outcome = service.setAvatar(callerOf(ws), msg.key, msg.avatar);
      } catch (e) {
        console.error("[agent-roster] setting an avatar failed:", e && e.message ? e.message : e);
        outcome = { ok: false, error: "the avatar could not be saved" };
      }
      deps.sendTo(ws, outcome.ok ? { type: SET_RESULT, key: key, ok: true } : { type: SET_RESULT, key: key, ok: false, error: outcome.error });
      return true;
    }
    return false;
  }

  return { handle: handle };
}

module.exports = {
  createWsHandlers: createWsHandlers,
  rosterMessage: rosterMessage,
  callerOf: callerOf,
  REQUEST: REQUEST,
  SET_AVATAR: SET_AVATAR,
  ROSTER: ROSTER,
  CHANGED: CHANGED,
  SET_RESULT: SET_RESULT,
};

// agent-roster-ws.js - the browser's side of the Team view's agent roster
// (lib/agent-roster.js).
//
//   agent_roster_request     c2s  ask for the roster
//   agent_avatar_set         c2s  {key, avatar}: choose an avatar for a seen agent;
//                                 avatar is {style, seed}, {custom} or null (clear)
//   agent_roster             s2c  the roster: {agents: [{key, firstSeen, lastSeen,
//                                 places, avatar}]}. Sent on connect, on request
//                                 and to every client after a change.
//   agent_avatar_set_result  s2c  {key, ok, error?} to the client that asked

var REQUEST = "agent_roster_request";
var SET_AVATAR = "agent_avatar_set";
var ROSTER = "agent_roster";
var SET_RESULT = "agent_avatar_set_result";

function rosterMessage(service) {
  return { type: ROSTER, agents: service ? service.list() : [] };
}

// deps: { service (createAgentRoster() result, or null), sendTo(ws, obj) }
function createWsHandlers(deps) {
  var service = deps.service;

  // Answers true when the message was one of ours.
  function handle(ws, msg) {
    if (!msg) return false;
    if (msg.type === REQUEST) {
      deps.sendTo(ws, rosterMessage(service));
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
        outcome = service.setAvatar(msg.key, msg.avatar);
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
  REQUEST: REQUEST,
  SET_AVATAR: SET_AVATAR,
  ROSTER: ROSTER,
  SET_RESULT: SET_RESULT,
};

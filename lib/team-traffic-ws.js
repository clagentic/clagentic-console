// team-traffic-ws.js - the browser's side of the Team view's agent-messages
// section (lib/team-traffic.js).
//
//   team_traffic_request   c2s  ask for the traffic this connection may see
//   team_traffic           s2c  the answer: pairs, messages, pending, withheld
//   team_traffic_changed   s2c  something landed; ask again. It carries no
//                               content, so what a connection may read is
//                               decided only when it asks, never by a broadcast.

var REQUEST = "team_traffic_request";
var CHANGED = "team_traffic_changed";
var DEFAULT_DELAY_MS = 200;

// deps: { service (createTeamTraffic() result, or null), sendTo(ws, obj) }
function createWsHandlers(deps) {
  var service = deps.service;

  // Answers true when the message was one of ours.
  function handle(ws, msg) {
    if (!msg || msg.type !== REQUEST) return false;
    if (!service) {
      deps.sendTo(ws, { type: "team_traffic", ok: false, result: "error", reason: "agent messages are not available here" });
      return true;
    }
    var caller = { user: ws._clagenticUser || null, authenticated: ws._clagenticAuthenticated === true };
    var answer;
    try {
      answer = service.snapshot(caller);
    } catch (e) {
      console.error("[team-traffic] snapshot failed:", e && e.message ? e.message : e);
      answer = { ok: false, result: "error", reason: "the agent messages could not be read" };
    }
    deps.sendTo(ws, Object.assign({ type: "team_traffic" }, answer));
    return true;
  }

  return { handle: handle };
}

// A burst of entries (a sender opening several sessions) makes one broadcast.
// deps: { broadcast(msg), delayMs?, build()? }. build() makes the message to
// send; the default is the content-free nudge. The agent roster reuses this
// burst-coalescing timer and sends its own content-free agent_roster_changed
// nudge, so each connection asks for the roster it may read.
function createNotifier(deps) {
  var delay = typeof deps.delayMs === "number" ? deps.delayMs : DEFAULT_DELAY_MS;
  var build = typeof deps.build === "function" ? deps.build : function () { return { type: CHANGED }; };
  var timer = null;

  function notify() {
    if (timer) return;
    timer = setTimeout(function () {
      timer = null;
      try { deps.broadcast(build()); }
      catch (e) { console.error("[team-traffic] broadcast failed:", e && e.message ? e.message : e); }
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { notify: notify, stop: stop };
}

module.exports = { createWsHandlers: createWsHandlers, createNotifier: createNotifier, REQUEST: REQUEST, CHANGED: CHANGED };

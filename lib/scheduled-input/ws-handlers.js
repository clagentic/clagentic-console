// ws-handlers.js - the browser's side of scheduled input: the messages the
// clock button and the scheduled-message bubble send.
//
//   schedule_message              arm an input on the session on screen
//                                 { text, resetsAt }                     once (the original shape)
//                                 { text, kind: "recurring", every, until | count }
//   cancel_scheduled_message      { id? } delete one of its inputs
//   send_scheduled_now            { id? } deliver one now
//   scheduled_input_list_request  answer the session's armed inputs
//
// An id names the record. A browser still running the client from before
// records had ids sends none, and gets the input that fires first.
//
// A browser only ever acts on the session it has on screen; the CLI is the
// path that can name any session.

var { KIND } = require("./records");
var { listMessage } = require("./publisher");
var target = require("./target");

// What the chat and the bubble call each kind.
var KIND_NOTE = Object.freeze({
  [KIND.ONCE]: "scheduled message",
  [KIND.RECURRING]: "scheduled repeat",
});

var HANDLED = Object.freeze({
  schedule_message: true,
  cancel_scheduled_message: true,
  send_scheduled_now: true,
  scheduled_input_list_request: true,
});

// deps: { slug, service, getSessionForWs(ws), sendTo(ws, obj) }
function createWsHandlers(deps) {
  var slug = deps.slug;
  var service = deps.service;

  function createdBy(ws) {
    var user = ws && ws._clagenticUser;
    if (!user) return "browser";
    return "browser:" + String(user.username || user.displayName || user.id || "user").slice(0, 60);
  }

  function refuse(ws, reason) {
    deps.sendTo(ws, { type: "error", text: "Clagentic: Console could not schedule that: " + reason });
  }

  function kindOf(msg) {
    if (msg.kind === undefined || msg.kind === KIND.ONCE) return KIND.ONCE;
    if (msg.kind === KIND.RECURRING) return KIND.RECURRING;
    return null;
  }

  function schedule(ws, session, msg) {
    var kind = kindOf(msg);
    if (!kind) return refuse(ws, "unknown kind");
    var result = service.create(slug, {
      target: target.targetOf(session),
      session: session,
      kind: kind,
      text: msg.text,
      note: KIND_NOTE[kind],
      createdBy: createdBy(ws),
      at: kind === KIND.ONCE ? msg.resetsAt : undefined,
      every: kind === KIND.RECURRING ? msg.every : undefined,
      until: kind === KIND.RECURRING ? msg.until : undefined,
      count: kind === KIND.RECURRING ? msg.count : undefined,
    });
    if (!result.ok) refuse(ws, result.reason);
  }

  function idFor(session, msg) {
    if (typeof msg.id === "string" && msg.id) return msg.id;
    var armed = service.armedForSession(slug, session).sort(function (a, b) { return a.nextAt - b.nextAt; });
    return armed.length ? armed[0].id : null;
  }

  // Answers true when the message was one of ours.
  function handle(ws, msg) {
    if (!msg || !HANDLED[msg.type]) return false;
    var session = deps.getSessionForWs(ws);
    if (!session) return true;
    if (!service) {
      refuse(ws, "scheduling is not available here");
      return true;
    }
    if (msg.type === "scheduled_input_list_request") {
      deps.sendTo(ws, listMessage(session, service.armedForSession(slug, session)));
      return true;
    }
    if (msg.type === "schedule_message") {
      schedule(ws, session, msg);
      return true;
    }
    var id = idFor(session, msg);
    if (!id) return true;
    if (msg.type === "cancel_scheduled_message") {
      service.remove(slug, id, session);
      return true;
    }
    // send_scheduled_now: a person forced it, so it joins a running turn.
    service.sendNow(slug, id, session).then(function (res) {
      if (!res.ok) deps.sendTo(ws, { type: "error", text: "Clagentic: Console could not send that now: " + res.reason });
    });
    return true;
  }

  return { handle: handle };
}

module.exports = { createWsHandlers: createWsHandlers, KIND_NOTE: KIND_NOTE };

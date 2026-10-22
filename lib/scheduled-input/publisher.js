// publisher.js - tells the browsers viewing a session what happened to its
// scheduled inputs.
//
// Two kinds of message, both for the session's viewers only:
//   scheduled_input_list     the session's armed inputs, in full, after every
//                            change; the client takes its state from this alone
//   scheduled_message_queued / _sent / _cancelled
//                            the names the scheduled message always used, kept
//                            for a browser still running an older client until
//                            it reloads; recorded in the session's history as
//                            before. A current client takes no state from them.

var target = require("./target");
var { LIMITS } = require("./records");

// deps: { getProject(slug), listFor(slug, session) -> summaries }
function createPublisher(deps) {
  function sessionFor(event, project) {
    return event.session || target.liveSessionOf(project.sm, event.record);
  }

  function fields(record) {
    return {
      id: record.id,
      kind: record.kind,
      every: record.every === undefined ? null : record.every,
      until: record.until === undefined ? null : record.until,
      count: record.count === undefined ? null : record.count,
    };
  }

  function legacy(event, session) {
    var record = event.record;
    var base = Object.assign({ localId: session.localId }, fields(record));
    if (event.type === "queued") {
      return Object.assign(base, {
        type: "scheduled_message_queued",
        text: record.text,
        resetsAt: record.nextAt,
        scheduledAt: record.createdAt,
      });
    }
    if (event.type === "sent") {
      return Object.assign(base, { type: "scheduled_message_sent", final: record.state !== "armed" });
    }
    if (event.type === "cancelled" || event.type === "ended") {
      return Object.assign(base, { type: "scheduled_message_cancelled", reason: record.endReason || null });
    }
    return null;
  }

  return function publish(event) {
    var project = deps.getProject(event.slug);
    if (!project || !project.sm) return;
    var session = sessionFor(event, project);
    if (!session) return;
    var old = legacy(event, session);
    if (old) project.sm.sendAndRecord(session, old);
    project.sm.sendToSession(session, listMessage(session, deps.listFor(event.slug, session)));
  };
}

// The session's armed inputs, in full, with the cap the server applies, so the
// client holds no copy of the limit.
function listMessage(session, inputs) {
  return {
    type: "scheduled_input_list",
    localId: session.localId,
    limit: LIMITS.MAX_ARMED_PER_SESSION,
    inputs: inputs,
  };
}

module.exports = { createPublisher: createPublisher, listMessage: listMessage };

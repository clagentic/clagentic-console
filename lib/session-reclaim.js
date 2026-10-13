"use strict";

// Shared bookkeeping for ending a session that still has live background
// agents (Task dispatches). Two paths end such a session without the operator
// asking: the idle reaper (lib/sdk-bridge.js) and memory shedding
// (lib/memory-shed.js). Neither may do it silently, so both announce through
// announceLiveAgentReclaim: the agents are named, the session is marked as
// expected to resume, and both UI surfaces are told.

var LABEL_MAX = 80;
var FALLBACK_LABEL = "background agent";

function labelTable(session) {
  if (!session.taskLabels) session.taskLabels = Object.create(null);
  return session.taskLabels;
}

// A Task's description or subagent type comes from the model, so it is bound
// and reduced to one line before it is shown to the operator.
function cleanLabel(raw) {
  if (typeof raw !== "string") return FALLBACK_LABEL;
  var one = raw.replace(/\s+/g, " ").trim();
  if (!one) return FALLBACK_LABEL;
  return one.length > LABEL_MAX ? one.slice(0, LABEL_MAX - 3) + "..." : one;
}

/** Remember how to name a Task for the operator. */
function noteTaskLabel(session, taskId, input) {
  if (typeof taskId !== "string" || !taskId) return;
  var src = input && typeof input === "object" ? input : {};
  labelTable(session)[taskId] = cleanLabel(src.description || src.subagent_type);
}

function forgetTaskLabel(session, taskId) {
  if (session.taskLabels && typeof taskId === "string") delete session.taskLabels[taskId];
}

function labelOf(session, taskId) {
  var table = session.taskLabels;
  return (table && Object.prototype.hasOwnProperty.call(table, taskId) && table[taskId]) || FALLBACK_LABEL;
}

/** Operator-facing names of every Task the session still tracks. */
function liveAgentLabels(session) {
  var tasks = session && session.activeTaskToolIds;
  if (!tasks) return [];
  return Object.keys(tasks).filter(function (id) { return tasks[id]; }).map(function (id) {
    return labelOf(session, id);
  });
}

/** Name of the Task that owns a tool call raised by a sub-agent, or null. */
function ownerLabelOfTool(session, prompts, toolUseId) {
  var owner = prompts.ownerTaskOfTool(session, toolUseId);
  return owner ? labelOf(session, owner) : null;
}

function describeAgents(labels) {
  return labels.length === 1
    ? 'background agent "' + labels[0] + '"'
    : labels.length + " background agents (" + labels.map(function (l) { return '"' + l + '"'; }).join(", ") + ")";
}

/**
 * Tell the operator a session with live background agents was ended, and
 * record that it is expected to resume. Returns the agent labels announced
 * (empty when the session had none, in which case nothing is sent).
 *
 * @param {object} o
 * @param {object} o.session
 * @param {object} o.sm - session manager (saveSessionFile, sendAndRecord)
 * @param {?function(object)} o.send - project-wide broadcast
 * @param {?string} o.slug
 * @param {string} o.reason - durable marker stored on the session
 * @param {string} o.source - diagnostic source shown in the Diagnostics panel
 * @param {string} o.cause - sentence naming why the session was ended
 */
function announceLiveAgentReclaim(o) {
  var session = o.session;
  if (!session) return [];
  var labels = liveAgentLabels(session);
  if (labels.length === 0) return labels;

  try {
    session.pendingAutoResume = true;
    session.pendingAutoResumeReason = o.reason;
    if (o.sm && typeof o.sm.saveSessionFile === "function") o.sm.saveSessionFile(session);
  } catch (e) {
    // The notification below still has to go out if the marker cannot be written.
  }

  var message = o.cause + " Interrupted: " + describeAgents(labels) + ". "
    + "The session will resume on your next message; if it does not, resume it manually.";

  if (typeof o.send === "function") {
    try {
      o.send({
        type: "diagnostic",
        severity: "warning",
        source: o.source,
        message: (o.slug ? "[" + o.slug + "] " : "") + message,
      });
    } catch (e) { /* one client's send failure must not block the rest */ }
  }
  if (o.sm && typeof o.sm.sendAndRecord === "function") {
    try {
      o.sm.sendAndRecord(session, { type: "error", text: message });
    } catch (e) { /* the inline marker failing must not block the rest */ }
  }
  return labels;
}

module.exports = {
  noteTaskLabel: noteTaskLabel,
  forgetTaskLabel: forgetTaskLabel,
  liveAgentLabels: liveAgentLabels,
  ownerLabelOfTool: ownerLabelOfTool,
  announceLiveAgentReclaim: announceLiveAgentReclaim,
};

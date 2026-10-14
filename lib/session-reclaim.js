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
  // Bounds the table: a Task that left tracking via a settled prompt has no
  // other forget event.
  pruneTaskLabels(session);
  labelTable(session)[taskId] = cleanLabel(src.description || src.subagent_type);
}

/**
 * Drop the label of every Task the session no longer tracks. A label lives
 * exactly as long as its Task: a Task that completed while its sub-agent's
 * prompt is still open stays tracked, and a reclaim must still name it. The
 * prompt registry decides when a Task leaves tracking, so this follows its
 * answer instead of guessing at the end event.
 */
function pruneTaskLabels(session) {
  var table = session && session.taskLabels;
  if (!table) return;
  var tracked = session.activeTaskToolIds || {};
  Object.keys(table).forEach(function (id) {
    if (!Object.prototype.hasOwnProperty.call(tracked, id) || !tracked[id]) delete table[id];
  });
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

function reclaimMessage(cause, labels) {
  return cause + " Interrupted: " + describeAgents(labels) + ". "
    + "The session will resume on your next message; if it does not, resume it manually.";
}

// A daemon shutdown ends every session at once and nobody is connected to hear
// it, so the agents are written to the session file and told to the operator
// at the next startup (surfaceRestartReclaims / restartNoticeMessages).
var RESTART_REASON = "daemon_restart";
var RESTART_CAUSE = "Clagentic: Console shut down or restarted while this session had background agents running.";
// Bounds the meta line of the session file, which is read back from a 4 KiB chunk.
var PERSISTED_AGENTS_MAX = 8;

/** Validate a persisted agent-label list read back from a session file. */
function sanitizeAgentLabels(raw) {
  if (!Array.isArray(raw)) return null;
  var out = raw.filter(function (l) { return typeof l === "string"; })
    .slice(0, PERSISTED_AGENTS_MAX).map(cleanLabel);
  return out.length ? out : null;
}

function errText(e) {
  return e && e.message ? e.message : String(e);
}

// A failure here is never silent: the journal names the session, the agents
// and the error, so a lost resume marker or notice can be traced afterwards.
function logReclaimFailure(what, session, labels, e) {
  console.error("[session-reclaim] " + what + " for session " + session.localId
    + " (agents: " + labels.map(function (l) { return JSON.stringify(l); }).join(", ") + "): " + errText(e));
}

/**
 * Tell the operator a session with live background agents was ended, and
 * record that it is expected to resume. Never throws: the caller is ending a
 * session (or the process) and must proceed whatever happens here.
 *
 * Returns { labels, persisted }. labels are the agents announced (empty when
 * the session had none, in which case nothing is sent or written and
 * persisted is true). persisted is false when the resume marker could not be
 * written to the session file, so a caller can count the failures.
 *
 * @param {object} o
 * @param {object} o.session
 * @param {object} o.sm - session manager (saveSessionFile, sendAndRecord)
 * @param {?function(object)} o.send - project-wide broadcast
 * @param {?string} o.slug
 * @param {string} o.reason - durable marker stored on the session
 * @param {string} o.source - diagnostic source shown in the Diagnostics panel
 * @param {string} o.cause - sentence naming why the session was ended
 * @param {boolean} [o.deferNotice] - persist the marker and the agent names but
 *   send nothing now (the process is exiting; the notice goes out at startup)
 */
function announceLiveAgentReclaim(o) {
  var session = o.session;
  if (!session) return { labels: [], persisted: true };
  var labels = liveAgentLabels(session);
  if (labels.length === 0) return { labels: labels, persisted: true };

  var persisted = true;
  try {
    session.pendingAutoResume = true;
    session.pendingAutoResumeReason = o.reason;
    // Only a deferred notice needs the names to outlive the process.
    if (o.deferNotice) session.pendingAutoResumeAgents = labels.slice(0, PERSISTED_AGENTS_MAX);
    if (o.sm && typeof o.sm.saveSessionFile === "function") o.sm.saveSessionFile(session);
  } catch (e) {
    // The notification below still has to go out if the marker cannot be written.
    persisted = false;
    logReclaimFailure("Could not persist the resume marker (" + o.reason + ")", session, labels, e);
  }

  if (o.deferNotice) return { labels: labels, persisted: persisted };

  var message = reclaimMessage(o.cause, labels);
  if (typeof o.send === "function") {
    try {
      o.send({
        type: "diagnostic",
        severity: "warning",
        source: o.source,
        message: (o.slug ? "[" + o.slug + "] " : "") + message,
      });
    } catch (e) {
      logReclaimFailure("Could not broadcast the reclaim notice", session, labels, e);
    }
  }
  if (o.sm && typeof o.sm.sendAndRecord === "function") {
    try {
      o.sm.sendAndRecord(session, { type: "error", text: message });
    } catch (e) {
      logReclaimFailure("Could not record the inline reclaim notice", session, labels, e);
    }
  }
  return { labels: labels, persisted: persisted };
}

/**
 * Daemon shutdown, called per session before its query is aborted. A session
 * whose query is running and still tracks background agents is announced
 * through the same helper as the reap and the shed; a session without one is
 * left untouched. Synchronous, because the process is exiting.
 */
function announceShutdownReclaim(session, sm) {
  if (!session || !(session.queryInstance || session.worker)) return { labels: [], persisted: true };
  return announceLiveAgentReclaim({
    session: session,
    sm: sm,
    reason: RESTART_REASON,
    source: "daemon-shutdown",
    cause: RESTART_CAUSE,
    deferNotice: true,
  });
}

/** Counts one daemon shutdown's announcements, across every project. */
function createShutdownTally() {
  return { sessions: 0, failed: 0 };
}

/** Fold one announceShutdownReclaim result into the tally. */
function countShutdownReclaim(tally, result) {
  if (!tally || !result || result.labels.length === 0) return;
  tally.sessions += 1;
  if (!result.persisted) tally.failed += 1;
}

/** The one journal line per shutdown; an error line when any marker was lost. */
function logShutdownSummary(tally) {
  var line = "[session-reclaim] Shutdown: " + tally.sessions + " session(s) with background agents recorded as resumable, "
    + tally.failed + " could not be persisted";
  if (tally.failed > 0) console.error(line);
  else console.log(line);
}

function restartAgents(session) {
  return session.pendingAutoResume && session.pendingAutoResumeReason === RESTART_REASON
    ? sanitizeAgentLabels(session.pendingAutoResumeAgents) : null;
}

/**
 * First startup after a shutdown that interrupted background agents: record
 * the inline notice in each such session (it replays to every client that
 * opens it) and keep the names in memory for the diagnostic that
 * restartDiagnostics sends to each connecting client. The persisted names are
 * dropped so a second restart does not repeat the notice.
 */
function surfaceRestartReclaims(o) {
  var sm = o.sm;
  sm.sessions.forEach(function (session) {
    var labels = restartAgents(session);
    if (!labels) return;
    session.pendingAutoResumeAgents = null;
    session.restartNoticeAgents = labels;
    try {
      sm.sendAndRecord(session, { type: "error", text: reclaimMessage(RESTART_CAUSE, labels) });
      if (typeof sm.saveSessionFile === "function") sm.saveSessionFile(session);
    } catch (e) {
      console.error("[session-reclaim] Could not record the restart notice:", e && e.message ? e.message : e);
    }
  });
}

/** Diagnostic messages for a client that connects while a restart notice is unread. */
function restartDiagnostics(sm, slug, canSee) {
  var out = [];
  // Agent names are session content: without a visibility check nobody gets them.
  if (typeof canSee !== "function") return out;
  sm.sessions.forEach(function (session) {
    if (!session.restartNoticeAgents) return;
    if (!canSee(session)) return;
    out.push({
      type: "diagnostic",
      severity: "warning",
      source: "daemon-restart",
      message: (slug ? "[" + slug + "] " : "") + reclaimMessage(RESTART_CAUSE, session.restartNoticeAgents),
    });
  });
  return out;
}

module.exports = {
  RESTART_REASON: RESTART_REASON,
  sanitizeAgentLabels: sanitizeAgentLabels,
  announceShutdownReclaim: announceShutdownReclaim,
  createShutdownTally: createShutdownTally,
  countShutdownReclaim: countShutdownReclaim,
  logShutdownSummary: logShutdownSummary,
  surfaceRestartReclaims: surfaceRestartReclaims,
  restartDiagnostics: restartDiagnostics,
  noteTaskLabel: noteTaskLabel,
  pruneTaskLabels: pruneTaskLabels,
  liveAgentLabels: liveAgentLabels,
  ownerLabelOfTool: ownerLabelOfTool,
  announceLiveAgentReclaim: announceLiveAgentReclaim,
};

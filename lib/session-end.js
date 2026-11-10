"use strict";

// session-end.js - stands one live session down on request (the end-session
// verb). The mechanics are the idle reaper's (lib/sdk-bridge.js), plus the two
// steps a session blocked on an operator prompt needs: its pending prompts are
// settled and the running turn is aborted, because a turn waiting on a prompt
// never reads the closed input queue.
//
// An end is a reap, not a delete: the session file and history stay, and input
// to the session's id resumes it.

var sessionReclaim = require("./session-reclaim");
var promptSource = require("./prompt-source");
var { promptsFor } = require("./prompt-registry");

var CANCEL_REASON = "ended";
var ANNOUNCE_REASON = "ended_by_request";
var ANNOUNCE_SOURCE = "end-session";
var REASON_MAX = 200;

function errText(e) {
  return e && e.message ? e.message : String(e);
}

// The cancel source for an end: caller:<from> when a caller named itself, else
// user (the operator's own CLI). Returns { source } or { error }.
function sourceFor(from) {
  return promptSource.callerSource(from, "an end");
}

// The free-text reason as one bounded line, or "" when none was given.
function cleanReason(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, REASON_MAX);
}

function causeFor(endedBy, reason) {
  var cause = "Clagentic: Console ended this session at the request of " + (endedBy === promptSource.CANCEL.USER ? "the operator" : endedBy.replace(/^caller:/, "")) + ".";
  return reason ? cause + " Reason: " + reason + "." : cause;
}

// Ends the session's runtime. Never throws: each step reports its own failure
// and the later steps still run, so a failed abort cannot leave the prompts
// pending or the query open. A failed step is returned, not hidden, so the
// caller can tell an end that left prompts unsettled from a clean one.
//
// o: { session, sm, send, slug, source, reason }
// Returns { agents, failures } - the background agents the announcement named,
// and { step, error } for each step that failed (step: announce, prompts, abort, close).
function endLiveSession(o) {
  var session = o.session;
  var failures = [];

  function failed(step, what, e) {
    console.error("[session-end] could not " + what + " of session " + session.localId + ":", errText(e));
    failures.push({ step: step, error: errText(e) });
  }

  // First: cancelling the prompts forgets the background agents, and the
  // announcement has to name them.
  var announced = { labels: [] };
  try {
    announced = sessionReclaim.announceLiveAgentReclaim({
      session: session,
      sm: o.sm,
      send: o.send,
      slug: o.slug,
      reason: ANNOUNCE_REASON,
      source: ANNOUNCE_SOURCE,
      cause: causeFor(o.source, cleanReason(o.reason)),
    });
  } catch (e) {
    failed("announce", "announce the end", e);
  }

  try {
    promptsFor(o.sm).cancelSession(session, CANCEL_REASON, { source: o.source });
  } catch (e) {
    failed("prompts", "settle the prompts", e);
  }

  if (session.abortController && typeof session.abortController.abort === "function") {
    try { session.abortController.abort(); }
    catch (e) { failed("abort", "abort the turn", e); }
  }

  try {
    if (session.queryInstance && typeof session.queryInstance.close === "function") session.queryInstance.close();
    else if (session.messageQueue && typeof session.messageQueue.end === "function") session.messageQueue.end();
  } catch (e) {
    failed("close", "close the query", e);
  }

  return { agents: announced.labels, failures: failures };
}

module.exports = { endLiveSession: endLiveSession, sourceFor: sourceFor, cleanReason: cleanReason };

"use strict";

// session-liveness.js - the one daemon-side derivation of what a session is
// doing, read by every surface that shows it: the build-update confirm card,
// the session list served to the client (picker dots, sidebar), and
// list-sessions.
//
// Inputs are the three facts a session holds: whether a runtime is attached,
// whether a turn is running, and whether an operator prompt is pending.
//
//   reaped    no runtime (idle reaper, daemon restart); input resumes it
//   waiting   a runtime is attached and at least one operator prompt is
//             pending: a turn or runtime is blocked on the operator
//   running   a runtime is attached, a turn is running, nothing is pending
//   idle      a runtime is attached, nothing running, nothing pending
//
// A pending prompt outranks a running turn: a turn stopped on a prompt is
// not progressing, and "running" would hide that the operator is the one
// being waited on. A prompt on a session with no runtime is not waited on by
// anything (nothing can use the answer), so that session is reaped; its
// prompt stays visible in list-sessions pendingPrompts.
//
// list-sessions keeps its three-valued `state` (live | idle | reaped); a
// waiting session is live there. liveStateOf() is that projection.

var senderRef = require("./sender-ref");
var { countPending } = require("./pending-prompts");

var ACTIVITY = Object.freeze({ REAPED: "reaped", IDLE: "idle", RUNNING: "running", WAITING: "waiting" });

// facts: { attached, turnRunning, pendingCount }
function derive(facts) {
  if (!facts.attached) return ACTIVITY.REAPED;
  if (facts.pendingCount > 0) return ACTIVITY.WAITING;
  return facts.turnRunning ? ACTIVITY.RUNNING : ACTIVITY.IDLE;
}

// The activity of a session object held by a project's session manager.
function activityOf(session) {
  return derive({
    attached: senderRef.isLive(session),
    turnRunning: !!session.isProcessing,
    pendingCount: countPending(session),
  });
}

// list-sessions' `state`: waiting and running are both "live".
function liveStateOf(activity) {
  if (activity === ACTIVITY.REAPED) return "reaped";
  return activity === ACTIVITY.IDLE ? "idle" : "live";
}

module.exports = { ACTIVITY: ACTIVITY, derive: derive, activityOf: activityOf, liveStateOf: liveStateOf };

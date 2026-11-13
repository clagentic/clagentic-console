"use strict";

// The live background tasks of one session, of any type (Agent, Bash, monitor,
// workflow...). The idle reaper (lib/sdk-bridge.js) never ends a session while
// this set is non-empty: a lane waiting on a background command emits nothing
// until the command's notification, and ending its query would kill the waiter.
//
// Two sources feed the set:
//   1. The SDK's background_tasks_changed, a level signal: replaceAll swaps the
//      whole set for each payload.
//   2. A fallback for a CLI that never emits it: add() on the tool_result that
//      carries a Bash backgroundTaskId, remove() on the task_notification whose
//      task_id matches, whatever its status.
// clear() runs when the query ends, so a stale entry cannot pin a session.

var LABEL_MAX = 80;
var FALLBACK_LABEL = "background task";
var AGENT_TYPE = "local_agent";

function table(session) {
  if (!session.liveBackgroundTasks) session.liveBackgroundTasks = Object.create(null);
  return session.liveBackgroundTasks;
}

function cleanLabel(raw) {
  if (typeof raw !== "string") return FALLBACK_LABEL;
  var one = raw.replace(/\s+/g, " ").trim();
  if (!one) return FALLBACK_LABEL;
  return one.length > LABEL_MAX ? one.slice(0, LABEL_MAX - 3) + "..." : one;
}

/** Replace the set with the SDK's full list. Ambient tasks are not activity. */
function replaceAll(session, tasks) {
  var next = Object.create(null);
  (Array.isArray(tasks) ? tasks : []).forEach(function (t) {
    if (!t || typeof t.id !== "string" || !t.id || t.ambient) return;
    next[t.id] = { type: t.type || null, label: cleanLabel(t.description) };
  });
  session.liveBackgroundTasks = next;
}

function add(session, id, type, label) {
  if (typeof id !== "string" || !id) return;
  table(session)[id] = { type: type || null, label: cleanLabel(label) };
}

function remove(session, id) {
  if (typeof id !== "string" || !id || !session.liveBackgroundTasks) return;
  delete session.liveBackgroundTasks[id];
}

function clear(session) {
  session.liveBackgroundTasks = Object.create(null);
}

function count(session) {
  return session && session.liveBackgroundTasks ? Object.keys(session.liveBackgroundTasks).length : 0;
}

/**
 * Operator-facing labels of the live tasks that are not agents. Agents are
 * named from the prompt registry's own tracking (lib/session-reclaim.js), so
 * listing them here too would name each one twice.
 */
function nonAgentLabels(session) {
  var live = session && session.liveBackgroundTasks;
  if (!live) return [];
  return Object.keys(live).filter(function (id) { return live[id].type !== AGENT_TYPE; })
    .map(function (id) { return live[id].label; });
}

module.exports = {
  replaceAll: replaceAll,
  add: add,
  remove: remove,
  clear: clear,
  count: count,
  nonAgentLabels: nonAgentLabels,
};

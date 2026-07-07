/**
 * history-visibility.js — shared source of truth for classifying a recorded
 * history event as "renders a visible message" vs. an invisible-yield event.
 * (lr-c24b)
 *
 * This is the ES module (browser) copy, used by app-header.js's
 * prependOlderHistory / updateHistorySentinel to decide whether a prepended
 * page surfaced any visible content. The CJS backend copy lives at
 * lib/history-visibility.js. A test (test/history-visibility-parity.test.js)
 * asserts both copies produce identical classifications so they cannot
 * silently drift.
 *
 * When adding a new WS message type: check whether processMessage() in
 * app-messages.js inserts a new visible element for it, then update BOTH
 * this file and lib/history-visibility.js accordingly. The parity test will
 * fail if they disagree.
 */

// Tool names that render as hidden bookkeeping widgets (todo/task list state,
// plan-mode banners) — mirrors TODO_TOOLS / PLAN_MODE_TOOLS in tools.js and
// the tool_start branch in app-messages.js.
export var HIDDEN_TOOL_NAMES = {
  TodoWrite: 1,
  TaskCreate: 1,
  TaskUpdate: 1,
  TaskList: 1,
  TaskGet: 1,
  EnterPlanMode: 1,
  ExitPlanMode: 1,
  ask_user_questions: 1,
};

// Event types that never render a new visible message/bubble on their own —
// they update existing UI state (status text, badges, panels) or are pure
// internal bookkeeping. Matches the case branches in app-messages.js that
// call a state setter / no-op rather than a DOM-inserting render helper.
export var INVISIBLE_TYPES = {
  message_uuid: 1,
  session_id: 1,
  status: 1,
  compacting: 1,
  thinking_start: 1,
  thinking_delta: 1,
  thinking_stop: 1,
  ask_user_answered: 1,
  permission_request: 1,
  permission_request_pending: 1,
  permission_cancel: 1,
  permission_resolved: 1,
  elicitation_request: 1,
  elicitation_resolved: 1,
  context_usage: 1,
  fast_mode_state: 1,
  rate_limit: 1,
  rate_limit_usage: 1,
  subagent_activity: 1,
  subagent_tool: 1,
  subagent_done: 1,
  task_started: 1,
  task_progress: 1,
  task_updated: 1,
  done: 1,
  digest_checkpoint: 1,
};

// Event types whose visibility depends on the tool name carried in the event.
var TOOL_NAME_TYPES = {
  tool_start: 1,
  tool_executing: 1,
};

/**
 * Returns true when `entry` (a single session.history[] item / WS message)
 * causes app-messages.js's processMessage() to insert a new visible element
 * into the message list. Returns false for state-only or hidden-bookkeeping
 * events — the invisible-yield set that can dominate a raw-event-count page.
 *
 * entry is intentionally treated defensively: unknown/missing type defaults
 * to visible (safe default — never under-counts and can't create a new
 * zero-visible page shape that this module wasn't already guarding against).
 */
export function isVisibleHistoryEvent(entry) {
  if (!entry || typeof entry.type !== "string") return true;
  var type = entry.type;

  if (INVISIBLE_TYPES[type]) return false;

  if (TOOL_NAME_TYPES[type]) {
    return !HIDDEN_TOOL_NAMES[entry.name];
  }

  // tool_result carries only an id (no name) — it updates an existing tool
  // card rather than inserting a new one, so it is never itself the reason
  // a page becomes visible.
  if (type === "tool_result") return false;

  return true;
}

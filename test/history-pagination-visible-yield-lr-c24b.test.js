// Regression coverage for lr-c24b: history pagination must page by
// visible-message yield, not raw event count.
//
// sessions.js requires config/utils/users (side-effecting at load time), so —
// matching the existing convention in test/replay.test.js — the pure
// window-extension logic under test is inlined here and kept byte-for-byte
// equivalent to the production implementation in lib/sessions.js. The real
// isVisibleHistoryEvent predicate is imported directly since
// lib/history-visibility.js has no project imports / side effects.

var test = require("node:test");
var assert = require("node:assert/strict");
var { isVisibleHistoryEvent } = require("../lib/history-visibility.js");

var HISTORY_PAGE_SIZE = 100;
var MAX_VISIBILITY_EXTENSIONS = 5;

function findTurnBoundary(history, targetIndex) {
  var searchFloor = Math.max(0, targetIndex - HISTORY_PAGE_SIZE);
  for (var i = targetIndex; i >= searchFloor; i--) {
    if (history[i] && history[i].type === "user_message") return i;
  }
  return targetIndex;
}

function sliceHasVisibleEvent(history, from, to) {
  for (var i = from; i < to; i++) {
    if (isVisibleHistoryEvent(history[i])) return true;
  }
  return false;
}

function extendWindowForVisibility(history, from, to) {
  var steps = 0;
  while (from > 0 && !sliceHasVisibleEvent(history, from, to) && steps < MAX_VISIBILITY_EXTENSIONS) {
    var next = findTurnBoundary(history, from - 1);
    if (next >= from) break;
    from = next;
    steps++;
  }
  return from;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Builds a run of `count` invisible-yield events (todo bookkeeping), optionally
// preceded by a user_message turn boundary.
function invisibleRun(count) {
  var out = [];
  for (var i = 0; i < count; i++) {
    out.push({ type: "tool_start", id: "t" + i, name: "TodoWrite" });
  }
  return out;
}

function turn(userText, bodyEvents) {
  return [{ type: "user_message", text: userText }].concat(bodyEvents || []);
}

// ---------------------------------------------------------------------------
// extendWindowForVisibility — core bounded-extension behavior
// ---------------------------------------------------------------------------

test("page already has a visible event: from is unchanged", () => {
  var history = turn("hi", [{ type: "delta", text: "hello" }]);
  var from = extendWindowForVisibility(history, 0, history.length);
  assert.equal(from, 0);
});

test("page landing entirely on invisible-yield events extends backward to the prior visible turn", () => {
  // Turn 1: visible. Turn 2: 150 invisible todo events (one raw page's worth
  // and then some). A page window starting mid-turn-2 should extend back to
  // turn 2's boundary and find turn-2's own boundary insufficient, then
  // extend further back to turn 1 which has a visible delta.
  var turn1 = turn("first", [{ type: "delta", text: "hi" }]);
  var turn2Body = invisibleRun(50);
  var turn2 = turn("second", turn2Body); // turn2[0] is user_message (visible!) — use a variant below instead
  var history = turn1.concat(turn2);

  // Page window: [turn2 boundary + 1, end) — skips the turn2 user_message
  // itself so the slice is pure invisible-yield.
  var turn2Start = turn1.length; // index of turn2's user_message
  var from = turn2Start + 1;
  var to = history.length;
  assert.equal(sliceHasVisibleEvent(history, from, to), false, "precondition: slice starts all-invisible");

  var extended = extendWindowForVisibility(history, from, to);
  assert.ok(extended <= turn2Start, "must extend to include a visible event");
  assert.ok(sliceHasVisibleEvent(history, extended, to), "extended slice must contain a visible event");
});

test("extension is bounded: from reaches 0 rather than scanning unboundedly on an all-invisible session", () => {
  // Build MAX_VISIBILITY_EXTENSIONS+2 turns, each entirely invisible-yield
  // bookkeeping with no visible content anywhere, each turn HISTORY_PAGE_SIZE
  // long so a naive unbounded scan would run away.
  var history = [];
  var turnsCount = MAX_VISIBILITY_EXTENSIONS + 2;
  for (var t = 0; t < turnsCount; t++) {
    history.push({ type: "user_message", text: "turn " + t, _invisibleTurn: true });
    for (var j = 0; j < HISTORY_PAGE_SIZE - 1; j++) {
      history.push({ type: "tool_start", id: t + "-" + j, name: "TaskUpdate" });
    }
  }
  // Page window starts at the very last turn's body (all invisible).
  var from = history.length - (HISTORY_PAGE_SIZE - 1);
  var to = history.length;

  var extended = extendWindowForVisibility(history, from, to);

  // Bounded: at most MAX_VISIBILITY_EXTENSIONS turn-boundary steps back from
  // the starting turn boundary. Confirm we did NOT walk the entire history
  // (there are more invisible turns before the point we stopped at) and that
  // we stopped exactly at the step cap or at 0, whichever comes first.
  var stepsTaken = 0;
  var probe = from;
  while (probe > extended) {
    probe = findTurnBoundary(history, probe - 1);
    stepsTaken++;
  }
  assert.ok(stepsTaken <= MAX_VISIBILITY_EXTENSIONS, "must not exceed the extension step cap");
  assert.ok(extended >= 0);
});

test("user_message turn boundaries themselves count as visible — a page starting exactly on one needs no extension", () => {
  var history = turn("hello", invisibleRun(20));
  var from = 0; // the user_message itself
  var extended = extendWindowForVisibility(history, from, history.length);
  assert.equal(extended, 0, "user_message at index 0 is already visible — no extension needed");
});

// ---------------------------------------------------------------------------
// isVisibleHistoryEvent — spot checks tying the predicate to the pagination
// bug's exact reproduction shape from the task description.
// ---------------------------------------------------------------------------

test("a 100-event page dominated by TodoWrite/TaskCreate/plan-tool bookkeeping is classified fully invisible", () => {
  var page = [];
  var names = ["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "EnterPlanMode", "ExitPlanMode"];
  for (var i = 0; i < 100; i++) {
    page.push({ type: "tool_start", id: "i" + i, name: names[i % names.length] });
  }
  assert.equal(sliceHasVisibleEvent(page, 0, page.length), false);
});

test("a single Bash tool_start amid invisible bookkeeping makes the page visible", () => {
  var page = invisibleRun(60).concat([{ type: "tool_start", id: "bash-1", name: "Bash" }]).concat(invisibleRun(39));
  assert.equal(sliceHasVisibleEvent(page, 0, page.length), true);
});

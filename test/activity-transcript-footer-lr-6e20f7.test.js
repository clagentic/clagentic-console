// activity-transcript-footer-lr-6e20f7.test.js
//
// MILLER diagnosis lr-6e20f7: the lr-66c118 frontend derivation migrated 21
// render sites — every one of them in the sidebar/hub/picker surface, zero
// in the in-conversation transcript. The transcript-footer indicator
// (app-favicon.js .activity-inline) raised optimistically on submit and was
// never wired to anything reactive, so it went dark during subagent work and
// stranded on-screen indefinitely (setActivity(null) had zero callers).
//
// CI BLIND SPOT this file closes (per task spec): the four invariants in
// test/activity-state-lr-66c118.test.js all prove ABSENCE of a known-bad
// pattern within an ENUMERATED set of already-migrated sites — none of them
// re-derives the enumeration, so a render site that was never on the list
// (the whole transcript view) passed every invariant trivially. This file:
//   1. Enumerates the transcript-view indicator classes explicitly.
//   2. Asserts a clear path EXISTS for each (not merely that manual clear
//      call sites are absent — the actual bug was an absence with no
//      reactive replacement).
//   3. Adds a POSITIVE invariant: every indicator-bearing CSS class in the
//      transcript view traces to a reactive driver (activity-state.js's
//      derivation, or app-favicon.js's store subscriber that plays the same
//      role for the footer widget) rather than a one-shot manual raise with
//      no counterpart clear. A positive invariant is the one that would
//      have caught this — see task spec's explicit instruction to prefer it
//      over another absence check.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

function readMod(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

function stripLineComments(src) {
  return src
    .split("\n")
    .map(function (line) {
      var idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// 1. Enumeration of transcript-view indicator classes (the exact 3 renderers
//    named in the MILLER census, minus #4 which is @mate-only with a
//    separate lifecycle — see the "mention.js excluded" test below for the
//    explicit judgment call rather than a silent inclusion/exclusion).
// ---------------------------------------------------------------------------

var TRANSCRIPT_INDICATOR_CLASSES = [
  "activity-inline",       // app-favicon.js — bubble-layout footer (presence)
  "channel-pre-thinking",  // app-rendering.js — channel-layout footer (presence)
  "thinking-item",         // tools.js — real thinking block (detail, not presence)
];

test("enumeration: all 3 transcript indicator classes are actually defined in CSS (sanity — the enumeration itself is not stale)", function () {
  var allCss = [
    readMod("lib/public/css/rewind.css"),
    readMod("lib/public/css/channel-layout.css"),
    readMod("lib/public/css/messages.css"),
  ].join("\n");
  TRANSCRIPT_INDICATOR_CLASSES.forEach(function (cls) {
    var pattern = new RegExp("\\." + cls + "\\b");
    assert.match(allCss, pattern, "expected ." + cls + " to be defined somewhere in the transcript CSS files");
  });
});

// ---------------------------------------------------------------------------
// 2. A clear path EXISTS for the footer widget — not merely that manual
//    clear call sites are absent (that was the actual bug: lr-66c118 deleted
//    all 15 manual clear/raise sites for setActivity and left EXACTLY the
//    raise, with the "widget's own reactive clear" the removal comments
//    promised never actually written).
// ---------------------------------------------------------------------------

test("CI invariant: app-favicon.js exports a reactive footer-clear path (initActivityFooter), not just the raise", function () {
  var src = readMod("lib/public/modules/app-favicon.js");
  assert.match(
    src,
    /export function initActivityFooter\s*\(/,
    "app-favicon.js must export a reactive init function that can clear the .activity-inline widget without a manual setActivity(null) call site"
  );
  // The reactive path must actually call setActivity(null) (or an
  // equivalent clear) somewhere INSIDE that function, not just define an
  // empty stub — pin the body, not just the export.
  var fnStart = src.indexOf("export function initActivityFooter");
  assert.ok(fnStart !== -1);
  var fnBody = src.slice(fnStart, src.indexOf("\n}", fnStart) + 2);
  assert.match(
    fnBody,
    /setActivity\(null\)/,
    "initActivityFooter must call setActivity(null) somewhere in its body — a reactive clear that never actually clears is the same bug restated"
  );
  assert.match(
    fnBody,
    /store\.subscribe\(/,
    "the clear must be driven by a store subscription (reactive), not a one-shot call"
  );
});

test("CI invariant: initActivityFooter is actually wired up at boot (app.js), not merely defined and unused", function () {
  var appSrc = readMod("lib/public/app.js");
  assert.match(
    appSrc,
    /\binitActivityFooter\s*\(\s*\)/,
    "initActivityFooter() must be called during app boot — a correct-but-uncalled subscriber is exactly the kind of defect this task's CI blind spot allowed to ship silently"
  );
  assert.match(
    stripLineComments(appSrc),
    /import\s*\{[^}]*\binitActivityFooter\b[^}]*\}\s*from\s*['"]\.\/modules\/app-favicon\.js['"]/,
    "initActivityFooter must be imported from app-favicon.js in app.js"
  );
});

test("CI invariant: the channel-layout footer (.channel-pre-thinking) already had a real clear path (removePreThinking) reachable from every terminal message handler", function () {
  // Unlike the bubble-layout widget, channel layout's footer was NOT the
  // stranded one (MILLER: SYMPTOM B's dual-footer pair is footer-vs-
  // thinking-block in BUBBLE layout specifically, because channel's footer
  // already has this clear path). Pin that this remains true so a future
  // change can't silently regress the one footer that already worked.
  var src = stripLineComments(readMod("lib/public/modules/app-messages.js"));
  var terminalHandlersThatMustClear = ["done:", "error:", "auth_required:"];
  terminalHandlersThatMustClear.forEach(function (handlerPrefix) {
    var idx = src.indexOf("\n  " + handlerPrefix + " function");
    assert.ok(idx !== -1, "expected to find the " + handlerPrefix + " handler in app-messages.js");
    var body = src.slice(idx, src.indexOf("\n  },", idx) + 5);
    assert.match(
      body,
      /removePreThinking\(\)/,
      "the " + handlerPrefix + " handler must call removePreThinking() so .channel-pre-thinking cannot strand the way .activity-inline did"
    );
  });
});

// ---------------------------------------------------------------------------
// 3. POSITIVE invariant: every transcript indicator-bearing CSS class traces
//    to a reactive driver. This is the one that would have caught the
//    original bug — a class that exists in CSS and is instantiated by JS but
//    is driven by NOTHING reactive (no store.subscribe, no derivation call)
//    is exactly the .activity-inline-before-this-fix shape.
// ---------------------------------------------------------------------------

test("POSITIVE invariant: .activity-inline (footer) is driven by a store.subscribe reactive path, not only a one-shot raise", function () {
  var favSrc = stripLineComments(readMod("lib/public/modules/app-favicon.js"));
  // The class must be instantiated in this file...
  assert.match(favSrc, /activity-inline/, "app-favicon.js must still own the .activity-inline class");
  // ...and store.subscribe must appear at module scope (reactive), not just
  // inside setActivity itself (setActivity is imperative — it does not
  // subscribe to anything, it is CALLED by something that does).
  assert.match(
    favSrc,
    /store\.subscribe\(\s*\[?['"]processing['"]/,
    "the .activity-inline widget must be reachable from a store.subscribe(['processing'], ...) reactive path"
  );
});

test("POSITIVE invariant: .channel-pre-thinking (footer) is driven by a reactive removal call from every terminal handler, and its raise is layout-gated to never coexist with .activity-inline", function () {
  var renderingSrc = readMod("lib/public/modules/app-rendering.js");
  assert.match(
    renderingSrc,
    /export function showClaudePreThinking\s*\(\s*\)\s*\{\s*\n\s*if\s*\(getChatLayout\(\)\s*!==\s*"channel"\)\s*return;/,
    "showClaudePreThinking must be layout-gated to channel only — this is what keeps it mutually exclusive with .activity-inline (bubble-only)"
  );
});

test("POSITIVE invariant: initActivityFooter is itself layout-gated to bubble layout only, so it cannot fight .channel-pre-thinking for the same slot", function () {
  var favSrc = readMod("lib/public/modules/app-favicon.js");
  var fnStart = favSrc.indexOf("export function initActivityFooter");
  var fnBody = favSrc.slice(fnStart, favSrc.indexOf("\n}", fnStart) + 2);
  assert.match(
    fnBody,
    /getChatLayout\(\)\s*!==\s*"channel"/,
    "initActivityFooter must gate on getChatLayout() !== 'channel' (bubble layout only), mirroring input.js's optimistic-raise gate and showClaudePreThinking's channel-only gate"
  );
});

test("POSITIVE invariant: .thinking-item's presence spinner is suppressed in bubble layout, where the footer already owns presence", function () {
  var css = readMod("lib/public/css/messages.css");
  assert.match(
    css,
    /body:not\(\.wide-view\)\s+\.thinking-spinner\s*\{\s*display:\s*none;\s*\}/,
    "bubble layout (body:not(.wide-view)) must hide .thinking-spinner — the thinking block owns DETAIL, not presence, once the footer is reactive"
  );
});

// ---------------------------------------------------------------------------
// 4. Server-side widened token scope (item c): every Claude tool_use block
//    acquires an activity token at block_stop, not only Task — and the
//    release path already covers it unconditionally (source-shape check;
//    behavioral proof lives in test/session-activity-lr-9bcd7b.test.js).
// ---------------------------------------------------------------------------

test("CI invariant: sdk-message-processor.js acquires an activity token for every tool_use block at block_stop, not gated to block.name === 'Task'", function () {
  var src = stripLineComments(readMod("lib/sdk-message-processor.js"));
  var blockStopIdx = src.indexOf('parsed.yokeType === "block_stop"');
  assert.ok(blockStopIdx !== -1, "expected to find the block_stop branch");
  var toolUseIdx = src.indexOf('block.type === "tool_use"', blockStopIdx);
  assert.ok(toolUseIdx !== -1);
  var nextBranchIdx = src.indexOf("block.type ===", toolUseIdx + 1);
  var toolUseBody = src.slice(toolUseIdx, nextBranchIdx === -1 ? toolUseIdx + 2000 : nextBranchIdx);
  // acquireActivity must be called unconditionally within the tool_use body
  // (i.e. before any `if (block.name === "Task")` gate), not only inside it.
  var acquireIdx = toolUseBody.indexOf("acquireActivity(session, block.id");
  var taskGateIdx = toolUseBody.indexOf('block.name === "Task"');
  assert.ok(acquireIdx !== -1, "expected an unconditional acquireActivity(session, block.id, ...) call in the tool_use block_stop body");
  assert.ok(taskGateIdx !== -1, "expected the Task-specific activeTaskToolIds bookkeeping to remain");
  assert.ok(
    acquireIdx < taskGateIdx,
    "acquireActivity must run BEFORE the Task-specific gate (i.e. unconditionally for every tool), not only inside the Task branch — found acquire at " +
      acquireIdx + ", Task gate at " + taskGateIdx
  );
});

// ---------------------------------------------------------------------------
// 5. mention.js's .activity-inline.mention-activity-bar — explicit judgment
//    call (task spec requires stating reasoning rather than silently
//    including or excluding it from the collapse).
// ---------------------------------------------------------------------------

test("judgment call: mention.js's @mate activity bar is intentionally OUTSIDE the collapse — separate lifecycle, not session isProcessing/token-registry driven", function () {
  var mentionSrc = stripLineComments(readMod("lib/public/modules/mention.js"));
  // It must still exist (not deleted) and still be driven by its own
  // msg.activity field, not by the session activity registry / store.processing
  // — pinning this documents the deliberate exclusion rather than letting a
  // future refactor accidentally fold it in or silently orphan it.
  assert.match(mentionSrc, /mention-activity-bar/, "mention.js must still own its own activity bar");
  assert.match(
    mentionSrc,
    /function handleMentionActivity\s*\(\s*msg\s*\)/,
    "the @mate activity bar must remain driven by its own handleMentionActivity(msg) message handler"
  );
  assert.doesNotMatch(
    mentionSrc,
    /store\.subscribe\(\s*\[?['"]processing['"]/,
    "the @mate activity bar must NOT be wired to store.processing — its lifecycle (msg.activity on/off) is unrelated to session-wide turn processing and folding it in would conflate two different signals"
  );
});

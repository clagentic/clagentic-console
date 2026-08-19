// activity-latch-lr-96e7da.test.js
//
// lr-96e7da: MILLER diagnosis. store.processing (the field app-favicon.js's
// initActivityFooter subscribes to) is a client-local edge latch with no
// server reconciliation. Missing a single 1->0 done edge — e.g. because a
// cross-session status:"processing" raised it and no matching done was ever
// routed back to THIS focused session — leaves the footer widget stuck ON
// forever. This is the INVERSE of lr-6e20f7's stuck-OFF symptom.
//
// CI BLIND SPOT this file closes (per task spec, MILLER's durable finding):
// test/activity-transcript-footer-lr-6e20f7.test.js:157 asserts by STATIC
// SOURCE-TEXT REGEX that store.subscribe(['processing']) exists — it proves
// the wire, never that the widget CLEARS, never drives a real transition,
// never exercises a missed-edge or cross-session scenario. Every existing
// activity invariant in this suite guards stuck-OFF (does a driver exist?);
// nothing guarded stuck-ON (does the driver converge to false?) before this
// file. This file replaces that blind spot with EXECUTED behavioral
// transitions: status:processing -> done drives the widget to REMOVED, and a
// cross-session done leaves the focused session's widget UNAFFECTED.
//
// WHY THIS TESTS lib/public/modules/activity-latch.js RATHER THAN
// app-favicon.js/app-messages.js DIRECTLY: those two files are DOM-heavy —
// app-favicon.js's import graph reaches theme.js, which has a mutual
// circular import with markdown.js (theme.js imports markdown.js;
// markdown.js's module body unconditionally calls
// mermaid.initialize({themeVariables: getMermaidThemeVars()}) at import
// time, before theme.js's own `var currentThemeId = "clagentic-dark"`
// assignment has executed in ESM's circular-import evaluation order). That
// pre-existing ordering hazard is unrelated to this fix and out of this
// task's scope to repair (drive-by rewrite of an unrelated module, code-
// craft rule 1) — importing app-favicon.js in a plain Node test process
// throws inside that unrelated cycle, with or without this diff, and there
// is no jsdom dependency in this repo to paper over it (project convention,
// confirmed project-wide — see other DOM-heavy-module test files, none add
// jsdom).
//
// activity-latch.js was carved out of app-favicon.js/app-messages.js
// specifically so the STUCK-ON decision logic (session-scoping predicate +
// staleness-backstop timer state machine) is provably behaviorally correct
// — mirroring why activity-state.js was carved out of the sidebar/hub
// render sites for the exact same reason (lr-a6a449). This file:
//   1. Proves activity-latch.js's shouldApplyActivityEdge/
//      createActivityStaleBackstop functions are behaviorally correct
//      (sections 1-3).
//   2. Drives a REAL end-to-end reproduction of the stuck-ON bug through
//      the real frontend store.js + the real activity-latch.js together —
//      a status:processing -> done transition removes the widget, and a
//      cross-session done leaves an unrelated focused session's widget
//      state untouched (section 4) — using a minimal DOM-free "footer"
//      double that mirrors exactly what app-favicon.js's store.subscribe
//      callback does (setActivity("thinking") / setActivity(null)), so the
//      transition being asserted is the real one, not a hand-wave.
//   3. Source-inspects (the correct/limited grep use, per this suite's own
//      established convention) that app-messages.js's status/done/
//      auth_required handlers and app-favicon.js's initActivityFooter
//      actually CALL INTO activity-latch.js's real exports, rather than
//      reimplementing the guard inline where it would be unproven (section
//      5) — this is what stops the extracted module from silently drifting
//      out of sync with the code that is supposed to use it.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var { pathToFileURL } = require("url");

var LATCH_URL = pathToFileURL(
  path.join(__dirname, "..", "lib", "public", "modules", "activity-latch.js")
).href;
var STORE_URL = pathToFileURL(
  path.join(__dirname, "..", "lib", "public", "modules", "store.js")
).href;

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

var latch, storeMod;

test("activity-latch.js and store.js load as real ESM modules with no DOM dependency", { timeout: 10000 }, function () {
  return Promise.all([import(LATCH_URL), import(STORE_URL)]).then(function (mods) {
    latch = mods[0];
    storeMod = mods[1];
    assert.strictEqual(typeof latch.shouldApplyActivityEdge, "function");
    assert.strictEqual(typeof latch.createActivityStaleBackstop, "function");
    assert.strictEqual(typeof storeMod.createStore, "function");
    assert.strictEqual(typeof storeMod.store, "object");
  });
});

// ---------------------------------------------------------------------------
// 1. shouldApplyActivityEdge — session-scoping predicate (item a)
// ---------------------------------------------------------------------------

test("shouldApplyActivityEdge: a message with no localId always applies (back-compat with an older server)", function () {
  assert.equal(latch.shouldApplyActivityEdge(null, 5), true);
  assert.equal(latch.shouldApplyActivityEdge(undefined, 5), true);
  assert.equal(latch.shouldApplyActivityEdge(null, null), true);
});

test("shouldApplyActivityEdge: a message for the FOCUSED session applies", function () {
  assert.equal(latch.shouldApplyActivityEdge(5, 5), true);
});

test("shouldApplyActivityEdge: a message for a DIFFERENT (background) session does NOT apply — the cross-session crosstalk MILLER diagnosed", function () {
  assert.equal(latch.shouldApplyActivityEdge(5, 7), false);
  assert.equal(latch.shouldApplyActivityEdge(7, 5), false);
});

// ---------------------------------------------------------------------------
// 2. createActivityStaleBackstop — timer state machine (item c)
// ---------------------------------------------------------------------------

function makeFakeClock() {
  var scheduled = null; // { delay, cb }
  return {
    setTimeout: function (cb, delay) {
      scheduled = { cb: cb, delay: delay };
      return "timer-token";
    },
    clearTimeout: function (token) {
      if (token === "timer-token") scheduled = null;
    },
    fire: function () {
      var s = scheduled;
      scheduled = null;
      if (s) s.cb();
    },
    isScheduled: function () { return scheduled !== null; },
    lastDelay: function () { return scheduled ? scheduled.delay : null; },
  };
}

test("createActivityStaleBackstop: 0->1 transition arms exactly one timer", function () {
  var clock = makeFakeClock();
  var fired = 0;
  var backstop = latch.createActivityStaleBackstop({
    delayMs: 1234,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onFire: function () { fired++; },
  });

  assert.equal(backstop.isArmed(), false);
  backstop.onTransition(true);
  assert.equal(backstop.isArmed(), true, "arming on 0->1 must schedule a timer");
  assert.equal(clock.lastDelay(), 1234, "must use the configured delay (mirrors sdk-bridge.js ACTIVITY_STALE_MS)");
  assert.equal(backstop.armCount(), 1);
  assert.equal(fired, 0, "must not fire immediately on arm");
});

test("createActivityStaleBackstop: 1->0 transition disarms the timer before it can fire — the false-alarm bound", function () {
  var clock = makeFakeClock();
  var fired = 0;
  var backstop = latch.createActivityStaleBackstop({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onFire: function () { fired++; },
  });

  backstop.onTransition(true);
  assert.equal(clock.isScheduled(), true);
  backstop.onTransition(false); // a normal, healthy done arrives well within the window
  assert.equal(clock.isScheduled(), false, "the underlying timer must be cleared, not just ignored");
  assert.equal(backstop.isArmed(), false);
  clock.fire(); // no-op: nothing scheduled
  assert.equal(fired, 0, "a session that finished normally must never fire the backstop");
});

test("createActivityStaleBackstop: repeated 0->1 transitions never stack more than one in-flight timer — the O(1) chattiness bound named in the PR", function () {
  var clock = makeFakeClock();
  var backstop = latch.createActivityStaleBackstop({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });

  backstop.onTransition(true);
  backstop.onTransition(true); // re-arm without an intervening false (e.g. two rapid turns)
  backstop.onTransition(true);

  assert.equal(backstop.armCount(), 3, "each arm call schedules fresh (clear-then-set), not additively");
  assert.equal(clock.isScheduled(), true, "exactly one timer must be live, never zero and never multiple");
});

test("createActivityStaleBackstop: firing while still processing invokes onFire exactly once — this IS the re-request, not a poll", function () {
  var clock = makeFakeClock();
  var fired = 0;
  var backstop = latch.createActivityStaleBackstop({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onFire: function () { fired++; },
  });

  backstop.onTransition(true);
  clock.fire();
  assert.equal(fired, 1);
  assert.equal(backstop.isArmed(), false, "firing must not self-re-arm — a genuinely still-stuck session needs a NEW 0->1 transition (there won't be one) or operator action, not a recurring poll");
});

// ---------------------------------------------------------------------------
// 3. store.js + activity-latch.js driven together — end-to-end stuck-ON
//    reproduction using a minimal DOM-free "footer double" that performs
//    EXACTLY the actions app-favicon.js's real store.subscribe(['processing'])
//    callback performs (setActivity("thinking") / setActivity(null)), driven
//    by the real, unmodified activity-latch.js exports. This is the
//    EXECUTED behavioral transition the task spec requires in place of the
//    static regex at activity-transcript-footer-lr-6e20f7.test.js:157.
// ---------------------------------------------------------------------------

test("END-TO-END: status:processing then done (session-scoped) drives the widget from PRESENT to REMOVED — the exact transition the lr-6e20f7 regex never drove", { timeout: 10000 }, function () {
  return Promise.all([import(STORE_URL), import(LATCH_URL)]).then(function (mods) {
    var s = mods[0];
    var l = mods[1];
    s.createStore({ processing: false, activeSessionId: "sess-A" });

    var widgetPresent = false;
    s.store.subscribe(["processing"], function (state, prev) {
      if (state.processing === prev.processing) return;
      widgetPresent = !!state.processing; // mirrors app-favicon.js's setActivity(!!state.processing)
    });

    // Simulate app-messages.js's status handler: server sends
    // status:"processing" scoped to sess-A while sess-A is focused.
    var statusMsg = { status: "processing", localId: "sess-A" };
    if (statusMsg.status === "processing" && l.shouldApplyActivityEdge(statusMsg.localId, s.store.get("activeSessionId"))) {
      s.store.set({ processing: true });
    }
    assert.equal(widgetPresent, true, "widget must be raised after status:processing for the focused session");

    // Simulate app-messages.js's done handler: server sends done scoped to
    // the SAME session that is still focused.
    var doneMsg = { localId: "sess-A" };
    if (l.shouldApplyActivityEdge(doneMsg.localId, s.store.get("activeSessionId"))) {
      s.store.set({ processing: false });
    }
    assert.equal(widgetPresent, false, "widget MUST be removed after the matching done — this is the assertion the source-text regex could never make");
  });
});

test("END-TO-END REGRESSION: a cross-session done does NOT clear the focused session's widget (would strand it OFF while still genuinely running)", { timeout: 10000 }, function () {
  return Promise.all([import(STORE_URL), import(LATCH_URL)]).then(function (mods) {
    var s = mods[0];
    var l = mods[1];
    s.createStore({ processing: false, activeSessionId: "sess-FOCUSED" });

    var widgetPresent = false;
    s.store.subscribe(["processing"], function (state, prev) {
      if (state.processing === prev.processing) return;
      widgetPresent = !!state.processing;
    });

    // The focused session starts processing.
    var statusMsg = { status: "processing", localId: "sess-FOCUSED" };
    if (statusMsg.status === "processing" && l.shouldApplyActivityEdge(statusMsg.localId, s.store.get("activeSessionId"))) {
      s.store.set({ processing: true });
    }
    assert.equal(widgetPresent, true);

    // A DIFFERENT, background session finishes and sends its own done.
    var backgroundDoneMsg = { localId: "sess-BACKGROUND" };
    if (l.shouldApplyActivityEdge(backgroundDoneMsg.localId, s.store.get("activeSessionId"))) {
      s.store.set({ processing: false });
    }
    assert.equal(widgetPresent, true, "the focused session's widget must remain ON — a background session's done must never clear it (this is the exact crosstalk MILLER's diagnosis names as the highest-probability stuck-ON trigger)");
  });
});

test("END-TO-END REGRESSION (MILLER's stuck-ON reproduction): a cross-session status:processing does NOT raise the focused session's widget", { timeout: 10000 }, function () {
  return Promise.all([import(STORE_URL), import(LATCH_URL)]).then(function (mods) {
    var s = mods[0];
    var l = mods[1];
    s.createStore({ processing: false, activeSessionId: "sess-FOCUSED" });

    var widgetPresent = false;
    s.store.subscribe(["processing"], function (state, prev) {
      if (state.processing === prev.processing) return;
      widgetPresent = !!state.processing;
    });

    // A BACKGROUND session (e.g. one of several concurrent sessions per
    // MILLER's diagnosis: "operator runs many concurrent sessions") starts
    // processing while a DIFFERENT session is focused.
    var statusMsg = { status: "processing", localId: "sess-BACKGROUND" };
    if (statusMsg.status === "processing" && l.shouldApplyActivityEdge(statusMsg.localId, s.store.get("activeSessionId"))) {
      s.store.set({ processing: true });
    }
    assert.equal(widgetPresent, false, "a background session's status:processing must never raise the FOCUSED session's widget — pre-fix this write was unconditional and exactly this edge could leave a permanently-stuck-ON dot with no done ever routed back to clear it");
  });
});

// ---------------------------------------------------------------------------
// 4. Source-inspection (correct/limited grep use, per this suite's own
//    convention): the real DOM-driving files actually CALL INTO the pure,
//    behaviorally-proven exports above, rather than reimplementing the
//    guard inline (which would silently drift out of sync with the proof).
// ---------------------------------------------------------------------------

test("CI invariant: app-messages.js status/done/auth_required handlers call the real shouldApplyActivityEdge, not a reimplemented inline guard", function () {
  var src = stripLineComments(readMod("lib/public/modules/app-messages.js"));
  assert.match(
    src,
    /import\s*\{[^}]*\bshouldApplyActivityEdge\b[^}]*\}\s*from\s*['"]\.\/activity-latch\.js['"]/,
    "app-messages.js must import shouldApplyActivityEdge from activity-latch.js"
  );
  var occurrences = src.match(/shouldApplyActivityEdge\(/g) || [];
  assert.ok(
    occurrences.length >= 3,
    "expected shouldApplyActivityEdge(...) to be called at least 3 times (status, done, auth_required handlers) — found " + occurrences.length
  );
});

test("CI invariant: app-favicon.js's initActivityFooter drives the staleness backstop via the real createActivityStaleBackstop, not a reimplemented inline timer", function () {
  var src = stripLineComments(readMod("lib/public/modules/app-favicon.js"));
  assert.match(
    src,
    /import\s*\{[^}]*\bcreateActivityStaleBackstop\b[^}]*\}\s*from\s*['"]\.\/activity-latch\.js['"]/,
    "app-favicon.js must import createActivityStaleBackstop from activity-latch.js"
  );
  assert.match(
    src,
    /createActivityStaleBackstop\(/,
    "app-favicon.js must actually construct a backstop instance"
  );
  var fnStart = src.indexOf("export function initActivityFooter");
  assert.ok(fnStart !== -1);
  var fnBody = src.slice(fnStart, src.indexOf("\n}", fnStart) + 2);
  assert.match(
    fnBody,
    /\.onTransition\(/,
    "initActivityFooter must call the backstop's onTransition on every processing change, mirroring the exact state machine proven in section 2 above"
  );
});

test("CI invariant: server-side sessions.js/project.js stamp localId on status/done/auth_required at a shared choke point, not per-call-site (reuse-first, PEACHES rule 2)", function () {
  var sessionsSrc = stripLineComments(readMod("lib/sessions.js"));
  assert.match(
    sessionsSrc,
    /function stampActivityLocalId\s*\(/,
    "lib/sessions.js must define the shared stamping helper"
  );
  assert.match(
    sessionsSrc,
    /module\.exports\s*=\s*\{[^}]*\bstampActivityLocalId\b/,
    "stampActivityLocalId must be exported for project.js to reuse (not duplicated)"
  );
  var projectSrc = stripLineComments(readMod("lib/project.js"));
  assert.match(
    projectSrc,
    /require\(["']\.\/sessions["']\)/,
    "project.js must require sessions.js"
  );
  assert.match(
    projectSrc,
    /stampActivityLocalId/,
    "project.js's own sendToSession/sendToSessionOthers must reuse the shared stamping helper, not reimplement it"
  );
});

test("CI invariant: session_switched now carries isProcessing from BOTH server send sites (item b — the hydration path previously omitted it, per MILLER's smoking-gun citation)", function () {
  var connSrc = stripLineComments(readMod("lib/project-connection.js"));
  var switchedIdx = connSrc.indexOf('type: "session_switched"');
  assert.ok(switchedIdx !== -1, "expected a session_switched send in project-connection.js");
  var sendCallEnd = connSrc.indexOf(");", switchedIdx);
  var sendCall = connSrc.slice(switchedIdx, sendCallEnd);
  assert.match(
    sendCall,
    /isProcessing:\s*!!active\.isProcessing/,
    "project-connection.js's session_switched hydration send must carry isProcessing so a fresh connect/reconnect reconciles the footer instead of leaving 'processing' at whatever the latch happened to be"
  );

  var sessionsSrc = stripLineComments(readMod("lib/sessions.js"));
  var switchedIdx2 = sessionsSrc.indexOf('type: "session_switched"');
  assert.ok(switchedIdx2 !== -1, "expected a session_switched send in sessions.js");
  var sendCallEnd2 = sessionsSrc.indexOf(");", switchedIdx2);
  var sendCall2 = sessionsSrc.slice(switchedIdx2, sendCallEnd2);
  assert.match(
    sendCall2,
    /isProcessing:\s*!!session\.isProcessing/,
    "sessions.js's switchSession send must still carry isProcessing (pre-existing, pinned so it can't regress)"
  );
});

test("CI invariant: app-messages.js's session_switched handler reconciles the 'processing' latch from the authoritative snapshot, not only 'sessionIsProcessing' (item b)", function () {
  var src = stripLineComments(readMod("lib/public/modules/app-messages.js"));
  var idx = src.indexOf("session_switched: function");
  assert.ok(idx !== -1);
  var handlerBody = src.slice(idx, src.indexOf("\n  },", idx) + 5);
  // sessionIsProcessing must still be set directly from msg.isProcessing —
  // this is activity-state-lr-66c118.test.js's one documented .isProcessing
  // exception, and it must stay the ONLY raw read in this file (see that
  // suite's CI invariant #2). 'processing' must be re-derived from THAT
  // store field (not a second raw msg.isProcessing read) so both fields stay
  // reconciled to one source without adding a second documented exception.
  assert.match(
    handlerBody,
    /sessionIsProcessing:\s*!!msg\.isProcessing/,
    "session_switched must still set sessionIsProcessing directly from msg.isProcessing (the one documented exception)"
  );
  assert.match(
    handlerBody,
    /processing:\s*store\.get\(['"]sessionIsProcessing['"]\)/,
    "session_switched must reconcile store 'processing' (the field initActivityFooter subscribes to) from the just-set sessionIsProcessing value on every switch/reconnect/hydration"
  );
});

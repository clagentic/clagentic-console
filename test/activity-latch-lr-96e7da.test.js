// activity-latch-lr-96e7da.test.js
//
// lr-96e7da: MILLER diagnosis. store.processing (the field app-favicon.js's
// initActivityFooter subscribes to) was a client-local edge latch with no
// server reconciliation. Missing a single 1->0 done edge — e.g. because a
// cross-session status:"processing" raised it and no matching done was ever
// routed back to THIS focused session — left the footer widget stuck ON
// forever. This was the INVERSE of lr-6e20f7's stuck-OFF symptom.
//
// lr-5edd64 UPDATE: 'processing' is no longer a client-local latch at all —
// it is a pure PROJECTION of server-authoritative per-session state (see
// test/activity-session-list-projection-lr-5edd64.test.js). The push half
// (status/done/auth_required session-scoping) and the staleness backstop
// that used to defend the latch are both gone; shouldApplyActivityEdge
// survives here only because it is reused for a second, unrelated concern
// (session-scoping sessionIsProcessing/dead-session-todo-compaction in the
// status handler — see activity-latch.js's own header comment). This file
// is kept, trimmed, to prove that predicate is still correct and still
// actually wired up — not to re-litigate the deleted latch.
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

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var { pathToFileURL } = require("url");

var LATCH_URL = pathToFileURL(
  path.join(__dirname, "..", "lib", "public", "modules", "activity-latch.js")
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

var latch;

test("activity-latch.js loads as a real ESM module with no DOM dependency", { timeout: 10000 }, function () {
  return import(LATCH_URL).then(function (mod) {
    latch = mod;
    assert.strictEqual(typeof latch.shouldApplyActivityEdge, "function");
  });
});

// ---------------------------------------------------------------------------
// 1. shouldApplyActivityEdge — session-scoping predicate
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
// 2. Source-inspection (correct/limited grep use, per this suite's own
//    convention): the real DOM-driving files actually CALL INTO the pure,
//    behaviorally-proven export above, rather than reimplementing the
//    guard inline (which would silently drift out of sync with the proof).
// ---------------------------------------------------------------------------

test("CI invariant: app-messages.js's status handler calls the real shouldApplyActivityEdge, not a reimplemented inline guard", function () {
  var src = stripLineComments(readMod("lib/public/modules/app-messages.js"));
  assert.match(
    src,
    /import\s*\{[^}]*\bshouldApplyActivityEdge\b[^}]*\}\s*from\s*['"]\.\/activity-latch\.js['"]/,
    "app-messages.js must import shouldApplyActivityEdge from activity-latch.js"
  );
  var occurrences = src.match(/shouldApplyActivityEdge\(/g) || [];
  assert.ok(
    occurrences.length >= 1,
    "expected shouldApplyActivityEdge(...) to be called at least once (status handler, session-scoping sessionIsProcessing/todo-compaction) — found " + occurrences.length
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

test("CI invariant: session_switched carries isProcessing from BOTH server send sites (the hydration path previously omitted it, per MILLER's smoking-gun citation)", function () {
  var connSrc = stripLineComments(readMod("lib/project-connection.js"));
  var switchedIdx = connSrc.indexOf('type: "session_switched"');
  assert.ok(switchedIdx !== -1, "expected a session_switched send in project-connection.js");
  var sendCallEnd = connSrc.indexOf(");", switchedIdx);
  var sendCall = connSrc.slice(switchedIdx, sendCallEnd);
  assert.match(
    sendCall,
    /isProcessing:\s*!!active\.isProcessing/,
    "project-connection.js's session_switched hydration send must carry isProcessing so a fresh connect/reconnect reconciles the footer instead of leaving 'processing' at a stale value"
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

test("CI invariant: app-messages.js's session_switched handler reconciles the 'processing' projection from the authoritative snapshot, not only 'sessionIsProcessing'", function () {
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

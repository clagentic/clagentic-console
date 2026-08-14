// activity-state-lr-66c118.test.js
//
// Regression + behavioral coverage for lr-66c118 (epic lr-a6a449 child 4/4):
// one frontend derivation module (lib/public/modules/activity-state.js)
// replacing 21 divergent activity-indicator render sites and collapsing
// setActivity to a single optimistic raise.
//
// TESTING METHODOLOGY (per task spec, documented lesson of this epic):
// unit tests on this bug class pass clean while the integration leaks
// (lr-9bcd7b), and a static-source-regex test caught none of four live
// defects (lr-255e). activity-state.js is a PURE function module with zero
// DOM dependency, so it gets real behavioral tests here — driving actual
// state objects through sessionActivity/rollupActivity/indicatorClass and
// asserting the derived output, not source-text greps.
//
// The four exceptions are the CI ABSENCE-invariants the task spec calls
// out explicitly as the correct use of grep (proving absence, not
// behavior): sections 5-8 below.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var { pathToFileURL } = require("url");

var ACTIVITY_STATE_URL = pathToFileURL(
  path.join(__dirname, "..", "lib", "public", "modules", "activity-state.js")
).href;

function readMod(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

// Strips // line comments before a source-shape check runs, so an
// explanatory comment mentioning a removed pattern for context (matching
// this project's established convention — see
// hub-recent-sessions-merge-dot-lr-0aa7b6.test.js's own header) never
// false-positives an absence invariant. Deliberately simple (does not
// handle strings containing "//" or block comments) — sufficient for this
// codebase's style, and erring toward OVER-matching (treating something as
// code when it's arguably not) is the safe failure direction for an
// absence check.
function stripLineComments(src) {
  return src
    .split("\n")
    .map(function (line) {
      var idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

var activityStateModule;

test("activity-state.js loads as a real ESM module with no DOM dependency", { timeout: 10000 }, function () {
  return import(ACTIVITY_STATE_URL).then(function (mod) {
    activityStateModule = mod;
    assert.strictEqual(typeof mod.sessionActivity, "function");
    assert.strictEqual(typeof mod.rollupActivity, "function");
    assert.strictEqual(typeof mod.indicatorClass, "function");
  });
});

// ---------------------------------------------------------------------------
// 1. sessionActivity() — behavioral, driving real state shapes through it
// ---------------------------------------------------------------------------

test("sessionActivity: idle session (no processing, no unread) -> idle, inactive", function () {
  var sessionActivity = activityStateModule.sessionActivity;
  var indicatorClass = activityStateModule.indicatorClass;
  var state = sessionActivity({ isProcessing: false, unread: 0 }, "user-1");
  assert.strictEqual(state.active, false);
  assert.strictEqual(state.alert, false);
  assert.strictEqual(state.tone, "idle");
  assert.strictEqual(indicatorClass(state), "");
});

test("sessionActivity: processing, no unread, no owner (single-user) -> self, processing", function () {
  var sessionActivity = activityStateModule.sessionActivity;
  var indicatorClass = activityStateModule.indicatorClass;
  var state = sessionActivity({ isProcessing: true, unread: 0 });
  assert.strictEqual(state.active, true);
  assert.strictEqual(state.tone, "self");
  assert.strictEqual(indicatorClass(state), "processing");
});

test("sessionActivity: unread wins over processing (alert > processing, LOCKED precedence lr-0aa7b6)", function () {
  var sessionActivity = activityStateModule.sessionActivity;
  var indicatorClass = activityStateModule.indicatorClass;
  var state = sessionActivity({ isProcessing: true, unread: 3 }, "user-1");
  assert.strictEqual(state.active, true);
  assert.strictEqual(state.alert, true);
  assert.strictEqual(state.tone, "alert");
  assert.strictEqual(indicatorClass(state), "alert");
});

test("sessionActivity: unread alone (not processing) still surfaces as alert", function () {
  var sessionActivity = activityStateModule.sessionActivity;
  var state = sessionActivity({ isProcessing: false, unread: 1 }, "user-1");
  assert.strictEqual(state.tone, "alert");
});

test("sessionActivity: own session processing, currentUserId matches ownerId -> self tone", function () {
  var sessionActivity = activityStateModule.sessionActivity;
  var indicatorClass = activityStateModule.indicatorClass;
  var state = sessionActivity({ isProcessing: true, unread: 0, ownerId: "user-1" }, "user-1");
  assert.strictEqual(state.tone, "self");
  assert.strictEqual(indicatorClass(state), "processing");
});

test("sessionActivity: another user's session processing -> other tone, distinct from self/alert", function () {
  var sessionActivity = activityStateModule.sessionActivity;
  var indicatorClass = activityStateModule.indicatorClass;
  var state = sessionActivity({ isProcessing: true, unread: 0, ownerId: "user-2" }, "user-1");
  assert.strictEqual(state.active, true);
  assert.strictEqual(state.alert, false);
  assert.strictEqual(state.tone, "other");
  assert.strictEqual(indicatorClass(state), "other");
  assert.notStrictEqual(indicatorClass(state), "processing");
  assert.notStrictEqual(indicatorClass(state), "alert");
});

test("sessionActivity: unread on another user's session is STILL alert (alert has no owner exception)", function () {
  var sessionActivity = activityStateModule.sessionActivity;
  var state = sessionActivity({ isProcessing: true, unread: 2, ownerId: "user-2" }, "user-1");
  assert.strictEqual(state.tone, "alert");
});

test("sessionActivity: ignoreUnread suppresses alert even with unread>0 (project-level dot contract)", function () {
  var sessionActivity = activityStateModule.sessionActivity;
  var indicatorClass = activityStateModule.indicatorClass;
  var state = sessionActivity({ isProcessing: false, unread: 5 }, null, { ignoreUnread: true });
  assert.strictEqual(state.tone, "idle", "unread must not leak into a project-level dot's tone when ignoreUnread is set");
  var state2 = sessionActivity({ isProcessing: true, unread: 5 }, null, { ignoreUnread: true });
  assert.strictEqual(state2.tone, "self");
  assert.strictEqual(indicatorClass(state2), "processing");
});

test("sessionActivity: null/undefined session -> idle, does not throw", function () {
  var sessionActivity = activityStateModule.sessionActivity;
  assert.strictEqual(sessionActivity(null).tone, "idle");
  assert.strictEqual(sessionActivity(undefined).tone, "idle");
});

test("sessionActivity: currentUserId omitted (single-user mode) never derives 'other', even with a foreign ownerId", function () {
  var sessionActivity = activityStateModule.sessionActivity;
  var state = sessionActivity({ isProcessing: true, unread: 0, ownerId: "someone-else" });
  assert.strictEqual(state.tone, "self", "no currentUserId means we cannot know 'other' — must not guess");
});

// ---------------------------------------------------------------------------
// 2. rollupActivity() — behavioral, replacing the 8 open-coded OR-loops
// ---------------------------------------------------------------------------

test("rollupActivity: empty list -> idle", function () {
  var rollupActivity = activityStateModule.rollupActivity;
  assert.strictEqual(rollupActivity([]).tone, "idle");
  assert.strictEqual(rollupActivity(null).tone, "idle");
});

test("rollupActivity: all idle -> idle", function () {
  var rollupActivity = activityStateModule.rollupActivity;
  var list = [{ isProcessing: false }, { isProcessing: false }];
  assert.strictEqual(rollupActivity(list).tone, "idle");
});

test("rollupActivity: one processing among many idle -> processing wins (the anyProcessing OR-loop)", function () {
  var rollupActivity = activityStateModule.rollupActivity;
  var indicatorClass = activityStateModule.indicatorClass;
  var list = [{ isProcessing: false }, { isProcessing: true }, { isProcessing: false }];
  var state = rollupActivity(list);
  assert.strictEqual(state.active, true);
  assert.strictEqual(indicatorClass(state), "processing");
});

test("rollupActivity: alert anywhere in the list wins over processing elsewhere in the list", function () {
  var rollupActivity = activityStateModule.rollupActivity;
  var list = [
    { isProcessing: true, unread: 0, ownerId: "u1" },
    { isProcessing: false, unread: 2, ownerId: "u1" },
  ];
  var state = rollupActivity(list, "u1");
  assert.strictEqual(state.tone, "alert");
});

test("rollupActivity: self wins over other (LOCKED rollup rule) when a folder/project contains both", function () {
  var rollupActivity = activityStateModule.rollupActivity;
  var indicatorClass = activityStateModule.indicatorClass;
  var list = [
    { isProcessing: true, unread: 0, ownerId: "other-user" }, // other's session, processing
    { isProcessing: true, unread: 0, ownerId: "me" },          // my session, also processing
  ];
  var state = rollupActivity(list, "me");
  assert.strictEqual(state.tone, "self", "self must win over other in a mixed rollup, regardless of list order");
  assert.strictEqual(indicatorClass(state), "processing");
});

test("rollupActivity: self still wins over other with the winning items in reverse order", function () {
  var rollupActivity = activityStateModule.rollupActivity;
  var list = [
    { isProcessing: true, unread: 0, ownerId: "me" },
    { isProcessing: true, unread: 0, ownerId: "other-user" },
  ];
  var state = rollupActivity(list, "me");
  assert.strictEqual(state.tone, "self");
});

test("rollupActivity: other-only (no self activity in the list) surfaces as other, not self or idle", function () {
  var rollupActivity = activityStateModule.rollupActivity;
  var list = [
    { isProcessing: false, unread: 0, ownerId: "me" },
    { isProcessing: true, unread: 0, ownerId: "other-user" },
  ];
  var state = rollupActivity(list, "me");
  assert.strictEqual(state.tone, "other");
});

test("rollupActivity: accepts pre-derived ActivityState items without re-deriving (fold path)", function () {
  var rollupActivity = activityStateModule.rollupActivity;
  var sessionActivity = activityStateModule.sessionActivity;
  var derived = [
    sessionActivity({ isProcessing: false }, null),
    sessionActivity({ isProcessing: true, unread: 0, ownerId: "u2" }, "u1"),
  ];
  var state = rollupActivity(derived, "u1");
  assert.strictEqual(state.tone, "other");
});

test("rollupActivity: ignoreUnread forwards to per-item derivation for raw objects", function () {
  var rollupActivity = activityStateModule.rollupActivity;
  var list = [{ isProcessing: false, unread: 9 }, { isProcessing: false, unread: 3 }];
  var state = rollupActivity(list, null, { ignoreUnread: true });
  assert.strictEqual(state.tone, "idle");
});

// ---------------------------------------------------------------------------
// 3. indicatorClass() — the one class-name decision point
// ---------------------------------------------------------------------------

test("indicatorClass: idle/inactive state -> empty string (no CSS modifier class)", function () {
  var indicatorClass = activityStateModule.indicatorClass;
  assert.strictEqual(indicatorClass({ active: false, tone: "idle" }), "");
  assert.strictEqual(indicatorClass(null), "");
  assert.strictEqual(indicatorClass(undefined), "");
});

test("indicatorClass: exactly 3 non-empty outputs exist across the whole tone space — alert, other, processing", function () {
  var indicatorClass = activityStateModule.indicatorClass;
  var outputs = new Set();
  var tones = ["idle", "self", "other", "alert"];
  tones.forEach(function (tone) {
    outputs.add(indicatorClass({ active: tone !== "idle", tone: tone }));
  });
  assert.deepStrictEqual(
    Array.from(outputs).sort(),
    ["", "alert", "other", "processing"].sort(),
    "indicatorClass must reconcile to exactly 3 states + idle — the home-hub 4-state comment (alert/processing/live/idle) was never real"
  );
});

// ---------------------------------------------------------------------------
// 4. Precedence order table — exhaustive over the full state space
// ---------------------------------------------------------------------------

test("precedence table: alert > other > self > idle is total and consistent under rollup", function () {
  var rollupActivity = activityStateModule.rollupActivity;
  var ALERT = { isProcessing: false, unread: 1, ownerId: "u1" };
  var SELF = { isProcessing: true, unread: 0, ownerId: "u1" };
  var OTHER = { isProcessing: true, unread: 0, ownerId: "u2" };
  var IDLE = { isProcessing: false, unread: 0, ownerId: "u1" };

  assert.strictEqual(rollupActivity([ALERT, SELF, OTHER, IDLE], "u1").tone, "alert");
  assert.strictEqual(rollupActivity([SELF, OTHER, IDLE], "u1").tone, "self");
  assert.strictEqual(rollupActivity([OTHER, IDLE], "u1").tone, "other");
  assert.strictEqual(rollupActivity([IDLE], "u1").tone, "idle");
});

// ---------------------------------------------------------------------------
// 5. CI ABSENCE INVARIANT #1 (REVISED, lr-6e20f7): setActivity collapses to a
//    SMALL, FULLY ENUMERATED set of real call sites — no longer "exactly
//    one". This invariant is the one MILLER's lr-6e20f7 diagnosis names
//    explicitly as having caused the bug it was meant to prevent: "exactly
//    one setActivity call site" actively enforced the ABSENCE of a reactive
//    clear, since lr-66c118 deleted all 15 manual clear sites on the
//    assumption a reactive clear would replace them, but none was ever
//    wired up (setActivity(null) had zero callers, and the widget stranded
//    on-screen indistinguishable from a second live indicator).
//
//    lr-6e20f7 adds exactly that reactive clear: app-favicon.js's
//    initActivityFooter() subscribes to store.processing and both raises
//    AND clears the widget, so it now has two real call sites of its own
//    (raise + clear) in addition to input.js's pre-existing optimistic
//    raise. The enumeration below is the exhaustive list this invariant now
//    checks — an extra, unenumerated call site anywhere else is still
//    rejected, which is what actually matters (a stray manual raise/clear
//    creeping back in elsewhere). What changed is WHICH SPECIFIC file:line
//    entries are allowed, not whether unbounded growth is caught.
//
//    Comment-only mentions of the pattern (explaining what was removed) are
//    excluded via stripLineComments — this is proving absence of a
//    call outside the enumerated set, not absence of the string in prose
//    (see this file's header + the established
//    hub-recent-sessions-merge-dot-lr-0aa7b6.test.js precedent for that
//    exclusion).
// ---------------------------------------------------------------------------

test("CI invariant: setActivity(...) call sites are confined to the enumerated reactive raise/clear pair plus input.js's optimistic raise", function () {
  var MODULES_DIR = path.join(__dirname, "..", "lib", "public", "modules");
  var files = fs.readdirSync(MODULES_DIR).filter(function (f) { return f.endsWith(".js"); });

  // lr-6e20f7: the exhaustive set of files allowed to contain a real
  // setActivity(...) call, and how many each is allowed. A file NOT in this
  // list, or a count exceeding what's listed, fails the invariant.
  var ALLOWED_CALL_SITES = {
    "input.js": 1,          // pre-existing optimistic raise on user submit
    "app-favicon.js": 2,    // lr-6e20f7: initActivityFooter's reactive raise + clear
  };

  var callSitesByFile = {};
  files.forEach(function (f) {
    var rel = "lib/public/modules/" + f;
    var src = stripLineComments(readMod(rel));
    // Match a real call expression: setActivity( or ctx.setActivity( — NOT
    // the export function setActivity(text) { definition itself.
    var re = /\bctx\.setActivity\(|(?<!export function )\bsetActivity\(/g;
    var m;
    var sites = [];
    while ((m = re.exec(src)) !== null) {
      // Exclude the definition line itself (export function setActivity).
      var lineStart = src.lastIndexOf("\n", m.index) + 1;
      var line = src.slice(lineStart, src.indexOf("\n", m.index));
      if (/^\s*export function setActivity\(/.test(line)) continue;
      sites.push(line.trim());
    }
    if (sites.length > 0) callSitesByFile[f] = sites;
  });

  var offenders = [];
  Object.keys(callSitesByFile).forEach(function (f) {
    var allowed = ALLOWED_CALL_SITES[f] || 0;
    var found = callSitesByFile[f].length;
    if (found !== allowed) {
      offenders.push(f + ": found " + found + " call site(s), allowed " + allowed + " — " + JSON.stringify(callSitesByFile[f]));
    }
  });
  Object.keys(ALLOWED_CALL_SITES).forEach(function (f) {
    if (!callSitesByFile[f]) {
      offenders.push(f + ": expected " + ALLOWED_CALL_SITES[f] + " call site(s), found 0 — the enumerated reactive raise/clear pair (or the optimistic raise) is missing");
    }
  });

  assert.deepStrictEqual(
    offenders,
    [],
    "setActivity(...) call sites drifted from the enumerated set (input.js:1, app-favicon.js:2 — lr-6e20f7): " + JSON.stringify(offenders)
  );
  assert.ok(
    callSitesByFile["input.js"] && callSitesByFile["input.js"][0].indexOf("setActivity") !== -1,
    "input.js's optimistic raise must remain present"
  );
});

// ---------------------------------------------------------------------------
// 6. CI ABSENCE INVARIANT #2: .isProcessing is read ONLY inside
//    activity-state.js within lib/public/modules/. Two narrow, documented
//    exceptions are excluded — both are non-render-decision reads, not
//    dots: (a) explanatory prose comments (stripped, same rationale as
//    invariant #1), and (b) app-messages.js's session_switched handler,
//    which extracts msg.isProcessing off a raw WS payload into a
//    DIFFERENT, unrelated store field (sessionIsProcessing, used by
//    app-history-replay.js / tools.js dead-session-todo-compaction — not
//    an indicator render decision).
// ---------------------------------------------------------------------------

test("CI invariant: .isProcessing is read only inside activity-state.js (plus one documented non-render exception)", function () {
  var MODULES_DIR = path.join(__dirname, "..", "lib", "public", "modules");
  var files = fs.readdirSync(MODULES_DIR).filter(function (f) { return f.endsWith(".js") && f !== "activity-state.js"; });

  var DOCUMENTED_EXCEPTION = "lib/public/modules/app-messages.js";
  var offenders = [];

  files.forEach(function (f) {
    var rel = "lib/public/modules/" + f;
    var src = stripLineComments(readMod(rel));
    var re = /\.isProcessing\b/g;
    var matches = src.match(re) || [];
    var allowed = rel === DOCUMENTED_EXCEPTION ? 1 : 0;
    if (matches.length > allowed) {
      offenders.push(rel + " (" + matches.length + " occurrences, " + allowed + " allowed)");
    }
  });

  assert.deepStrictEqual(
    offenders,
    [],
    "found .isProcessing reads outside activity-state.js (beyond the one documented exception): " + JSON.stringify(offenders)
  );

  // Pin down that the one documented exception is exactly what it claims to
  // be — msg.isProcessing feeding a differently-named store field, not a
  // dot render — so this allowance can never silently absorb a real
  // render-site regression.
  var appMessagesSrc = readMod(DOCUMENTED_EXCEPTION);
  assert.match(
    appMessagesSrc,
    /sessionIsProcessing:\s*!!msg\.isProcessing/,
    "the one allowed .isProcessing read must be exactly msg.isProcessing feeding sessionIsProcessing — anything else here is undocumented drift"
  );
});

// ---------------------------------------------------------------------------
// 7. CI ABSENCE INVARIANT #3: the 5 pre-existing CSS class families
//    (session-processing, mobile-project-processing, mobile-session-
//    processing, hub-project-dot/hub-recent-dot.processing, icon-strip-
//    status.processing) all converge on the SAME 3-state vocabulary
//    (.processing / .alert / .other) that indicatorClass() produces — not
//    5 independently-evolved, inconsistent vocabularies (the actual bug:
//    e.g. sidebar.css never had an .alert variant, icon-strip never had
//    .other, before this task).
// ---------------------------------------------------------------------------

test("CI invariant: all 5 processing-dot CSS families define the same alert/other vocabulary where applicable, and a processing state", function () {
  // session-processing (sidebar.css) is the one pre-existing family whose
  // BARE base class already means "processing" (the dot element is only
  // rendered at all when active — unlike the other families, which always
  // render the dot and toggle color via a modifier class). Its .processing
  // suffix is a harmless no-op modifier, not the state carrier.
  //
  // PROJECT-level dots (session-processing, mobile-project-processing,
  // hub-project-dot, icon-strip-status) never carry alert tone by design —
  // each surface's separate unread BADGE owns that affordance (see
  // sessionActivity's ignoreUnread contract) — so only 'other' + a
  // processing indicator are checked for those. SESSION-level dots
  // (mobile-session-processing, hub-recent-dot) DO carry full alert/other/
  // processing, matching the LOCKED alert > processing precedence.
  var families = [
    { file: "lib/public/css/sidebar.css", base: "session-processing", processingIsBareClass: true, projectLevel: true },
    { file: "lib/public/css/mobile-nav.css", base: "mobile-project-processing", processingIsBareClass: true, projectLevel: true },
    { file: "lib/public/css/mobile-nav.css", base: "mobile-session-processing", processingIsBareClass: true, projectLevel: false },
    { file: "lib/public/css/home-hub.css", base: "hub-project-dot", processingIsBareClass: false, projectLevel: true },
    { file: "lib/public/css/home-hub.css", base: "hub-recent-dot", processingIsBareClass: false, projectLevel: false },
    { file: "lib/public/css/icon-strip.css", base: "icon-strip-status", processingIsBareClass: false, projectLevel: true },
  ];

  families.forEach(function (fam) {
    var css = readMod(fam.file);
    var states = fam.projectLevel ? ["other"] : ["alert", "other"];
    states.forEach(function (state) {
      var pattern = new RegExp("\\." + fam.base + "\\." + state + "\\s*[,{]");
      assert.match(
        css,
        pattern,
        fam.file + ": expected a ." + fam.base + "." + state + " rule (or selector list entry) — " +
        "the CSS families must share the same vocabulary indicatorClass() produces, not diverge"
      );
    });
    if (fam.processingIsBareClass) {
      var barePattern = new RegExp("\\." + fam.base + "\\s*[,{]");
      assert.match(css, barePattern, fam.file + ": expected a bare ." + fam.base + " rule");
    } else {
      var processingPattern = new RegExp("\\." + fam.base + "\\.processing\\s*[,{]");
      assert.match(css, processingPattern, fam.file + ": expected a ." + fam.base + ".processing rule");
    }
  });
});

// ---------------------------------------------------------------------------
// 8. CI ABSENCE INVARIANT #4: every literal message type ever passed to
//    sendAndRecord(session, { type: "..." }) across the server (lib/*.js,
//    excluding node_modules/test) appears as a key in lib/ws-schema.js.
// ---------------------------------------------------------------------------

test("CI invariant: every sendAndRecord message type appears in lib/ws-schema.js", function () {
  var LIB_DIR = path.join(__dirname, "..", "lib");
  var schema = require("../lib/ws-schema").schema;
  var schemaKeys = Object.keys(schema);

  var foundTypes = new Set();
  var typeRe = /sendAndRecord\s*\(\s*[a-zA-Z0-9_.]+\s*,\s*\{[^}]*?\btype\s*:\s*["']([a-zA-Z0-9_]+)["']/g;

  function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
      var full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "public") return;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        var src = fs.readFileSync(full, "utf8");
        var m;
        typeRe.lastIndex = 0;
        while ((m = typeRe.exec(src)) !== null) {
          foundTypes.add(m[1]);
        }
      }
    });
  }
  walk(LIB_DIR);

  var missing = Array.from(foundTypes).filter(function (t) { return schemaKeys.indexOf(t) === -1; });
  assert.deepStrictEqual(
    missing,
    [],
    "sendAndRecord() sends a message type with no lib/ws-schema.js entry: " + JSON.stringify(missing)
  );
  // Sanity: the scan actually found a meaningful number of types, so an
  // empty `missing` isn't a false-positive from a broken walk/regex.
  assert.ok(foundTypes.size > 20, "expected to discover a substantial number of sendAndRecord message types, found " + foundTypes.size);
});

// activity-session-list-projection-lr-5edd64.test.js
//
// lr-5edd64 (8th recurrence). MILLER's three-pass diagnosis on this task
// (comments #1-#3) established:
//   - session.isProcessing (server) and store.processing (client) were TWO
//     INDEPENDENT state sources with no single authority — comment #2,
//     proof by enumeration: 25 raw isProcessing writers vs 2 registry
//     acquire/release call sites, so a getter over the token registry
//     (this task's superseded recommendation #1) would relocate the defect
//     into a NEW stuck-OFF on ~23 non-tool paths, not fix it.
//   - RECOMMENDATION #2 (implemented here): delete store.processing as an
//     independently-written client-local latch; make it a pure PROJECTION
//     of server-authoritative per-session state.
//   - comment #3's key structural fact: session_list ALREADY carries
//     per-session isProcessing to EVERY client regardless of which session
//     that client currently has focused/bound
//     (lib/sessions.js broadcastSessionList/mapSessionForClient is not
//     scoped by ws._clagenticActiveSession the way status/done/auth_required
//     sends are) — so a client whose focused session's activity edge was
//     dropped by that server-side routing filter (comment #3's "case A")
//     still receives the correct isProcessing value on the very next
//     session_list broadcast. The transcript footer previously declined to
//     derive from it, reading the client-local latch instead — THAT is the
//     defect this file's REQUIRED assertion demonstrates and closes.
//
// PEACHES BLOCKING review (PR #410, finding 3): the original version of
// this file defined its own applySessionListProjection() that
// REIMPLEMENTED the handler inline, then asserted against that copy — a
// behavioral assertion that would PASS on pre-fix code, since only the
// (separate) source-text CI invariant below would catch a regression.
// That reproduces the exact blind spot that let seven prior fixes ship:
// the previous 16-test suite was fully behavioral and still blind because
// it tested the wrong thing.
//
// FIX: app-messages.js's session_list handler no longer inlines the
// derivation. It calls activity-state.js's deriveSessionListProcessing()
// (a pure, DOM-free function — extracted specifically for this reason).
// This file imports and drives THAT REAL, PRODUCTION function directly —
// not a reimplementation of it. app-messages.js itself remains unimportable
// in a plain Node test process (its import graph reaches app-favicon.js,
// which reaches the theme.js<->markdown.js circular-import hazard — see
// activity-latch-lr-96e7da.test.js's header comment for the mechanism);
// that constraint is unchanged and out of this task's scope to repair. The
// CI invariant below pins that app-messages.js's handler actually CALLS
// deriveSessionListProcessing() (and applies its result to the store)
// rather than reimplementing the derivation inline again in the future.
//
// VERIFIED FAILS ON PRE-FIX CODE: with the fix's { ignoreUnread: true }
// removed from deriveSessionListProcessing's sessionActivity() call
// (restoring the pre-fix behavior — unread flips the footer on
// regardless of isProcessing), the new "unread alone must not pin the
// footer active" test below fails as expected; restoring the fix passes
// it again. See that test for the specific assertion.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var { pathToFileURL } = require("url");

var STORE_URL = pathToFileURL(
  path.join(__dirname, "..", "lib", "public", "modules", "store.js")
).href;
var ACTIVITY_STATE_URL = pathToFileURL(
  path.join(__dirname, "..", "lib", "public", "modules", "activity-state.js")
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

// Applies the REAL production projection (activity-state.js's
// deriveSessionListProcessing) to the REAL store, exactly as
// app-messages.js's session_list handler does — no reimplementation.
function applyRealSessionListProjection(store, deriveSessionListProcessing, sessions) {
  var activeId = store.get("activeSessionId");
  var projection = deriveSessionListProcessing(sessions, activeId);
  if (projection.found) {
    store.set({ processing: projection.active });
  }
}

test("REQUIRED (comment #3): a session_list entry with isProcessing=true renders an active indicator for the client's own session that never received a push edge — this is the exact case that fails on pre-fix code", { timeout: 10000 }, function () {
  return Promise.all([import(STORE_URL), import(ACTIVITY_STATE_URL)]).then(function (mods) {
    var s = mods[0];
    var activityState = mods[1];
    // 'processing' starts false — no status:"processing" push edge was ever
    // applied to this client for this session (comment #3 case A: the
    // server-side ws._clagenticActiveSession filter dropped it before
    // shouldApplyActivityEdge ever ran client-side).
    s.createStore({ processing: false, activeSessionId: "sess-A" });

    var footerActive = false;
    s.store.subscribe(["processing"], function (state, prev) {
      if (state.processing === prev.processing) return;
      footerActive = !!state.processing; // mirrors app-favicon.js's setActivity(!!state.processing)
    });

    // The next session_list broadcast — which reaches this client
    // regardless of focus, per comment #3 — carries the true server state
    // for the session this client has focused.
    var sessionListMsg = {
      sessions: [
        { id: "sess-A", isProcessing: true, unread: 0 },
        { id: "sess-B", isProcessing: false, unread: 0 },
      ],
    };
    applyRealSessionListProjection(s.store, activityState.deriveSessionListProcessing, sessionListMsg.sessions);

    assert.equal(
      footerActive,
      true,
      "session_list's per-session isProcessing must drive the footer projection even though no push edge ever raised it for this client — this is the defect MILLER's comment #3 diagnosed and this file demonstrably fails on pre-fix code (session_list previously never touched store.processing at all)"
    );
  });
});

test("session_list projection: an idle entry for the focused session drives the footer to inactive, even if it happened to be stale-true", { timeout: 10000 }, function () {
  return Promise.all([import(STORE_URL), import(ACTIVITY_STATE_URL)]).then(function (mods) {
    var s = mods[0];
    var activityState = mods[1];
    s.createStore({ processing: true, activeSessionId: "sess-A" });

    var footerActive = true;
    s.store.subscribe(["processing"], function (state, prev) {
      if (state.processing === prev.processing) return;
      footerActive = !!state.processing;
    });

    applyRealSessionListProjection(s.store, activityState.deriveSessionListProcessing, [
      { id: "sess-A", isProcessing: false, unread: 0 },
    ]);

    assert.equal(footerActive, false, "an idle session_list entry must clear a stale-true projection — the inverse (stuck-ON) edge this redesign also closes");
  });
});

test("session_list projection: entries for OTHER sessions never affect the focused session's projection (no cross-session bleed)", { timeout: 10000 }, function () {
  return Promise.all([import(STORE_URL), import(ACTIVITY_STATE_URL)]).then(function (mods) {
    var s = mods[0];
    var activityState = mods[1];
    s.createStore({ processing: false, activeSessionId: "sess-FOCUSED" });

    var transitions = 0;
    s.store.subscribe(["processing"], function (state, prev) {
      if (state.processing === prev.processing) return;
      transitions++;
    });

    applyRealSessionListProjection(s.store, activityState.deriveSessionListProcessing, [
      { id: "sess-FOCUSED", isProcessing: false, unread: 0 },
      { id: "sess-BACKGROUND", isProcessing: true, unread: 0 },
    ]);

    assert.equal(s.store.get("processing"), false, "a background session's isProcessing must never leak into the focused session's projection");
    assert.equal(transitions, 0, "no spurious transition when the focused session's own value is unchanged");
  });
});

test("session_list projection: unchanged value does not fire the footer subscriber (lr-9bcd7b's changed-flag bounding, preserved)", { timeout: 10000 }, function () {
  return Promise.all([import(STORE_URL), import(ACTIVITY_STATE_URL)]).then(function (mods) {
    var s = mods[0];
    var activityState = mods[1];
    s.createStore({ processing: true, activeSessionId: "sess-A" });

    var fireCount = 0;
    s.store.subscribe(["processing"], function (state, prev) {
      if (state.processing === prev.processing) return;
      fireCount++;
    });

    // Broadcast again with the SAME true value (e.g. a routine roster
    // refresh mid-turn) — must not re-fire the subscriber.
    applyRealSessionListProjection(s.store, activityState.deriveSessionListProcessing, [
      { id: "sess-A", isProcessing: true, unread: 0 },
    ]);

    assert.equal(fireCount, 0, "an unchanged projected value must not fire a spurious transition — store.set()'s own changed-flag check (store.js) plus the subscriber's own guard both bound this");
  });
});

test("PEACHES finding 2 (BLOCKING, this task's 8th recurrence): unread alone, with isProcessing=false, must NOT pin the footer active — the transcript footer is a turn-running indicator, not an unread-alert surface", { timeout: 10000 }, function () {
  return Promise.all([import(STORE_URL), import(ACTIVITY_STATE_URL)]).then(function (mods) {
    var s = mods[0];
    var activityState = mods[1];
    s.createStore({ processing: false, activeSessionId: "sess-A" });

    var footerActive = false;
    s.store.subscribe(["processing"], function (state, prev) {
      if (state.processing === prev.processing) return;
      footerActive = !!state.processing;
    });

    // isProcessing: false, unread: 1 — sessionActivity()'s LOCKED
    // alert > processing precedence makes .active true here UNLESS the
    // projection passes { ignoreUnread: true }. This is the exact
    // operator-reported symptom: "notifications when it's idle" —
    // a session with an unread message but no turn running lighting the
    // processing dot. Verified: reverting deriveSessionListProcessing's
    // { ignoreUnread: true } back out reproduces this test failing
    // (footerActive becomes true) against otherwise-unchanged code.
    applyRealSessionListProjection(s.store, activityState.deriveSessionListProcessing, [
      { id: "sess-A", isProcessing: false, unread: 1 },
    ]);

    assert.equal(
      footerActive,
      false,
      "unread with isProcessing=false must not activate the footer projection — got true, meaning the alert/unread rollup leaked into the turn-running indicator"
    );
    assert.equal(s.store.get("processing"), false);
  });
});

test("session_list projection: isProcessing=true together with unread>0 still activates the footer (processing itself, not the alert, drives it)", { timeout: 10000 }, function () {
  return Promise.all([import(STORE_URL), import(ACTIVITY_STATE_URL)]).then(function (mods) {
    var s = mods[0];
    var activityState = mods[1];
    s.createStore({ processing: false, activeSessionId: "sess-A" });

    applyRealSessionListProjection(s.store, activityState.deriveSessionListProcessing, [
      { id: "sess-A", isProcessing: true, unread: 3 },
    ]);

    assert.equal(s.store.get("processing"), true, "isProcessing=true must still activate the footer even when unread is also nonzero — ignoreUnread suppresses the ALERT contribution, not the processing one");
  });
});

test("deriveSessionListProcessing: activeSessionId not present in the list -> found:false, caller must not touch the store", { timeout: 10000 }, function () {
  return import(ACTIVITY_STATE_URL).then(function (activityState) {
    var result = activityState.deriveSessionListProcessing(
      [{ id: "sess-OTHER", isProcessing: true, unread: 0 }],
      "sess-MISSING"
    );
    assert.equal(result.found, false);
  });
});

test("deriveSessionListProcessing: null activeSessionId -> found:false (mirrors the handler's activeId != null guard)", { timeout: 10000 }, function () {
  return import(ACTIVITY_STATE_URL).then(function (activityState) {
    var result = activityState.deriveSessionListProcessing(
      [{ id: "sess-A", isProcessing: true, unread: 0 }],
      null
    );
    assert.equal(result.found, false);
  });
});

// ---------------------------------------------------------------------------
// CI invariant: app-messages.js's session_list handler actually calls the
// real, pure deriveSessionListProcessing() (activity-state.js), not a
// reimplemented inline derivation — which would both violate
// activity-state-lr-66c118.test.js's CI invariant #2 (.isProcessing reads
// confined to activity-state.js plus one documented exception) AND put this
// file back in the "tests a copy, not the code that ships" state PEACHES
// flagged (finding 3).
// ---------------------------------------------------------------------------

test("CI invariant: app-messages.js's session_list handler derives the 'processing' projection via activity-state.js's deriveSessionListProcessing(), scoped to the active session", function () {
  var src = stripLineComments(readMod("lib/public/modules/app-messages.js"));
  assert.match(
    src,
    /import\s*\{[^}]*\bderiveSessionListProcessing\b[^}]*\}\s*from\s*['"]\.\/activity-state\.js['"]/,
    "app-messages.js must import deriveSessionListProcessing from activity-state.js"
  );
  var idx = src.indexOf("session_list: function");
  assert.ok(idx !== -1, "expected a session_list handler in app-messages.js");
  var handlerBody = src.slice(idx, src.indexOf("\n  },", idx) + 5);
  assert.match(
    handlerBody,
    /deriveSessionListProcessing\(/,
    "session_list must derive the projection via deriveSessionListProcessing(...) — not a raw .isProcessing read or a hand-inlined derivation"
  );
  assert.match(
    handlerBody,
    /store\.set\(\{\s*processing:/,
    "session_list must apply the derived projection's result to store 'processing'"
  );
  assert.match(
    handlerBody,
    /activeSessionId/,
    "the projection must be scoped to the client's activeSessionId, not applied blind to every entry"
  );
});

test("CI invariant: activity-latch.js no longer exports the deleted client-local-latch defenses (createActivityStaleBackstop, the lr-58c813 client-side ledger) — dead code left behind would become load-bearing again", function () {
  // stripLineComments: the module header EXPLAINS what was deleted (by
  // name) as context for the next reader — same established convention as
  // every other absence-invariant in this suite (see this file's header /
  // activity-state-lr-66c118.test.js's own precedent). This proves absence
  // of a real declaration/call, not absence of the string in prose.
  var src = stripLineComments(readMod("lib/public/modules/activity-latch.js"));
  assert.doesNotMatch(src, /createActivityStaleBackstop/, "the staleness backstop existed solely to defend the deleted client-local latch");
  assert.doesNotMatch(src, /recordActivityEdgeDecision/, "the lr-58c813 CLIENT-side edge ledger existed solely to observe the deleted latch (the SERVER-side lr-58c813 divergence probe in lib/sdk-bridge.js is unrelated and untouched)");
  assert.doesNotMatch(src, /getActivityEdgeLedger/, "the ledger's read accessor must be gone along with the ledger itself");
  assert.match(src, /export function shouldApplyActivityEdge/, "shouldApplyActivityEdge itself must remain — still used for session-scoping sessionIsProcessing/todo-compaction, a genuinely separate concern from the deleted latch");
});

test("CI invariant: app-favicon.js no longer imports or constructs the deleted staleness backstop", function () {
  var src = stripLineComments(readMod("lib/public/modules/app-favicon.js"));
  assert.doesNotMatch(src, /createActivityStaleBackstop/, "app-favicon.js must not import or reference the deleted backstop");
});

test("CI invariant: setStatus's 'connected' branch no longer independently zeroes 'processing' — only the disconnect branch (defensive: no server state backs a stale value while offline) and the 'processing' push branch touch it", function () {
  var connSrc = stripLineComments(readMod("lib/public/modules/app-connection.js"));
  var fnStart = connSrc.indexOf("export function setStatus");
  assert.ok(fnStart !== -1, "expected setStatus to be defined in app-connection.js");
  var fnBody = connSrc.slice(fnStart, connSrc.indexOf("\n}", fnStart) + 2);
  var connectedBranchStart = fnBody.indexOf('status === "connected"');
  var connectedBranchEnd = fnBody.indexOf("} else", connectedBranchStart);
  var connectedBranch = fnBody.slice(connectedBranchStart, connectedBranchEnd);
  assert.doesNotMatch(
    connectedBranch,
    /processing/,
    "the 'connected' branch must not touch 'processing' — the very next session_switched (sent unconditionally on every connect/reconnect) re-derives it, so force-zeroing first only risked a flash-then-correct"
  );
});

test("CI invariant: app-projects.js's resetClientState no longer force-zeroes 'processing' — it runs BEFORE session_switched's own projection is applied (reordered, PEACHES finding 1 fix) and must not stomp the correct projected value", function () {
  var projectsSrc = stripLineComments(readMod("lib/public/modules/app-projects.js"));
  var fnStart = projectsSrc.indexOf("export function resetClientState");
  assert.ok(fnStart !== -1, "expected resetClientState to be defined in app-projects.js");
  var fnBody = projectsSrc.slice(fnStart, projectsSrc.indexOf("\n}", fnStart) + 2);
  assert.doesNotMatch(
    fnBody,
    /store\.set\(\{\s*processing:\s*false\s*\}\)/,
    "resetClientState must not force-zero 'processing' independently of the session_list/session_switched projection"
  );
});

// ---------------------------------------------------------------------------
// CI invariant (PEACHES finding 1, lr-5edd64 8th recurrence): session_switched
// must apply its 'processing' projection AFTER calling resetClientState(),
// not before. Ordering matters here in a way source review alone can miss:
// resetClientState() nulls the footer widget's DOM ref (setActivityEl(null))
// and wipes the transcript DOM. If the projection's store.set() ran first,
// its synchronous subscriber (app-favicon.js's initActivityFooter) could
// raise the widget against the OUTGOING session's about-to-be-wiped DOM,
// stranding a stale ref that a later unchanged value would never repair
// (store.set()'s changed-flag bounding, lr-9bcd7b) — stuck OFF forever, the
// inverse of the stuck-ON failure this redesign exists to close.
// ---------------------------------------------------------------------------

test("CI invariant: session_switched applies its 'processing' projection AFTER resetClientState(), not before", function () {
  var src = stripLineComments(readMod("lib/public/modules/app-messages.js"));
  var idx = src.indexOf("session_switched: function");
  assert.ok(idx !== -1, "expected a session_switched handler in app-messages.js");
  var handlerBody = src.slice(idx, src.indexOf("\n  },", idx) + 5);

  var resetIdx = handlerBody.indexOf("resetClientState()");
  assert.ok(resetIdx !== -1, "expected session_switched to call resetClientState()");

  var projectionRe = /store\.set\(\{\s*processing:\s*store\.get\(['"]sessionIsProcessing['"]\)\s*\}\)/;
  var projectionMatch = projectionRe.exec(handlerBody);
  assert.ok(projectionMatch, "expected session_switched to apply store.set({ processing: store.get('sessionIsProcessing') })");

  assert.ok(
    projectionMatch.index > resetIdx,
    "the 'processing' projection must be applied AFTER resetClientState() — found it at index " +
      projectionMatch.index + ", resetClientState() call at index " + resetIdx
  );
});

// ---------------------------------------------------------------------------
// PEACHES BLOCKING (PR #410, new finding from the finding-1 reorder above),
// HOLDEN-verified in source, this task's 9th recurrence:
//
// resetClientState() nulls the footer widget's DOM ref (setActivityEl(null))
// independently of any store.processing value change. The ONLY prior repair
// path was app-favicon.js's initActivityFooter subscriber, which is gated on
// ['processing'] actually CHANGING (store.js's changed-flag bounding). On a
// TRUE -> TRUE session switch (outgoing session processing, incoming session
// ALSO processing), store.set({ processing: true }) after an already-true
// value is a no-op transition — the subscriber never fires, the ref
// resetClientState() just nulled is never repaired, and the footer is stuck
// OFF for that session and every later broadcast carrying the same
// unchanged true value (identical mechanism to the finding-1 stuck-OFF this
// task already closed once, inverse edge).
//
// FIX: app-favicon.js's reconcileActivityFooter() renders the footer from
// current store.processing UNCONDITIONALLY — callers (session_list,
// session_switched) invoke it explicitly right after applying their
// projection's store.set(), not gated on whether that store.set() changed
// anything. These CI invariants pin that the unconditional call is actually
// wired at both call sites (source-inspection, per this suite's own
// app-favicon.js-is-not-importable constraint — see header above) and a
// behavioral test below proves the OLD subscriber-only shape truly misses
// the true->true case using the real store.js + activity-state.js.
// ---------------------------------------------------------------------------

test("REQUIRED (9th recurrence): a value-change-only subscriber (the pre-fix shape) does NOT fire on a true->true session switch — demonstrates the defect this fix closes, using the real store.js", { timeout: 10000 }, function () {
  return import(STORE_URL).then(function (s) {
    // Mirrors app-favicon.js's ORIGINAL initActivityFooter body exactly:
    // gated on state.processing !== prev.processing.
    s.createStore({ processing: true });
    var subscriberFired = false;
    s.store.subscribe(["processing"], function (state, prev) {
      if (state.processing === prev.processing) return;
      subscriberFired = true;
    });

    // Outgoing session was processing:true; resetClientState() (not
    // modeled here — it touches the DOM) nulls the footer ref independently
    // of this store update. The incoming session is ALSO processing:true.
    s.store.set({ processing: true });

    assert.equal(
      subscriberFired,
      false,
      "a value-change-gated subscriber must NOT fire when the projected value is unchanged (true->true) — this is exactly why a ref nulled by resetClientState() outside of any store.set() can never be repaired by that subscriber alone"
    );
  });
});

test("REQUIRED (9th recurrence): the false->true case (finding 1) DOES fire the value-change subscriber, so a naive read of this file could not silently reintroduce finding 1 while missing the true->true fix", { timeout: 10000 }, function () {
  return import(STORE_URL).then(function (s) {
    s.createStore({ processing: false });
    var subscriberFired = false;
    s.store.subscribe(["processing"], function (state, prev) {
      if (state.processing === prev.processing) return;
      subscriberFired = true;
    });

    s.store.set({ processing: true });

    assert.equal(subscriberFired, true, "false->true must still fire the value-change subscriber — this case was never broken, only true->true was");
  });
});

test("CI invariant: app-favicon.js's reconcileActivityFooter() renders from current store.processing UNCONDITIONALLY — not gated on a store.processing value transition", function () {
  var src = stripLineComments(readMod("lib/public/modules/app-favicon.js"));
  assert.match(
    src,
    /export function reconcileActivityFooter\s*\(/,
    "app-favicon.js must export reconcileActivityFooter"
  );
  var fnStart = src.indexOf("export function reconcileActivityFooter");
  var fnBody = src.slice(fnStart, src.indexOf("\n}", fnStart) + 2);
  assert.doesNotMatch(
    fnBody,
    /prev\.processing/,
    "reconcileActivityFooter must not compare against a previous value — it renders unconditionally from current state, unlike initActivityFooter's value-change-gated subscriber"
  );
  assert.match(
    fnBody,
    /store\.get\(['"]processing['"]\)/,
    "reconcileActivityFooter must read current store.processing directly"
  );
});

test("CI invariant: session_list's 'processing' projection calls reconcileActivityFooter() unconditionally, after applying the projection's store.set()", function () {
  var src = stripLineComments(readMod("lib/public/modules/app-messages.js"));
  assert.match(
    src,
    /import\s*\{[^}]*\breconcileActivityFooter\b[^}]*\}\s*from\s*['"]\.\/app-favicon\.js['"]/,
    "app-messages.js must import reconcileActivityFooter from app-favicon.js"
  );
  var idx = src.indexOf("session_list: function");
  assert.ok(idx !== -1, "expected a session_list handler in app-messages.js");
  var handlerBody = src.slice(idx, src.indexOf("\n  },", idx) + 5);
  var setIdx = handlerBody.search(/store\.set\(\{\s*processing:/);
  assert.ok(setIdx !== -1, "expected session_list to apply the 'processing' projection via store.set()");
  var reconcileIdx = handlerBody.indexOf("reconcileActivityFooter()", setIdx);
  assert.ok(
    reconcileIdx !== -1 && reconcileIdx > setIdx,
    "session_list must call reconcileActivityFooter() after applying its 'processing' projection's store.set() — an unconditional render, not left to the value-change subscriber alone"
  );
});

test("CI invariant: session_switched's 'processing' projection calls reconcileActivityFooter() unconditionally, after applying the projection's store.set()", function () {
  var src = stripLineComments(readMod("lib/public/modules/app-messages.js"));
  var idx = src.indexOf("session_switched: function");
  assert.ok(idx !== -1, "expected a session_switched handler in app-messages.js");
  var handlerBody = src.slice(idx, src.indexOf("\n  },", idx) + 5);
  var setIdx = handlerBody.search(/store\.set\(\{\s*processing:\s*store\.get\(['"]sessionIsProcessing['"]\)\s*\}\)/);
  assert.ok(setIdx !== -1, "expected session_switched to apply store.set({ processing: store.get('sessionIsProcessing') })");
  var reconcileIdx = handlerBody.indexOf("reconcileActivityFooter()", setIdx);
  assert.ok(
    reconcileIdx !== -1 && reconcileIdx > setIdx,
    "session_switched must call reconcileActivityFooter() after applying its 'processing' projection's store.set() — this is the fix for the true->true stuck-OFF case (9th recurrence), not left to the value-change subscriber alone"
  );
});

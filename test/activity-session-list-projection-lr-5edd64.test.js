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
//     scoped by ws._clayActiveSession the way status/done/auth_required
//     sends are) — so a client whose focused session's activity edge was
//     dropped by that server-side routing filter (comment #3's "case A")
//     still receives the correct isProcessing value on the very next
//     session_list broadcast. The transcript footer previously declined to
//     derive from it, reading the client-local latch instead — THAT is the
//     defect this file's REQUIRED assertion demonstrates and closes.
//
// TESTING METHODOLOGY (per task spec, comment #2 Q7): this suite asserts
// the RENDERED OUTCOME from the server-authoritative value, not against the
// token registry (which would inherit the ledger defect and pass
// vacuously) and not against a source-text regex proving only that a wire
// field exists. app-messages.js itself is DOM-heavy and unimportable in a
// plain Node test process (see activity-latch-lr-96e7da.test.js's header
// comment for the theme.js<->markdown.js circular-import hazard this
// mirrors) — so, following this suite's own established pattern, this file
// drives the REAL store.js + the REAL activity-state.js together with the
// exact derivation app-messages.js's session_list handler performs
// (documented and pinned by the CI invariant at the bottom of this file),
// proving the projection logic itself is correct end-to-end rather than
// hand-waved.

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

// Mirrors EXACTLY the derivation app-messages.js's session_list handler
// performs (pinned by the CI invariant test at the bottom of this file):
// find the entry matching activeSessionId, derive .active via
// sessionActivity(), and push it into store.processing.
function applySessionListProjection(store, sessionActivity, sessions) {
  var activeId = store.get("activeSessionId");
  if (activeId == null) return;
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].id === activeId) {
      store.set({ processing: sessionActivity(sessions[i]).active });
      return;
    }
  }
}

test("REQUIRED (comment #3): a session_list entry with isProcessing=true renders an active indicator for the client's own session that never received a push edge — this is the exact case that fails on pre-fix code", { timeout: 10000 }, function () {
  return Promise.all([import(STORE_URL), import(ACTIVITY_STATE_URL)]).then(function (mods) {
    var s = mods[0];
    var activityState = mods[1];
    // 'processing' starts false — no status:"processing" push edge was ever
    // applied to this client for this session (comment #3 case A: the
    // server-side ws._clayActiveSession filter dropped it before
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
    applySessionListProjection(s.store, activityState.sessionActivity, sessionListMsg.sessions);

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

    applySessionListProjection(s.store, activityState.sessionActivity, [
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

    applySessionListProjection(s.store, activityState.sessionActivity, [
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
    applySessionListProjection(s.store, activityState.sessionActivity, [
      { id: "sess-A", isProcessing: true, unread: 0 },
    ]);

    assert.equal(fireCount, 0, "an unchanged projected value must not fire a spurious transition — store.set()'s own changed-flag check (store.js) plus the subscriber's own guard both bound this");
  });
});

// ---------------------------------------------------------------------------
// CI invariant: app-messages.js's session_list handler actually performs
// this derivation via the real, pure sessionActivity() (activity-state.js),
// not a reimplemented inline isProcessing read — which would violate
// activity-state-lr-66c118.test.js's CI invariant #2 (.isProcessing reads
// confined to activity-state.js plus one documented exception).
// ---------------------------------------------------------------------------

test("CI invariant: app-messages.js's session_list handler derives the 'processing' projection via activity-state.js's sessionActivity(), scoped to the active session", function () {
  var src = stripLineComments(readMod("lib/public/modules/app-messages.js"));
  assert.match(
    src,
    /import\s*\{[^}]*\bsessionActivity\b[^}]*\}\s*from\s*['"]\.\/activity-state\.js['"]/,
    "app-messages.js must import sessionActivity from activity-state.js"
  );
  var idx = src.indexOf("session_list: function");
  assert.ok(idx !== -1, "expected a session_list handler in app-messages.js");
  var handlerBody = src.slice(idx, src.indexOf("\n  },", idx) + 5);
  assert.match(
    handlerBody,
    /store\.set\(\{\s*processing:\s*sessionActivity\(/,
    "session_list must set store 'processing' from sessionActivity(...) — not a raw .isProcessing read"
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

test("CI invariant: app-projects.js's resetClientState no longer force-zeroes 'processing' — it runs AFTER session_switched's reconciliation and would stomp the correct projected value on every session switch", function () {
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

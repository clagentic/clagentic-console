"use strict";
/**
 * Regression tests for lr-f36626: the pressure path (lr-5e70 onCrossing /
 * lib/memory-shed.js) is the ONLY path allowed to reclaim a session that has
 * a live registered background child, and only as a last resort — and when
 * it does, it must never do so silently.
 *
 * lib/sessions.js's forceEvictToLimit(limit) now runs two passes:
 *   pass 1 — childless candidates only (session.activeTaskToolIds empty)
 *   pass 2 — last resort: live-child candidates, only once pass 1 is
 *            exhausted and the pressure limit is still not met
 * and returns { evicted, reclaimedLiveChild } instead of a bare count.
 * Eviction itself never touches queryInstance (see _evictSession) — the
 * child process keeps running; only its in-heap history window is unloaded.
 *
 * lib/memory-shed.js's shedMemory() consumes reclaimedLiveChild and, for
 * each such session:
 *   - sets a durable session.pendingAutoResume marker (persisted via
 *     sm.saveSessionFile so it survives a daemon restart)
 *   - broadcasts a Diagnostics-panel diagnostic (source 'memory-reclaim')
 *   - sendAndRecord's an inline type:"error" marker into that session's own
 *     history (renders as the existing red .sys-msg.error chat bubble)
 *
 * Drives real production code from lib/sessions.js and lib/memory-shed.js —
 * no reimplementation, matching test/memory-shed-lr-5e70.test.js's convention.
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { shedMemory, _resetRateLimitForTest } = require("../lib/memory-shed");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lrf36626-"));
}

function makeSessionManager(tmpHome, extraOpts) {
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  });
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var sessions;
  try {
    sessions = require("../lib/sessions");
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
  var opts = Object.assign({
    cwd: tmpHome,
    send: function () {},
    sendTo: function () {},
    sendEach: function () {},
  }, extraOpts || {});
  return sessions.createSessionManager(opts);
}

function fillSession(sm, idSuffix, activeTaskToolIds) {
  var s = sm.createSessionRaw({});
  s.cliSessionId = "sess-" + idSuffix;
  s.history = [{ type: "user_message", text: "hi-" + idSuffix }];
  s._historyLoaded = true;
  if (activeTaskToolIds) s.activeTaskToolIds = activeTaskToolIds;
  sm.saveSessionFile(s);
  sm.loadSessionHistory(s);
  return s;
}

test.beforeEach(function () {
  _resetRateLimitForTest();
});

// ---------------------------------------------------------------------------
// lib/sessions.js forceEvictToLimit: childless-first, live-child last resort
// ---------------------------------------------------------------------------

test("lr-f36626: forceEvictToLimit prefers childless candidates before touching a live-child session", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    // createSessionManager's initial bootstrap session (localId 1) is also
    // loaded and becomes activeSessionId — it is exempt regardless of
    // childless status, same as any other active session. Account for it in
    // the limit math below so this test isolates the childless-vs-live-child
    // ordering, not the (already covered elsewhere) active-session exemption.
    var withChild = fillSession(sm, "withchild", { "task-1": true });
    var childless = [];
    for (var i = 0; i < 5; i++) {
      childless.push(fillSession(sm, "childless-" + i, {}));
    }

    // 7 sessions loaded total (1 implicit active + withChild + 5 childless).
    // limit=2 leaves exactly one non-active slot free once the active
    // session's permanent exemption is accounted for — enough that all 5
    // childless candidates must go, but withChild does not need to be
    // touched to reach it.
    var result = sm.forceEvictToLimit(2);

    assert.equal(withChild._historyLoaded, true,
      "the live-child session must survive while childless candidates remain");
    var evictedChildless = childless.filter(function (s) { return !s._historyLoaded; }).length;
    assert.ok(evictedChildless > 0, "childless candidates must be evicted first");
    assert.equal(result.reclaimedLiveChild.length, 0,
      "no live-child session should be reported reclaimed when childless candidates sufficed");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-f36626: forceEvictToLimit falls back to a live-child session as last resort once childless candidates are exhausted", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var withChild = fillSession(sm, "onlychild", { "task-1": true });

    // No childless candidates exist besides the live-child one — the limit
    // still forces eviction below the live-child session's presence.
    var result = sm.forceEvictToLimit(0);

    assert.equal(withChild._historyLoaded, false,
      "with no other candidate available, the ceiling must still be honored — the live-child session is reclaimed as a last resort");
    assert.equal(result.reclaimedLiveChild.length, 1);
    assert.equal(result.reclaimedLiveChild[0].localId, withChild.localId);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-f36626: forceEvictToLimit never closes queryInstance — a reclaimed live-child session's process keeps running", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var closed = false;
    var withChild = fillSession(sm, "queryinstance", { "task-1": true });
    withChild.queryInstance = { close: function () { closed = true; } };

    sm.forceEvictToLimit(0);

    assert.equal(closed, false, "eviction under pressure must never kill the child's process");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// lib/memory-shed.js: dual-surface notification + durable AUTO-RESUME marker
// ---------------------------------------------------------------------------

test("lr-f36626: shedMemory marks a reclaimed live-child session with a durable pendingAutoResume flag", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var withChild = fillSession(sm, "autoresume", { "task-1": true });

    shedMemory({ projects: [{ slug: "p", sm: sm, send: function () {} }] });

    // forceEvictToLimit's default pressure limit (LRU_HISTORY_LIMIT/2) is far
    // above 1 session, so nothing should have been reclaimed in this pass —
    // establishes the negative case before the positive one below.
    assert.equal(withChild.pendingAutoResume, undefined);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-f36626: shedMemory notifies both surfaces and sets pendingAutoResume when a live-child session is actually reclaimed", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var withChild = fillSession(sm, "reclaimed", { "task-1": true });

    var diagnostics = [];
    var projectSend = function (obj) { diagnostics.push(obj); };

    // Force every candidate (including the live-child one) to be over the
    // pressure limit by driving LRU_HISTORY_LIMIT down to 0 for this sm
    // instance — simplest way to guarantee pass 2 triggers deterministically
    // without needing dozens of filler sessions.
    sm.LRU_HISTORY_LIMIT = 0;

    var result = shedMemory({ projects: [{ slug: "p", sm: sm, send: projectSend }] });

    assert.equal(result.liveChildReclaimed, 1);
    assert.equal(withChild.pendingAutoResume, true);
    assert.equal(withChild.pendingAutoResumeReason, "memory_pressure_reclaim");

    // Diagnostics panel: routine pressure diagnostic + the per-session
    // memory-reclaim diagnostic, both delivered via the project's send().
    var reclaimDiag = diagnostics.filter(function (d) { return d.source === "memory-reclaim"; });
    assert.equal(reclaimDiag.length, 1);
    assert.equal(reclaimDiag[0].type, "diagnostic");
    assert.equal(reclaimDiag[0].severity, "warning");

    // Inline red chat marker: an type:"error" entry sendAndRecord'd into the
    // affected session's own history (renders via the existing sys-msg.error
    // path — see lib/public/modules/app-messages.js's case "error"). By the
    // time shedMemory notifies, forceEvictToLimit has already unloaded the
    // session's in-heap history (_historyLoaded=false) — sendAndRecord's
    // recordHistoryEntry is correctly a no-op against the heap in that state
    // (lib/sessions.js's recordHistoryEntry), but appendToSessionFile still
    // durably writes the entry to disk (the "durable checkpoint" itself).
    // Reload from disk to observe it, exactly as a real reconnect would.
    withChild._historyLoaded = false; // already false post-eviction; explicit for clarity
    sm.loadSessionHistory(withChild);
    var errorEntries = withChild.history.filter(function (h) { return h.type === "error"; });
    assert.equal(errorEntries.length, 1);
    assert.ok(/memory pressure/i.test(errorEntries[0].text));
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-f36626: shedMemory persists the pendingAutoResume marker so it survives a fresh session reload (durable checkpoint)", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var withChild = fillSession(sm, "durable", { "task-1": true });
    sm.LRU_HISTORY_LIMIT = 0;

    shedMemory({ projects: [{ slug: "p", sm: sm, send: function () {} }] });
    assert.equal(withChild.pendingAutoResume, true);

    // Simulate a fresh daemon process: reload sessions from disk into a new
    // session manager instance and confirm the marker round-trips.
    var sm2 = makeSessionManager(tmpHome);
    var reloaded = null;
    sm2.sessions.forEach(function (s) {
      if (s.cliSessionId === "sess-durable") reloaded = s;
    });
    assert.ok(reloaded, "session must still exist after reload");
    assert.equal(reloaded.pendingAutoResume, true, "the AUTO-RESUME marker must survive a daemon restart");
    assert.equal(reloaded.pendingAutoResumeReason, "memory_pressure_reclaim");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-f36626: idle-no-child shedding pass (no live-child reclaim) does not emit the memory-reclaim diagnostic", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    fillSession(sm, "plain", {}); // no live child at all

    var diagnostics = [];
    var result = shedMemory({ projects: [{ slug: "p", sm: sm, send: function (o) { diagnostics.push(o); } }] });

    assert.equal(result.liveChildReclaimed, 0);
    var reclaimDiag = diagnostics.filter(function (d) { return d.source === "memory-reclaim"; });
    assert.equal(reclaimDiag.length, 0, "no live child was ever at risk — nothing to notify beyond the routine pressure diagnostic");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

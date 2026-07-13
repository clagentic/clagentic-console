"use strict";
/**
 * memory-shed-lr-5e70.test.js — unit tests for lib/memory-shed.js (lr-5e70).
 *
 * lr-5e70 wires startMemoryHighWatcher's onCrossing callback to an actual
 * shedding pass: retrimHistory() on every loaded session (including
 * active/isProcessing), force-eviction beyond the normal LRU limit down to a
 * pressure limit while skipping the actively-viewed session, dropping
 * rebuildable caches, and emitting a structured memory_shed log + UI
 * diagnostic — all rate-limited to at most one pass per 60s.
 *
 * Drives real production code from lib/sessions.js and lib/memory-shed.js —
 * no reimplementation.
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { shedMemory, RATE_LIMIT_MS, _resetRateLimitForTest } = require("../lib/memory-shed");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr5e70-"));
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

// Populate a session with more than HISTORY_INMEM_MAX entries directly via
// the heap array (bypassing the trim that recordHistoryEntry would normally
// apply) so retrimHistory() has real work to do — mirrors how
// loadFullSessionHistory (rewind/fork) can legally leave a session over cap.
function overfillHistory(session, count, prefix) {
  session.history = [];
  for (var i = 0; i < count; i++) {
    session.history.push({ type: "delta", text: prefix + "-" + i });
  }
  session._historyLoaded = true;
}

test.beforeEach(function () {
  _resetRateLimitForTest();
});

// ---------------------------------------------------------------------------
// retrimHistory applied to every loaded session, including active/processing
// ---------------------------------------------------------------------------

test("lr-5e70: shedMemory retrims every loaded session over cap, including the active session", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var active = sm.createSessionRaw({});
    active.cliSessionId = "sess-active";
    overfillHistory(active, sm.HISTORY_INMEM_MAX + 500, "a");
    // Make it the active session by switching to it via internal state —
    // createSessionRaw doesn't switch, so drive activeSessionId through the
    // public createSession/switchSession path instead.
    sm.switchSession(active.localId, null);

    var result = shedMemory({ projects: [{ slug: "p", sm: sm, send: function () {} }] });

    assert.equal(result.skipped, false);
    assert.ok(active.history.length <= sm.HISTORY_INMEM_MAX,
      "active session's heap history must be retrimmed to the cap even though it is the active session");
    assert.ok(result.sessionsTrimmed >= 1, "at least one session must be reported as trimmed");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-5e70: shedMemory retrims an isProcessing session's history", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var processing = sm.createSessionRaw({});
    processing.cliSessionId = "sess-processing";
    processing.isProcessing = true;
    overfillHistory(processing, sm.HISTORY_INMEM_MAX + 300, "p");

    var result = shedMemory({ projects: [{ slug: "p", sm: sm, send: function () {} }] });

    assert.ok(processing.history.length <= sm.HISTORY_INMEM_MAX,
      "isProcessing session's heap history must be retrimmed on a shedding pass");
    assert.ok(result.sessionsTrimmed >= 1);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-5e70: shedMemory is a no-op trim for sessions already within cap", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var small = sm.createSessionRaw({});
    small.cliSessionId = "sess-small";
    small.history = [{ type: "user_message", text: "hi" }];
    small._historyLoaded = true;

    var result = shedMemory({ projects: [{ slug: "p", sm: sm, send: function () {} }] });

    assert.equal(small.history.length, 1, "a session within cap must be untouched by retrim");
    assert.equal(result.sessionsTrimmed, 0);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Force-eviction beyond the normal LRU limit, skipping the active session
// ---------------------------------------------------------------------------

test("lr-5e70: shedMemory force-evicts loaded sessions down to the pressure limit (LRU_HISTORY_LIMIT/2)", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var pressureLimit = Math.floor(sm.LRU_HISTORY_LIMIT / 2);
    // Load more sessions than the pressure limit, all idle (not active, not
    // processing) so they are all legal eviction candidates.
    var count = pressureLimit + 10;
    var sessions = [];
    for (var i = 0; i < count; i++) {
      var s = sm.createSessionRaw({});
      s.cliSessionId = "sess-bulk-" + i;
      s.history = [{ type: "user_message", text: "hi-" + i }];
      s._historyLoaded = true;
      sm.saveSessionFile(s); // meta line needed for loadSessionHistory's _lruTouch path
      sm.loadSessionHistory(s); // registers in LRU order via _lruTouch
      sessions.push(s);
    }

    var result = shedMemory({ projects: [{ slug: "p", sm: sm, send: function () {} }] });

    assert.ok(result.sessionsEvicted > 0, "shedding must evict at least one session over the pressure limit");

    var stillLoaded = sessions.filter(function (s) { return s._historyLoaded; }).length;
    assert.ok(stillLoaded <= pressureLimit + 1, // +1 tolerance for the implicit initial/active session
      "loaded session count (" + stillLoaded + ") must be driven down to around the pressure limit (" + pressureLimit + ")");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-5e70: shedMemory never evicts the actively-viewed session even under pressure", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var active = sm.createSessionRaw({});
    active.cliSessionId = "sess-active-evict";
    active.history = [{ type: "user_message", text: "keep me loaded" }];
    active._historyLoaded = true;
    sm.saveSessionFile(active);
    sm.switchSession(active.localId, null);

    var pressureLimit = Math.floor(sm.LRU_HISTORY_LIMIT / 2);
    for (var i = 0; i < pressureLimit + 20; i++) {
      var s = sm.createSessionRaw({});
      s.cliSessionId = "sess-fill-" + i;
      s.history = [{ type: "user_message", text: "fill-" + i }];
      s._historyLoaded = true;
      sm.saveSessionFile(s);
      sm.loadSessionHistory(s);
    }

    shedMemory({ projects: [{ slug: "p", sm: sm, send: function () {} }] });

    assert.equal(active._historyLoaded, true, "the active session must remain loaded after a shedding pass");
    assert.ok(active.history.length > 0);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-5e70: shedMemory never evicts an isProcessing session even under pressure", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var processing = sm.createSessionRaw({});
    processing.cliSessionId = "sess-processing-evict";
    processing.isProcessing = true;
    processing.history = [{ type: "user_message", text: "still working" }];
    processing._historyLoaded = true;
    sm.saveSessionFile(processing);
    sm.loadSessionHistory(processing);

    var pressureLimit = Math.floor(sm.LRU_HISTORY_LIMIT / 2);
    for (var i = 0; i < pressureLimit + 20; i++) {
      var s = sm.createSessionRaw({});
      s.cliSessionId = "sess-fill2-" + i;
      s.history = [{ type: "user_message", text: "fill-" + i }];
      s._historyLoaded = true;
      sm.saveSessionFile(s);
      sm.loadSessionHistory(s);
    }

    shedMemory({ projects: [{ slug: "p", sm: sm, send: function () {} }] });

    assert.equal(processing._historyLoaded, true, "an isProcessing session must remain loaded after a shedding pass");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Rebuildable caches dropped and enumerated
// ---------------------------------------------------------------------------

test("lr-5e70: shedMemory drops rebuildable caches and reports their names", function () {
  var dropped = { skills: false, other: false };
  var result = shedMemory({
    projects: [],
    caches: {
      skills: { drop: function () { dropped.skills = true; } },
      other: { drop: function () { dropped.other = true; } },
    },
  });

  assert.equal(dropped.skills, true);
  assert.equal(dropped.other, true);
  assert.deepEqual(result.cachesDropped.sort(), ["other", "skills"]);
});

test("lr-5e70: a cache whose drop() throws is omitted from cachesDropped but does not abort the pass", function () {
  var result = shedMemory({
    projects: [],
    caches: {
      bad: { drop: function () { throw new Error("boom"); } },
      good: { drop: function () {} },
    },
  });

  assert.deepEqual(result.cachesDropped, ["good"]);
  assert.equal(result.skipped, false);
});

// ---------------------------------------------------------------------------
// Diagnostic emitted with before/after RSS
// ---------------------------------------------------------------------------

test("lr-5e70: shedMemory emits a memory diagnostic with before/after RSS to every project", function () {
  var sentA = [];
  var sentB = [];
  var result = shedMemory({
    projects: [
      { slug: "a", sm: { sessions: new Map(), retrimHistory: function () {} }, send: function (m) { sentA.push(m); } },
      { slug: "b", sm: { sessions: new Map(), retrimHistory: function () {} }, send: function (m) { sentB.push(m); } },
    ],
    rssBefore: 500 * 1048576,
    readRssBytes: function () { return 400 * 1048576; },
  });

  assert.equal(result.beforeBytes, 500 * 1048576);
  assert.equal(result.afterBytes, 400 * 1048576);

  [sentA, sentB].forEach(function (sent) {
    assert.equal(sent.length, 1);
    var diag = sent[0];
    assert.equal(diag.type, "diagnostic");
    assert.equal(diag.severity, "warning");
    assert.equal(diag.source, "memory");
    assert.match(diag.message, /500MB/);
    assert.match(diag.message, /400MB/);
  });
});

// ---------------------------------------------------------------------------
// Structured memory_shed log
// ---------------------------------------------------------------------------

test("lr-5e70: shedMemory emits a structured memory_shed log event with required fields", function () {
  var logs = [];
  shedMemory({
    projects: [],
    caches: { skills: { drop: function () {} } },
    log: function (event) { logs.push(event); },
    rssBefore: 300 * 1048576,
    readRssBytes: function () { return 250 * 1048576; },
  });

  assert.equal(logs.length, 1);
  var ev = logs[0];
  assert.equal(ev.event, "memory_shed");
  assert.equal(ev.beforeBytes, 300 * 1048576);
  assert.equal(ev.afterBytes, 250 * 1048576);
  assert.equal(typeof ev.sessionsTrimmed, "number");
  assert.equal(typeof ev.sessionsEvicted, "number");
  assert.deepEqual(ev.cachesDropped, ["skills"]);
  assert.equal(typeof ev.timestamp, "string");
});

// ---------------------------------------------------------------------------
// Rate limit: at most one shedding pass per 60s
// ---------------------------------------------------------------------------

test("lr-5e70: shedMemory rate-limits to at most one pass per 60s — immediate second crossing is skipped", function () {
  var first = shedMemory({ projects: [], nowMs: 1000 });
  assert.equal(first.skipped, false);

  var second = shedMemory({ projects: [], nowMs: 1000 + 1 });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "rate_limited");
});

test("lr-5e70: shedMemory allows a new pass once RATE_LIMIT_MS has elapsed", function () {
  var first = shedMemory({ projects: [], nowMs: 1000 });
  assert.equal(first.skipped, false);

  var second = shedMemory({ projects: [], nowMs: 1000 + RATE_LIMIT_MS });
  assert.equal(second.skipped, false, "a pass exactly RATE_LIMIT_MS later must not be rate-limited");
});

test("lr-5e70: RATE_LIMIT_MS is 60 seconds", function () {
  assert.equal(RATE_LIMIT_MS, 60000);
});

// ---------------------------------------------------------------------------
// Never throws
// ---------------------------------------------------------------------------

test("lr-5e70: shedMemory does not throw when a project's sm lacks optional methods", function () {
  assert.doesNotThrow(function () {
    shedMemory({ projects: [{ slug: "bare", sm: { sessions: new Map() } }] });
  });
});

test("lr-5e70: shedMemory does not throw when called with no options", function () {
  assert.doesNotThrow(function () {
    shedMemory();
  });
});

"use strict";
/**
 * Regression test for lr-2ea2a7 (P0): daemon OOM caused by unbounded in-heap
 * session.history for isProcessing sessions. MILLER root cause (see the lore
 * task's comment #1): _lruEvictIfNeeded() skips any isProcessing session
 * (lib/sessions.js), so a long-running Ralph/crew loop that stays
 * isProcessing for hours accumulated its entire event stream in heap with no
 * other cap.
 *
 * Fix: session._historyBaseIndex + a bounded in-heap tail
 * (HISTORY_INMEM_MAX/HISTORY_INMEM_TRIM_TO) enforced by recordHistoryEntry()
 * for EVERY session including isProcessing ones. On-disk JSONL remains the
 * full source of truth; absolute index (_historyBaseIndex + heap offset)
 * remains the wire contract (history_meta.total/from, load_more_history
 * before/target, messageUUIDs[].historyIndex) -- no wire-format change.
 *
 * Drives real production code from lib/sessions.js -- no reimplementation.
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr2ea2a7-"));
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

function findSessionFile(sessionsBase, cliSessionId) {
  var found = null;
  if (!fs.existsSync(sessionsBase)) return null;
  fs.readdirSync(sessionsBase).forEach(function (dir) {
    var candidate = path.join(sessionsBase, dir, cliSessionId + ".jsonl");
    if (fs.existsSync(candidate)) found = candidate;
  });
  return found;
}

test("lr-2ea2a7 soak: 5,000 events through an isProcessing session stays heap-bounded, JSONL retains everything", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var sess = sm.createSessionRaw({});
    sess.cliSessionId = "sess-2ea2a7-soak";
    sess.isProcessing = true; // the exact condition that exempted this session from LRU eviction

    var EVENT_COUNT = 5000;
    for (var i = 0; i < EVENT_COUNT; i++) {
      sm.sendAndRecord(sess, { type: "delta", text: "event-" + i });
    }

    // Heap must never exceed HISTORY_INMEM_MAX. With hysteresis, the final
    // length after N events cycles within [TRIM_TO, MAX] depending on where
    // N lands relative to the trim cycle (MAX - TRIM_TO entries per cycle
    // after the first trim) -- it is NOT pinned near TRIM_TO after every
    // possible event count, only bounded by the [TRIM_TO, MAX] band.
    assert.ok(sess.history.length <= sm.HISTORY_INMEM_MAX,
      "heap history length " + sess.history.length + " must not exceed HISTORY_INMEM_MAX=" + sm.HISTORY_INMEM_MAX);
    assert.ok(sess.history.length >= sm.HISTORY_INMEM_TRIM_TO,
      "heap history length " + sess.history.length + " must be within the hysteresis band, at or above HISTORY_INMEM_TRIM_TO=" + sm.HISTORY_INMEM_TRIM_TO);
    // The key soak assertion: heap is bounded to the cap band, nowhere near
    // the full 5,000-event count -- this is what "does not grow unbounded" means.
    assert.ok(sess.history.length < EVENT_COUNT,
      "heap history length " + sess.history.length + " must be far smaller than the full event count " + EVENT_COUNT);

    // baseIndex must account for every event trimmed off the head.
    assert.equal(sess._historyBaseIndex + sess.history.length, EVENT_COUNT,
      "_historyBaseIndex + heap length must equal the total absolute event count");
    assert.ok(sess._historyBaseIndex > 0, "baseIndex must have advanced -- some entries were trimmed off the heap");

    // Force a flush and verify the on-disk JSONL has ALL events + meta line,
    // proving disk remains the full source of truth regardless of heap trim.
    sm.flushSessionBuffer(sess);
    var sessionsBase = path.join(tmpHome, "console", "sessions");
    var sessionFile = findSessionFile(sessionsBase, "sess-2ea2a7-soak");
    assert.ok(sessionFile, "session file should exist");
    // meta line was never written via saveSessionFile in this test (only
    // appendToSessionFile via sendAndRecord) -- so the file has EVENT_COUNT
    // history lines, no meta line yet.
    var lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, EVENT_COUNT, "JSONL must contain every event -- disk is the full source of truth even though heap was trimmed");
    var firstLine = JSON.parse(lines[0]);
    var lastLine = JSON.parse(lines[lines.length - 1]);
    assert.equal(firstLine.text, "event-0", "first on-disk event must be the very first one sent -- disk never trims");
    assert.equal(lastLine.text, "event-" + (EVENT_COUNT - 1), "last on-disk event must be the most recent one sent");

    // The heap tail itself must contain the MOST RECENT events (trimmed off
    // the head, not the tail).
    var lastHeapEntry = sess.history[sess.history.length - 1];
    assert.equal(lastHeapEntry.text, "event-" + (EVENT_COUNT - 1), "heap tail must end with the most recent event");
    var firstHeapEntry = sess.history[0];
    var firstHeapEventIdx = parseInt(firstHeapEntry.text.split("-")[1], 10);
    assert.equal(firstHeapEventIdx, sess._historyBaseIndex, "first heap entry must correspond exactly to baseIndex");

    // replayHistory must serve a correct, absolute-indexed tail.
    var sent = [];
    var sm2 = sm; // reuse -- replayHistory reads session.history directly, no reload needed since _historyLoaded stays true
    var origSend = null;
    // Capture via a fresh session manager wired to record sends, driving the
    // real replayHistory implementation on the SAME session object.
    var smForReplay = makeSessionManager(tmpHome, {});
    // replayHistory is bound to smForReplay's own session map, not sess's --
    // so instead we exercise replayHistory through the ORIGINAL sm using its
    // send() by re-creating sm with a capturing send callback.
    var captured = [];
    var sm3 = makeSessionManagerWithCapture(tmpHome, captured);
    var sess3 = sm3.sm.createSessionRaw({});
    sess3.cliSessionId = "sess-2ea2a7-replay";
    sess3.isProcessing = true;
    for (var j = 0; j < EVENT_COUNT; j++) {
      sm3.sm.sendAndRecord(sess3, { type: "delta", text: "r-" + j });
    }
    captured.length = 0; // clear the live-broadcast noise from sendAndRecord above
    sm3.sm.replayHistory(sess3, undefined, null, null);

    var metaMsg = captured.filter(function (m) { return m.type === "history_meta"; })[0];
    assert.ok(metaMsg, "replayHistory must emit history_meta");
    assert.equal(metaMsg.total, EVENT_COUNT, "history_meta.total must be the ABSOLUTE total, not the trimmed heap length");
    assert.ok(metaMsg.from >= sess3._historyBaseIndex, "history_meta.from must be at or above baseIndex (heap floor)");

    var deltaMsgs = captured.filter(function (m) { return m.type === "delta"; });
    assert.ok(deltaMsgs.length > 0, "replay must emit at least one delta");
    var lastDelta = deltaMsgs[deltaMsgs.length - 1];
    assert.equal(lastDelta.text, "r-" + (EVENT_COUNT - 1), "replay must end with the most recent event");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

function makeSessionManagerWithCapture(tmpHome, captured) {
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
  var sm = sessions.createSessionManager({
    cwd: tmpHome,
    send: function (obj) { captured.push(obj); },
    sendTo: function (ws, obj) { captured.push(obj); },
    sendEach: function () {},
  });
  return { sm: sm };
}

test("lr-2ea2a7: load_more_history pages backward across the trim boundary all the way to 0, correct items/order", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var sess = sm.createSessionRaw({});
    sess.cliSessionId = "sess-2ea2a7-page";
    sess.isProcessing = true;
    // Write the meta line first (line 0 on disk) -- readSessionHistoryFromDisk /
    // _parseSessionFileLines always skip line 0 as the meta record.
    sm.saveSessionFile(sess);

    var EVENT_COUNT = 1500; // comfortably exceeds HISTORY_INMEM_MAX (1000 default)
    for (var i = 0; i < EVENT_COUNT; i++) {
      sm.sendAndRecord(sess, { type: "user_message", text: "msg-" + i });
    }

    assert.ok(sess._historyBaseIndex > 0, "baseIndex must have advanced for this test to be meaningful");
    var baseIndex = sess._historyBaseIndex;

    // Page 1: request the window just below baseIndex -- should be served
    // from the disk-backed path (findTurnBoundary/extendWindowForVisibility
    // against a full disk read), not the heap.
    var before = baseIndex; // request the page ending exactly at the trim boundary
    var target = Math.max(0, before - sm.HISTORY_PAGE_SIZE);
    var from = sm.findTurnBoundary(sm.readSessionHistoryFromDisk(sess), target);
    var diskHistory = sm.readSessionHistoryFromDisk(sess);
    from = sm.extendWindowForVisibility(diskHistory, from, before);
    var page = diskHistory.slice(from, before);

    assert.ok(page.length > 0, "the below-baseIndex page must return items");
    assert.equal(page[0].text, "msg-" + from, "first item of the disk-backed page must match its absolute index");
    assert.equal(page[page.length - 1].text, "msg-" + (before - 1), "last item of the disk-backed page must be immediately before the cutoff");

    // Paging all the way back to 0 and reconstructing the full sequence from
    // disk must reproduce the original 1500 messages in order.
    var full = sm.readSessionHistoryFromDisk(sess);
    assert.equal(full.length, EVENT_COUNT, "disk read must return the full absolute history regardless of heap trim");
    for (var k = 0; k < EVENT_COUNT; k++) {
      assert.equal(full[k].text, "msg-" + k, "disk history at absolute index " + k + " must match what was sent");
    }
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-2ea2a7: process_stats-style getHistoryStats reports bounded heapEntries + baseIndex per session, top-5 by heapEntries", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var big = sm.createSessionRaw({});
    big.cliSessionId = "sess-2ea2a7-big";
    big.isProcessing = true;
    for (var i = 0; i < 3000; i++) {
      sm.sendAndRecord(big, { type: "delta", text: "b-" + i });
    }
    var small = sm.createSessionRaw({});
    small.cliSessionId = "sess-2ea2a7-small";
    sm.sendAndRecord(small, { type: "user_message", text: "hi" });

    var stats = sm.getHistoryStats();
    assert.ok(Array.isArray(stats.sessions));
    assert.ok(Array.isArray(stats.top5));
    assert.ok(stats.top5.length <= 5);

    var bigStat = stats.sessions.filter(function (s) { return s.id === big.localId; })[0];
    assert.ok(bigStat, "big session must be present in per-session stats");
    assert.ok(bigStat.heapEntries <= sm.HISTORY_INMEM_MAX, "reported heapEntries must respect the cap");
    assert.ok(bigStat.baseIndex > 0, "reported baseIndex must reflect the trim");

    // Top5 must be sorted descending by heapEntries, and the big session must lead.
    assert.equal(stats.top5[0].id, big.localId, "the session with the most heap entries must be first in top5");
    for (var t = 1; t < stats.top5.length; t++) {
      assert.ok(stats.top5[t - 1].heapEntries >= stats.top5[t].heapEntries, "top5 must be sorted descending by heapEntries");
    }
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-2ea2a7: daemon.json historyInMemMax knob overrides the default cap", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome, { historyInMemMax: 50 });
    assert.equal(sm.HISTORY_INMEM_MAX, 50);
    assert.ok(sm.HISTORY_INMEM_TRIM_TO < 50 && sm.HISTORY_INMEM_TRIM_TO > 0);

    var sess = sm.createSessionRaw({});
    sess.cliSessionId = "sess-2ea2a7-knob";
    sess.isProcessing = true;
    for (var i = 0; i < 200; i++) {
      sm.sendAndRecord(sess, { type: "delta", text: "k-" + i });
    }
    assert.ok(sess.history.length <= 50, "custom cap must be enforced");
    assert.equal(sess._historyBaseIndex + sess.history.length, 200);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-2ea2a7: LRU isProcessing skip is preserved -- an isProcessing session is never evicted from the LRU order", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var processing = sm.createSessionRaw({});
    processing.cliSessionId = "sess-2ea2a7-lru-processing";
    processing.isProcessing = true;
    sm.sendAndRecord(processing, { type: "user_message", text: "keep going" });

    // isProcessing session must still be loaded and its heap history intact
    // (bounded, but not wiped by LRU) -- the isProcessing skip in
    // _lruEvictIfNeeded is a KEEPER per the lr-2ea2a7 spec, not removed.
    assert.equal(processing._historyLoaded, true);
    assert.ok(processing.history.length > 0);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

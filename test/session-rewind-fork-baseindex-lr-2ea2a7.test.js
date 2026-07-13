"use strict";
/**
 * Regression tests for lr-2ea2a7: rewind and fork can target a uuid whose
 * historyIndex is older than the session's current heap tail
 * (session._historyBaseIndex > 0). lib/sessions.js exposes
 * loadFullSessionHistory() (cap-exempt full materialization from disk) and
 * retrimHistory() (re-apply the bounded cap afterward) specifically for
 * these two consumers.
 *
 * These tests drive the real lib/sessions.js helpers directly rather than
 * lib/project-sessions.js's WS handlers (which have a large ctx surface) --
 * the handlers are thin wrappers around exactly this load/trim/retrim
 * sequence, so exercising the sessions.js primitives is the correct unit
 * boundary and matches the pattern of the existing lr-79c6/lr-f940 tests.
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr2ea2a7-rf-"));
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

// Pump enough events through a session (via appendToSessionFile directly, to
// avoid the message_uuid bookkeeping sdk-message-processor.js normally adds)
// to force at least one heap trim, then manually record a message_uuid entry
// at a known PRE-TRIM absolute index so rewind/fork have a target older than
// the current heap tail.
function buildTrimmedSessionWithUuidTarget(sm, cliSessionId, targetUuid) {
  var sess = sm.createSessionRaw({});
  sess.cliSessionId = cliSessionId;
  sess.isProcessing = true;

  // Absolute index 5 will hold the target message_uuid + its user_message.
  for (var i = 0; i < 5; i++) {
    sm.sendAndRecord(sess, { type: "delta", text: "pre-" + i });
  }
  var targetUserMsg = { type: "user_message", text: "TARGET_TURN" };
  sm.recordHistoryEntry(sess, targetUserMsg, true);
  sm.appendToSessionFile(sess, targetUserMsg);
  var targetAbsoluteIndex = sess._historyBaseIndex + sess.history.length - 1;
  sess.messageUUIDs.push({ uuid: targetUuid, type: "user", historyIndex: targetAbsoluteIndex });
  var uuidRecord = { type: "message_uuid", uuid: targetUuid, messageType: "user" };
  sm.recordHistoryEntry(sess, uuidRecord, true);
  sm.appendToSessionFile(sess, uuidRecord);

  // Pump enough further events to force the heap to trim past the target.
  for (var j = 0; j < 1200; j++) {
    sm.sendAndRecord(sess, { type: "delta", text: "post-" + j });
  }

  return { sess: sess, targetAbsoluteIndex: targetAbsoluteIndex };
}

test("lr-2ea2a7: rewind to a uuid with historyIndex < baseIndex -- loadFullSessionHistory + trim + retrimHistory", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var built = buildTrimmedSessionWithUuidTarget(sm, "sess-2ea2a7-rewind", "uuid-target-1");
    var sess = built.sess;

    assert.ok(sess._historyBaseIndex > built.targetAbsoluteIndex,
      "the rewind target must be older than the current heap tail for this test to be meaningful");

    // Simulate the rewind handler's sequence (project-sessions.js's
    // rewind_execute): load full history, find the target, trim, retrim.
    sm.loadFullSessionHistory(sess);
    assert.equal(sess._historyBaseIndex, 0, "after loadFullSessionHistory, baseIndex resets to 0 -- heap now holds the FULL history");
    assert.ok(sess.history.length > sm.HISTORY_INMEM_MAX, "the full loaded history must exceed the normal cap for this test to be meaningful");

    var targetIdx = -1;
    for (var i = 0; i < sess.messageUUIDs.length; i++) {
      if (sess.messageUUIDs[i].uuid === "uuid-target-1") { targetIdx = i; break; }
    }
    assert.ok(targetIdx >= 0, "target uuid must be found in the fully-loaded messageUUIDs");

    var trimTo = sess.messageUUIDs[targetIdx].historyIndex;
    sess.history = sess.history.slice(0, trimTo);
    sess._historyBaseIndex = 0;
    sess.messageUUIDs = sess.messageUUIDs.slice(0, targetIdx);

    assert.equal(sess.history.length, trimTo, "history correctly trimmed to the rewind target");
    var lastEntry = sess.history[sess.history.length - 1];
    assert.notEqual(lastEntry.type, "message_uuid", "trim excludes the target's own message_uuid marker");

    // Full rewrite to disk (mirrors sm.saveSessionFile(session) in the real handler).
    sm.saveSessionFile(sess);
    var sessionsBase = path.join(tmpHome, "console", "sessions");
    var sessionFile = path.join(sessionsBase, fs.readdirSync(sessionsBase)[0], "sess-2ea2a7-rewind.jsonl");
    var linesAfterRewind = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
    // meta + trimmed history lines
    assert.equal(linesAfterRewind.length, 1 + trimTo, "disk file must reflect the rewound (trimmed) history, not the pre-rewind full history");

    // retrimHistory re-applies the bounded cap -- no-op here since trimTo (5) is small.
    sm.retrimHistory(sess);
    assert.ok(sess.history.length <= sm.HISTORY_INMEM_MAX, "heap must respect the cap after retrimHistory");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-2ea2a7: fork at a pre-trim uuid -- forked session file contains the FULL prefix, not just the trimmed heap tail", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var built = buildTrimmedSessionWithUuidTarget(sm, "sess-2ea2a7-fork-src", "uuid-target-2");
    var sess = built.sess;

    assert.ok(sess._historyBaseIndex > built.targetAbsoluteIndex,
      "the fork target must be older than the current heap tail for this test to be meaningful");

    // Mirror project-sessions.js's fork_session "useLocalHistory" branch.
    sm.loadFullSessionHistory(sess);
    var targetIdx = -1;
    for (var fi = 0; fi < sess.messageUUIDs.length; fi++) {
      if (sess.messageUUIDs[fi].uuid === "uuid-target-2") { targetIdx = fi; break; }
    }
    assert.ok(targetIdx >= 0);
    var trimTo = sess.messageUUIDs[targetIdx].historyIndex;
    var forkHistory = sess.history.slice(0, trimTo);
    sm.retrimHistory(sess); // restore source session's heap cap

    assert.equal(forkHistory.length, trimTo,
      "forkHistory must contain the FULL prefix up to the target -- not truncated at the source's trimmed heap boundary");
    assert.equal(forkHistory[forkHistory.length - 1].text, "TARGET_TURN");

    var forked = sm.createSession({ vendor: null, ownerId: null }, null);
    forked.cliSessionId = "sess-2ea2a7-fork-dst";
    forked.title = "fork test";
    forked.history = forkHistory;
    forked._historyBaseIndex = 0;
    forked.messageUUIDs = [];
    for (var hi = 0; hi < forkHistory.length; hi++) {
      if (forkHistory[hi].type === "message_uuid") {
        forked.messageUUIDs.push({ uuid: forkHistory[hi].uuid, type: forkHistory[hi].messageType, historyIndex: hi });
      }
    }
    sm.saveSessionFile(forked);
    sm.retrimHistory(forked);

    var sessionsBase = path.join(tmpHome, "console", "sessions");
    var forkedFile = path.join(sessionsBase, fs.readdirSync(sessionsBase)[0], "sess-2ea2a7-fork-dst.jsonl");
    var forkedLines = fs.readFileSync(forkedFile, "utf8").trim().split("\n").filter(Boolean);
    // meta + forkHistory lines
    assert.equal(forkedLines.length, 1 + trimTo,
      "forked session file on disk must contain the full prefix, proving the fork was not silently truncated by the source's heap trim");
    var lastForkedLine = JSON.parse(forkedLines[forkedLines.length - 1]);
    assert.equal(lastForkedLine.text, "TARGET_TURN");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

"use strict";
// Regression test for lr-f940 (N1, top-3): saveSessionFile() re-serialized
// the ENTIRE in-memory history on every metadata-only mutation (title,
// bookmark, favorite reorder, owner, visibility, agent, vendor bind)
// whenever the session's history happened to be loaded (_historyLoaded) —
// which is the case for the active/processing session, since
// _lruEvictIfNeeded (lib/sessions.js) never evicts the active session or one
// currently processing. That made every metadata edit on a long-running
// active session an O(n) full-file rewrite.
//
// Fix: saveSessionFile() now also takes the existing meta-line-only rewrite
// path (previously reserved for !_historyLoaded sessions, lr-79c6) whenever
// the session is loaded AND its in-memory history still matches what was
// last durably written (historyMatchesDisk(), tracked via
// session._historyPersistedLength). Any direct mutation of session.history
// (push/pop/slice/splice/reassignment outside the normal doSendAndRecord +
// appendToSessionFile buffered path) changes session.history.length, which
// is detected automatically — no caller needs to opt in — so a full rewrite
// still runs whenever history actually changed. This preserves the
// pre-existing lr-79c6 regression test's contract ("saveSessionFile on a
// loaded session still does a full rewrite") without requiring that test (or
// any other existing caller) to change.
//
// Drives real production code from lib/sessions.js — no reimplementation.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lrf940-"));
}

function makeSessionManager(tmpHome) {
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
  return sessions.createSessionManager({
    cwd: tmpHome,
    send: function () {},
    sendTo: function () {},
    sendEach: function () {},
  });
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

test("lr-f940: a metadata-only save on a LOADED session takes the meta-only fast path (no full rewrite needed)", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var sess = sm.createSessionRaw({});
    sess.cliSessionId = "sess-f940-loaded-meta";

    sm.sendAndRecord(sess, { type: "user_message", text: "hello" });
    sm.sendAndRecord(sess, { type: "delta", text: "world" });
    sm.saveSessionFile(sess);

    var sessionsBase = path.join(tmpHome, "console", "sessions");
    var sessionFile = findSessionFile(sessionsBase, "sess-f940-loaded-meta");
    assert.ok(sessionFile, "session file should exist");
    var beforeLines = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(beforeLines.length, 3, "meta + 2 history lines before rename");

    // Session remains LOADED (the common active-session case) — NOT evicted,
    // NOT restarted. Only a metadata field changes; history is untouched.
    assert.equal(sess._historyLoaded, true, "session must still be loaded in memory");
    sess.title = "Renamed While Loaded";
    sm.saveSessionFile(sess);

    var afterLines = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(afterLines.length, 3, "history lines must survive a metadata-only save on a LOADED session");
    var meta = JSON.parse(afterLines[0]);
    assert.equal(meta.type, "meta");
    assert.equal(meta.title, "Renamed While Loaded");
    var line2 = JSON.parse(afterLines[1]);
    var line3 = JSON.parse(afterLines[2]);
    assert.equal(line2.text, "hello");
    assert.equal(line3.text, "world");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-f940: a direct session.history.push (outside appendToSessionFile) is detected automatically and forces a full rewrite", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var sess = sm.createSessionRaw({});
    sess.cliSessionId = "sess-f940-direct-push";

    sm.sendAndRecord(sess, { type: "user_message", text: "first" });
    sm.saveSessionFile(sess);

    // Directly mutate history WITHOUT going through sendAndRecord/appendToSessionFile
    // (mirrors e.g. project-user-message.js's context_preview push, or a
    // fork's forked.history = forkHistory reassignment). No caller
    // cooperation (no dirty flag / opt-in call) should be required for this
    // to persist correctly.
    sess.history.push({ type: "delta", text: "directly pushed, not appended" });
    sm.saveSessionFile(sess);

    var sessionsBase = path.join(tmpHome, "console", "sessions");
    var sessionFile = findSessionFile(sessionsBase, "sess-f940-direct-push");
    var lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 3, "the length mismatch must be detected and force a full rewrite that persists the direct push");
    var line3 = JSON.parse(lines[2]);
    assert.equal(line3.text, "directly pushed, not appended");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-f940: a direct history truncation (rewind-style slice) is detected automatically and forces a full rewrite", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var sess = sm.createSessionRaw({});
    sess.cliSessionId = "sess-f940-truncate";

    sm.sendAndRecord(sess, { type: "user_message", text: "first" });
    sm.sendAndRecord(sess, { type: "delta", text: "second" });
    sm.sendAndRecord(sess, { type: "user_message", text: "third" });
    sm.saveSessionFile(sess);

    var sessionsBase = path.join(tmpHome, "console", "sessions");
    var sessionFile = findSessionFile(sessionsBase, "sess-f940-truncate");
    var beforeLines = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(beforeLines.length, 4, "meta + 3 history lines before truncation");

    // Simulate a rewind: truncate history directly (project-sessions.js's
    // rewind handler does session.history = session.history.slice(0, trimTo)).
    sess.history = sess.history.slice(0, 1);
    sm.saveSessionFile(sess);

    var afterLines = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(afterLines.length, 2, "the truncation must be persisted — stale lines must not survive a meta-only fast path");
    var line2 = JSON.parse(afterLines[1]);
    assert.equal(line2.text, "first");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-f940: after a full rewrite forced by a length mismatch, the NEXT metadata-only save takes the fast path again", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var sess = sm.createSessionRaw({});
    sess.cliSessionId = "sess-f940-clear-mismatch";

    sm.sendAndRecord(sess, { type: "user_message", text: "first" });
    sess.history.push({ type: "delta", text: "second" }); // direct push, mismatch
    sm.saveSessionFile(sess); // full rewrite; _historyPersistedLength now matches

    // A subsequent metadata-only change must not need any special handling,
    // and must still preserve both history lines from the prior full rewrite.
    sess.bookmarked = true;
    sm.saveSessionFile(sess);

    var sessionsBase = path.join(tmpHome, "console", "sessions");
    var sessionFile = findSessionFile(sessionsBase, "sess-f940-clear-mismatch");
    var lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 3, "meta + 2 history lines must survive the follow-up metadata-only save");
    var meta = JSON.parse(lines[0]);
    assert.equal(meta.bookmarked, true);
    var line2 = JSON.parse(lines[1]);
    var line3 = JSON.parse(lines[2]);
    assert.equal(line2.text, "first");
    assert.equal(line3.text, "second");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

"use strict";
// Regression test for lr-79c6: saveSessionFile() truncated the on-disk
// history of sessions whose history had not been loaded into memory
// (fresh daemon restart, or LRU-evicted). Any metadata-only mutation
// (rename, bookmark, visibility, owner, favorite reorder) on such a
// session rewrote the file from session.history (== []), destroying the
// persisted conversation.
//
// Fix: saveSessionFile() now detects !session._historyLoaded and rewrites
// only the meta (first) line of the existing file in place, leaving all
// history lines untouched, instead of loading or serializing history.
//
// Drives real production code from lib/sessions.js — no reimplementation.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr79c6-"));
}

function makeSessionManager(tmpHome) {
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function(m) {
    try { delete require.cache[require.resolve(m)]; } catch(_) {}
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
    send: function() {},
    sendTo: function() {},
    sendEach: function() {},
  });
}

function findSessionFile(sessionsBase, cliSessionId) {
  var found = null;
  if (!fs.existsSync(sessionsBase)) return null;
  fs.readdirSync(sessionsBase).forEach(function(dir) {
    var candidate = path.join(sessionsBase, dir, cliSessionId + ".jsonl");
    if (fs.existsSync(candidate)) found = candidate;
  });
  return found;
}

test("lr-79c6: rename on an unloaded session preserves existing history lines on disk", function() {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var sess = sm.createSessionRaw({});
    sess.cliSessionId = "sess-79c6-rename";
    sess.title = "Original Title";

    // Populate history and force a full write so the file has real content
    // on disk (meta + 2 history lines), simulating a session that was used
    // in a prior daemon lifetime.
    sm.sendAndRecord(sess, { type: "user_message", text: "hello" });
    sm.sendAndRecord(sess, { type: "delta", text: "world" });
    sm.saveSessionFile(sess);

    var sessionsBase = path.join(tmpHome, "console", "sessions");
    var sessionFile = findSessionFile(sessionsBase, "sess-79c6-rename");
    assert.ok(sessionFile, "session file should exist");

    var beforeLines = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(beforeLines.length, 3, "meta + 2 history lines before rename");

    // Simulate a daemon restart: history unloaded, in-memory array empty,
    // exactly what loadSessions() produces for a persisted session.
    sess.history = [];
    sess._historyLoaded = false;

    // Simulate rename_session (project-sessions.js) mutating metadata only,
    // on a session the user has not opened since restart.
    sess.title = "Renamed Title";
    sm.saveSessionFile(sess);

    var afterLines = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(afterLines.length, 3,
      "history lines must survive a metadata-only save on an unloaded session; got " + afterLines.length);

    var meta = JSON.parse(afterLines[0]);
    assert.equal(meta.type, "meta");
    assert.equal(meta.title, "Renamed Title", "meta line must reflect the rename");

    var line2 = JSON.parse(afterLines[1]);
    var line3 = JSON.parse(afterLines[2]);
    assert.equal(line2.type, "user_message");
    assert.equal(line2.text, "hello");
    assert.equal(line3.type, "delta");
    assert.equal(line3.text, "world");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-79c6: bookmark toggle on an unloaded session preserves history and updates flags", function() {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var sess = sm.createSessionRaw({});
    sess.cliSessionId = "sess-79c6-bookmark";

    sm.sendAndRecord(sess, { type: "user_message", text: "keep me" });
    sm.saveSessionFile(sess);

    var sessionsBase = path.join(tmpHome, "console", "sessions");
    var sessionFile = findSessionFile(sessionsBase, "sess-79c6-bookmark");

    // Simulate restart: unloaded in-memory state.
    sess.history = [];
    sess._historyLoaded = false;

    var result = sm.setSessionBookmarked(sess.localId, true);
    assert.deepEqual(result, { ok: true });

    var lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 2, "meta + 1 history line must survive bookmarking");
    var meta = JSON.parse(lines[0]);
    assert.equal(meta.bookmarked, true);
    var histLine = JSON.parse(lines[1]);
    assert.equal(histLine.text, "keep me");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-79c6: saveSessionFile on a loaded session still does a full rewrite (no stale lines left behind)", function() {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var sess = sm.createSessionRaw({});
    sess.cliSessionId = "sess-79c6-loaded";

    sm.sendAndRecord(sess, { type: "user_message", text: "first" });
    sm.sendAndRecord(sess, { type: "delta", text: "second" });
    sm.saveSessionFile(sess);

    // Session remains fully loaded (as it is right after creation/use);
    // mutate history via the normal loaded path and re-save.
    assert.equal(sess._historyLoaded, true);
    sess.history.pop(); // drop "second"
    sm.saveSessionFile(sess);

    var sessionsBase = path.join(tmpHome, "console", "sessions");
    var sessionFile = findSessionFile(sessionsBase, "sess-79c6-loaded");
    var lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 2, "full rewrite from in-memory history must reflect the pop()");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

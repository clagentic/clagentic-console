"use strict";
/**
 * Regression test for lr-2ea2a7: searchSessions()/searchSessionContent() used
 * to call loadSessionHistory() to enable content search, which permanently
 * loaded full history into heap for up to 50 sessions on every search --
 * itself an unbounded-growth path independent of the isProcessing leak this
 * fix primarily targets. Both are now a streaming disk scan
 * (sm.readSessionHistoryFromDisk) that does NOT mutate
 * session.history/_historyLoaded/LRU state.
 *
 * Drives real production code from lib/sessions.js -- no reimplementation.
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr2ea2a7-search-"));
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

test("lr-2ea2a7: searchSessionContent finds a hit that lives on disk but is outside the loaded/trimmed heap, without loading history", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var sess = sm.createSessionRaw({});
    sess.cliSessionId = "sess-2ea2a7-search-content";
    // Write the meta line first (line 0 on disk) -- _parseSessionFileLines
    // always skips line 0 as the meta record, matching real session files
    // (every real session's first saveSessionFile/append writes the meta
    // line before any history line ever reaches disk).
    sm.saveSessionFile(sess);

    // Write a distinctive needle as the very first message, then pump enough
    // events afterward that a NORMAL tail-load would trim it out of the heap.
    sm.sendAndRecord(sess, { type: "user_message", text: "the quick brown NEEDLE_TOKEN fox" });
    for (var i = 0; i < 1200; i++) {
      sm.sendAndRecord(sess, { type: "delta", text: "filler-" + i });
    }

    // Force the session to look "unloaded" (as it would be for a session the
    // search API discovers via sm.sessions without ever having been switched
    // to) so a bug that re-adds loadSessionHistory() would be caught by the
    // heap-mutation assertion below.
    sess.history = [];
    sess._historyLoaded = false;

    var result = sm.searchSessionContent(sess.localId, "NEEDLE_TOKEN");
    assert.ok(result.hits.length > 0, "search must find the needle even though it is not in the (empty/unloaded) heap");
    assert.equal(result.hits[0].historyIndex, 0, "hit historyIndex must be the ABSOLUTE disk-line index");

    // Search must not have mutated session state as a side effect.
    assert.equal(sess._historyLoaded, false, "searchSessionContent must not call loadSessionHistory() / mutate _historyLoaded");
    assert.equal(sess.history.length, 0, "searchSessionContent must not populate session.history as a side effect");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-2ea2a7: searchSessions content-match path does not load history into heap for non-matching or matching sessions", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var sess = sm.createSessionRaw({});
    sess.cliSessionId = "sess-2ea2a7-search-list";
    sm.saveSessionFile(sess); // write the meta line first, see the content-search test above
    sm.sendAndRecord(sess, { type: "user_message", text: "findable secret phrase here" });
    sess.history = [];
    sess._historyLoaded = false;

    var results = sm.searchSessions("secret phrase");
    var hit = results.filter(function (r) { return r.id === sess.localId; })[0];
    assert.ok(hit, "session must be found via content match");
    assert.equal(hit.matchType, "content");

    assert.equal(sess._historyLoaded, false, "searchSessions must not load history into heap as a side effect");
    assert.equal(sess.history.length, 0);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

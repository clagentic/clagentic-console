"use strict";
/**
 * Regression test for lr-a3e175: /api/palette/search (lib/server-palette.js)
 * iterated session.history directly with no loadSessionHistory() and no
 * disk-backed read, so any session whose history was unloaded (LRU-evicted,
 * or never opened since daemon start) or heap-trimmed contributed zero/
 * partial hits to BM25 palette search.
 *
 * Fix follows the lr-2ea2a7 streaming-disk precedent
 * (test/session-search-streaming-lr-2ea2a7.test.js): lib/session-search.js's
 * searchPalette() now accepts an optional getHistory(session) callback and
 * lib/server-palette.js supplies sm.readSessionHistoryFromDisk, so palette
 * search finds content in an unloaded session WITHOUT calling
 * loadSessionHistory() / mutating heap or LRU state.
 *
 * Drives real production code from lib/sessions.js and lib/session-search.js
 * -- no reimplementation.
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var sessionSearch = require("../lib/session-search");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr-a3e175-palette-"));
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

test("lr-a3e175: palette search finds content in an unloaded session via disk-backed getHistory, without mutating heap state", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var sess = sm.createSessionRaw({});
    sess.cliSessionId = "sess-a3e175-palette";
    // Write the meta line first (line 0 on disk) -- _parseSessionFileLines
    // always skips line 0 as the meta record.
    sm.saveSessionFile(sess);

    // Write a distinctive needle as the very first message, then pump enough
    // events afterward that a normal tail-load would trim it out of the heap.
    sm.sendAndRecord(sess, { type: "user_message", text: "the quick brown PALETTE_NEEDLE_TOKEN fox" });
    for (var i = 0; i < 1200; i++) {
      sm.sendAndRecord(sess, { type: "delta", text: "filler-" + i });
    }

    // Force the session to look "unloaded" (LRU-evicted / never opened since
    // daemon start) -- exactly the state /api/palette/search must still
    // find hits in.
    sess.history = [];
    sess._historyLoaded = false;

    var projectSessions = [{
      projectSlug: "proj",
      projectTitle: "Proj",
      projectIcon: null,
      sessions: [sess]
    }];

    var results = sessionSearch.searchPalette(projectSessions, "PALETTE_NEEDLE_TOKEN", {
      maxResults: 30,
      getHistory: function (session) {
        return sm.readSessionHistoryFromDisk(session);
      }
    });

    var hit = results.filter(function (r) { return r.sessionId === sess.localId; })[0];
    assert.ok(hit, "palette search must find content in an unloaded session");
    assert.equal(hit.matchType, "content");

    // Search must not have mutated session state as a side effect.
    assert.equal(sess._historyLoaded, false, "palette search must not call loadSessionHistory() / mutate _historyLoaded");
    assert.equal(sess.history.length, 0, "palette search must not populate session.history as a side effect");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-a3e175: palette search falls back to session.history when no getHistory is supplied (back-compat)", function () {
  var projectSessions = [{
    projectSlug: "proj",
    projectTitle: "Proj",
    projectIcon: null,
    sessions: [{
      localId: 1,
      title: "New Session",
      history: [{ type: "user_message", text: "findable inline phrase" }],
      lastActivity: Date.now()
    }]
  }];

  var results = sessionSearch.searchPalette(projectSessions, "findable inline phrase", { maxResults: 30 });
  var hit = results.filter(function (r) { return r.sessionId === 1; })[0];
  assert.ok(hit, "palette search must still work against in-heap session.history when getHistory is not supplied");
  assert.equal(hit.matchType, "content");
});

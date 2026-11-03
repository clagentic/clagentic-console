"use strict";

// The per-session switch for prompt reminders is written to session meta and
// restored by a fresh session manager, so a restart does not turn reminders
// back on for a session the operator silenced.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

function makeSessionManager(tmpHome) {
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) {
    delete require.cache[require.resolve(m)];
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
  return sessions.createSessionManager({ cwd: tmpHome, send: function () {}, sendTo: function () {}, sendEach: function () {} });
}

function findByCliId(sm, cliId) {
  var found = null;
  sm.sessions.forEach(function (s) { if (s.cliSessionId === cliId) found = s; });
  return found;
}

test("the switch survives a restart and switching it back on is persisted", function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-reminders-"));
  try {
    var sm = makeSessionManager(tmpHome);
    var s = sm.createSessionRaw({});
    s.cliSessionId = "sess-rem";
    s.history = [{ type: "user_message", text: "hi" }];
    s._historyLoaded = true;
    sm.saveSessionFile(s);
    sm.loadSessionHistory(s);

    assert.equal(!!s.promptRemindersOff, false, "reminders are on unless switched off");
    assert.deepEqual(sm.setSessionPromptReminders(s.localId, false), { ok: true });
    var reloaded = findByCliId(makeSessionManager(tmpHome), "sess-rem");
    assert.equal(reloaded.promptRemindersOff, true);

    sm.setSessionPromptReminders(s.localId, true);
    assert.equal(findByCliId(makeSessionManager(tmpHome), "sess-rem").promptRemindersOff, false);
    assert.equal(sm.setSessionPromptReminders(9999, false).error, "Session not found");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

"use strict";
// A session's name (open-session --name) is stable for the life of its record:
// it is written into the session file's meta line and restored on a daemon
// restart, so an address that names it still resolves afterwards.
// Follows the temp-home + fresh-require pattern of
// session-model-persist-restart-lr-db0437.test.js.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

function freshSessionsModule(tmpHome) {
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) {
    delete require.cache[require.resolve(m)];
  });
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  try {
    return require("../lib/sessions");
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
}

function manager(tmpHome) {
  return freshSessionsModule(tmpHome).createSessionManager({
    cwd: tmpHome,
    send: function () {},
    sendTo: function () {},
    sendEach: function () {},
  });
}

test("a session name round-trips through the meta line and a restart; an unnamed session stays unnamed", function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-sessname-"));
  try {
    var sm1 = manager(tmpHome);
    var named = sm1.createSessionRaw({});
    named.cliSessionId = "sess-named";
    named.sessionName = "lane-a";
    sm1.sendAndRecord(named, { type: "user_message", text: "hello" });
    sm1.saveSessionFile(named);
    var plain = sm1.createSessionRaw({});
    plain.cliSessionId = "sess-plain";
    sm1.sendAndRecord(plain, { type: "user_message", text: "hello" });
    sm1.saveSessionFile(plain);

    var sm2 = manager(tmpHome);
    var all = Array.from(sm2.sessions.values());
    var restoredNamed = all.find(function (s) { return s.cliSessionId === "sess-named"; });
    var restoredPlain = all.find(function (s) { return s.cliSessionId === "sess-plain"; });
    assert.ok(restoredNamed && restoredPlain, "both sessions are restored");
    assert.equal(restoredNamed.sessionName, "lane-a");
    assert.ok(!restoredPlain.sessionName, "no name appears on a session that never had one");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

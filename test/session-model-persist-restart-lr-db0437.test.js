"use strict";
// Regression test for lr-db0437 (acceptance criterion: "Given a session
// picked model X, when the daemon restarts and the session resumes, then
// the session still uses X").
//
// Root cause: session.model only ever lived in memory. buildMetaLine()
// (lib/sessions.js) never wrote it into the persisted meta line, and
// loadSessions() never read it back — so a daemon restart silently reset
// every session's model to whatever the project/global default happened to
// be, indistinguishable from the user never having picked a model.
//
// Fix: buildMetaLine() now writes `model` into the meta object when
// session.model is set, and loadSessions() hydrates session.model from it
// on restore.
//
// Drives real production code from lib/sessions.js — no reimplementation.
// Follows the temp-CLAGENTIC_HOME + fresh-require pattern established by
// test/session-meta-only-save-loaded-lr-f940.test.js.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lrdb0437-"));
}

function freshSessionsModule(tmpHome) {
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
  return sessions;
}

test("lr-db0437: a session's model choice survives a daemon restart (round-trip through buildMetaLine + loadSessions)", function () {
  var tmpHome = makeTempHome();
  try {
    // --- "Before restart": create a session, pick a model, save it ---
    var sessionsModule1 = freshSessionsModule(tmpHome);
    var sm1 = sessionsModule1.createSessionManager({
      cwd: tmpHome,
      send: function () {},
      sendTo: function () {},
      sendEach: function () {},
    });
    var sess = sm1.createSessionRaw({});
    sess.cliSessionId = "sess-db0437-model-persist";
    sm1.sendAndRecord(sess, { type: "user_message", text: "hello" });

    // Simulate the session having picked a non-default model (what
    // sdk-bridge.js's setModel does to session.model — see
    // sdk-bridge-setmodel-session-scoped-lr-db0437.test.js for that half).
    sess.model = "opus";
    sm1.saveSessionFile(sess);

    var sessionsBase = path.join(tmpHome, "console", "sessions");
    var found = null;
    fs.readdirSync(sessionsBase).forEach(function (dir) {
      var candidate = path.join(sessionsBase, dir, "sess-db0437-model-persist.jsonl");
      if (fs.existsSync(candidate)) found = candidate;
    });
    assert.ok(found, "session file should exist after saveSessionFile");

    var metaLine = JSON.parse(fs.readFileSync(found, "utf8").split("\n")[0]);
    assert.strictEqual(metaLine.model, "opus", "buildMetaLine must persist session.model into the meta line");

    // --- "Daemon restart": fresh session manager reloads from disk ---
    var sessionsModule2 = freshSessionsModule(tmpHome);
    var sm2 = sessionsModule2.createSessionManager({
      cwd: tmpHome,
      send: function () {},
      sendTo: function () {},
      sendEach: function () {},
    });

    var restoredSessions = Array.from(sm2.sessions.values());
    var restored = restoredSessions.find(function (s) { return s.cliSessionId === "sess-db0437-model-persist"; });
    assert.ok(restored, "session should be restored from disk after restart");
    assert.strictEqual(restored.model, "opus",
      "the restored session must still use the model it had picked before the restart, not fall back to a default");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-db0437: a session that never picked its own model restores with no model field (falls through to the default chain)", function () {
  var tmpHome = makeTempHome();
  try {
    var sessionsModule1 = freshSessionsModule(tmpHome);
    var sm1 = sessionsModule1.createSessionManager({
      cwd: tmpHome,
      send: function () {},
      sendTo: function () {},
      sendEach: function () {},
    });
    var sess = sm1.createSessionRaw({});
    sess.cliSessionId = "sess-db0437-no-model";
    sm1.sendAndRecord(sess, { type: "user_message", text: "hello" });
    // session.model deliberately left unset.
    sm1.saveSessionFile(sess);

    var sessionsModule2 = freshSessionsModule(tmpHome);
    var sm2 = sessionsModule2.createSessionManager({
      cwd: tmpHome,
      send: function () {},
      sendTo: function () {},
      sendEach: function () {},
    });
    var restored = Array.from(sm2.sessions.values()).find(function (s) { return s.cliSessionId === "sess-db0437-no-model"; });
    assert.ok(restored, "session should be restored from disk after restart");
    assert.strictEqual(restored.model, undefined,
      "a session with no explicit model choice must not gain one on restore (startQuery's fallback chain handles this, not a hydrated default)");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

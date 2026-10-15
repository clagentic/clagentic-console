"use strict";
// What a session's file holds about its identity: nothing for a plain session,
// the provider and grade for one a provider vouched for, restored on resume, and
// rebuilt from known values only whatever the file contains.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

function freshSessions(home) {
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) {
    delete require.cache[require.resolve(m)];
  });
  var previous = process.env.CLAGENTIC_CONSOLE_HOME;
  process.env.CLAGENTIC_CONSOLE_HOME = home;
  try {
    return require("../lib/sessions");
  } finally {
    if (previous === undefined) delete process.env.CLAGENTIC_CONSOLE_HOME;
    else process.env.CLAGENTIC_CONSOLE_HOME = previous;
  }
}

function manager(sessionsModule, home) {
  return sessionsModule.createSessionManager({ cwd: home, send: function () {}, sendTo: function () {}, sendEach: function () {} });
}

function sessionFile(home, cliSessionId) {
  var base = path.join(home, "console", "sessions");
  var found = null;
  fs.readdirSync(base).forEach(function (dir) {
    var candidate = path.join(base, dir, cliSessionId + ".jsonl");
    if (fs.existsSync(candidate)) found = candidate;
  });
  return found;
}

test("a plain session's file has no identity member, and a vouched session's record survives a restart", function () {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "identity-record-"));
  try {
    var sm = manager(freshSessions(home), home);
    var plain = sm.createSessionRaw({});
    plain.cliSessionId = "sess-plain";
    sm.sendAndRecord(plain, { type: "user_message", text: "hello" });
    sm.saveSessionFile(plain);
    assert.equal("identity" in JSON.parse(fs.readFileSync(sessionFile(home, "sess-plain"), "utf8").split("\n")[0]), false);

    var vouched = sm.createSessionRaw({});
    vouched.cliSessionId = "sess-vouched";
    sm.sendAndRecord(vouched, { type: "user_message", text: "hello" });
    vouched.identity = { provider: "gatekeeper", grade: "workload", origin: "loop" };
    sm.saveSessionFile(vouched);
    var meta = JSON.parse(fs.readFileSync(sessionFile(home, "sess-vouched"), "utf8").split("\n")[0]);
    assert.deepEqual(meta.identity, { provider: "gatekeeper", grade: "workload", origin: "loop" });
    assert.equal(JSON.stringify(meta).indexOf("identity.jwt"), -1);

    var restored = Array.from(manager(freshSessions(home), home).sessions.values());
    var byId = function (id) { return restored.find(function (s) { return s.cliSessionId === id; }); };
    assert.deepEqual(byId("sess-vouched").identity, { provider: "gatekeeper", grade: "workload", origin: "loop" });
    assert.equal("identity" in byId("sess-plain"), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a session file that carries a hostile identity record is restored with known values only", function () {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "identity-record-"));
  try {
    var sm = manager(freshSessions(home), home);
    var s = sm.createSessionRaw({});
    s.cliSessionId = "sess-hostile";
    sm.sendAndRecord(s, { type: "user_message", text: "hello" });
    sm.saveSessionFile(s);
    var file = sessionFile(home, "sess-hostile");
    var lines = fs.readFileSync(file, "utf8").split("\n");
    var meta = JSON.parse(lines[0]);
    meta.identity = { provider: "gatekeeper", grade: "root", origin: { a: 1 }, token: "a.b.c", dir: "/etc" };
    lines[0] = JSON.stringify(meta);
    fs.writeFileSync(file, lines.join("\n"));

    var restored = Array.from(manager(freshSessions(home), home).sessions.values()).find(function (x) { return x.cliSessionId === "sess-hostile"; });
    assert.deepEqual(restored.identity, { provider: "gatekeeper", grade: null, origin: null });

    meta.identity = "text";
    lines[0] = JSON.stringify(meta);
    fs.writeFileSync(file, lines.join("\n"));
    var again = Array.from(manager(freshSessions(home), home).sessions.values()).find(function (x) { return x.cliSessionId === "sess-hostile"; });
    assert.equal("identity" in again, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

"use strict";

// Resolution order of an unqualified address: running, idle, prompt-blocked,
// reaped. The reported state of a prompt-blocked session stays "live".

var test = require("node:test");
var assert = require("node:assert/strict");

var directory = require("../lib/session-directory");

test.before(function () { return require("../lib/prompt-kinds/codecs").load(); });

// A session as the manager holds it. runtime: "running" | "idle" | "reaped";
// blocked adds a pending permission prompt (only meaningful with a runtime).
function session(localId, runtime, blocked) {
  var s = {
    localId: localId,
    cliSessionId: "cli-" + localId,
    agentName: "holden",
    vendor: "claude",
    title: "t" + localId,
    lastActivity: 1700000000000 + localId * 1000,
    isProcessing: runtime === "running",
    queryInstance: runtime === "reaped" ? null : {},
    history: [],
    pendingPermissions: {},
  };
  if (blocked) {
    s.pendingPermissions["req-" + localId] = { requestId: "req-" + localId, toolName: "Bash", toolInput: { command: "ls" }, createdAt: 1700000000000 };
  }
  return s;
}

function entriesOf(sessions) {
  var sm = { sessions: new Map(), defaultVendor: "claude" };
  sessions.forEach(function (s) { sm.sessions.set(s.localId, s); });
  return directory.collect([{ slug: "lane", project: { sm: sm } }], 1700000100000);
}

function resolveAddress(sessions) {
  return directory.resolve(entriesOf(sessions), directory.parseAddress("holden@lane"));
}

test("AC1: a prompt-blocked session does not outrank an idle twin", function () {
  var r = resolveAddress([session(89, "running", true), session(92, "idle")]);
  assert.equal(r.match && r.match.consoleSessionId, "92");
});

test("AC2: a running session wins over an idle twin", function () {
  var r = resolveAddress([session(1, "idle"), session(2, "running")]);
  assert.equal(r.match && r.match.consoleSessionId, "2");
});

test("AC3: two idle, or two running, sessions are ambiguous", function () {
  var idle = resolveAddress([session(1, "idle"), session(2, "idle")]);
  assert.equal(idle.candidates.length, 2);
  var running = resolveAddress([session(1, "running"), session(2, "running")]);
  assert.equal(running.candidates.length, 2);
});

test("AC4: two prompt-blocked sessions with no running or idle one are ambiguous", function () {
  var r = resolveAddress([session(1, "running", true), session(2, "running", true), session(3, "reaped")]);
  assert.equal(r.candidates.length, 2);
  assert.deepEqual(r.candidates.map(function (c) { return c.consoleSessionId; }).sort(), ["1", "2"]);
});

test("AC5: a prompt-blocked session wins over reaped twins", function () {
  var r = resolveAddress([session(1, "reaped"), session(2, "running", true), session(3, "reaped")]);
  assert.equal(r.match && r.match.consoleSessionId, "2");
});

test("AC6: a prompt-blocked session is still listed as live with its pending prompts", function () {
  var listed = directory.list([{ slug: "lane", project: { sm: { sessions: new Map([[89, session(89, "running", true)]]), defaultVendor: "claude" } } }], { now: 1700000100000 });
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].state, "live");
  assert.equal(listed.entries[0].pendingPrompts.length, 1);
});

test("an exact vendor session id resolves unchanged, whatever tier the session is in", function () {
  var entries = entriesOf([session(89, "running", true), session(92, "idle")]);
  var r = directory.resolve(entries, { project: "lane", vendor: "claude", sessionId: "cli-89" });
  assert.equal(r.match && r.match.consoleSessionId, "89");
});

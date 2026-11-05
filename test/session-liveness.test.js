"use strict";

// The one derivation of what a session is doing: reaped | idle | running |
// waiting, from (runtime attached, turn running, pendingPrompts), and the
// list-sessions projection of it.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var liveness = require("../lib/session-liveness");
var promptRegistry = require("../lib/prompt-registry");

var A = liveness.ACTIVITY;

var CASES = [
  { attached: false, turnRunning: false, pendingCount: 0, activity: A.REAPED, state: "reaped" },
  { attached: false, turnRunning: true, pendingCount: 0, activity: A.REAPED, state: "reaped" },
  { attached: false, turnRunning: false, pendingCount: 2, activity: A.REAPED, state: "reaped" },
  { attached: true, turnRunning: false, pendingCount: 0, activity: A.IDLE, state: "idle" },
  { attached: true, turnRunning: true, pendingCount: 0, activity: A.RUNNING, state: "live" },
  { attached: true, turnRunning: false, pendingCount: 1, activity: A.WAITING, state: "live" },
  { attached: true, turnRunning: true, pendingCount: 1, activity: A.WAITING, state: "live" },
];

CASES.forEach(function (c) {
  test("derive: attached=" + c.attached + " turn=" + c.turnRunning + " pending=" + c.pendingCount + " -> " + c.activity, function () {
    var got = liveness.derive(c);
    assert.equal(got, c.activity);
    assert.equal(liveness.liveStateOf(got), c.state);
  });
});

test("activityOf reads the session's runtime, turn flag and registry prompts", async function () {
  await promptRegistry.ready();
  var registry = promptRegistry.createPromptRegistry({
    index: Object.create(null),
    getSession: function () { return null; },
    sendAndRecord: function () {},
    saveSessionFile: function () {},
  });
  var session = { localId: 1, isProcessing: false, queryInstance: {}, pendingPermissions: Object.create(null) };
  assert.equal(liveness.activityOf(session), A.IDLE);
  session.isProcessing = true;
  assert.equal(liveness.activityOf(session), A.RUNNING);
  registry.open(session, "permission", { toolName: "Bash", toolInput: { command: "ls" }, vendor: "claude" });
  assert.equal(liveness.activityOf(session), A.WAITING);
  session.queryInstance = null;
  session.isProcessing = false;
  assert.equal(liveness.activityOf(session), A.REAPED);
});

test("a prompt opening or settling re-broadcasts the session list with the waiting flag", async function () {
  await promptRegistry.ready();
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-console-test-liveness-"));
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) { delete require.cache[require.resolve(m)]; });
  var prior = process.env.CLAGENTIC_CONSOLE_HOME;
  process.env.CLAGENTIC_CONSOLE_HOME = tmpHome;
  var sessions;
  try { sessions = require("../lib/sessions"); } finally {
    if (prior === undefined) delete process.env.CLAGENTIC_CONSOLE_HOME;
    else process.env.CLAGENTIC_CONSOLE_HOME = prior;
  }
  var sent = [];
  var sm = sessions.createSessionManager({ cwd: tmpHome, send: function (m) { sent.push(m); }, sendTo: function () {} });
  try {
    var s = sm.createSessionRaw({});
    s.queryInstance = {};
    sent.length = 0;
    var opened = sm.prompts.open(s, "permission", { toolName: "Bash", toolInput: { command: "ls" }, vendor: "claude" });
    await new Promise(function (r) { setImmediate(r); });
    var lists = sent.filter(function (m) { return m.type === "session_list"; });
    assert.equal(lists.length, 1, "one coalesced broadcast");
    assert.equal(lists[0].sessions.filter(function (e) { return e.id === s.localId; })[0].waiting, true);

    sent.length = 0;
    sm.prompts.respond(opened.requestId, { decision: "deny" }, { session: s });
    await new Promise(function (r) { setImmediate(r); });
    lists = sent.filter(function (m) { return m.type === "session_list"; });
    assert.equal(lists.length, 1);
    assert.equal(lists[0].sessions.filter(function (e) { return e.id === s.localId; })[0].waiting, false);
  } finally {
    sm.destroy();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

"use strict";

// Who a session's push reaches (lib/push-audience.js), on the real SDK bridge and
// message processor for the first-notice types. In multi-user mode a session
// with no owner pushes to no one: a broadcast would hand a non-owner subscriber
// the tool input.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var world = require("./prompt-harness-world");
var { pushForSession } = require("../lib/push-audience");

function spy() {
  var calls = [];
  return {
    calls: calls,
    sendPush: function (p) { calls.push({ to: "everyone", payload: p }); },
    sendPushToUser: function (u, p) { calls.push({ to: u, payload: p }); },
  };
}

var SCHEMA = { type: "object", properties: { token: { type: "string" } } };
var ASK = { questions: [{ question: "Which target?", options: [{ label: "staging" }] }] };

// Each opener makes one first-notice push for the server's session.
var TYPES = {
  permission_request: function (server) {
    server.ask("Bash", { command: "make" });
  },
  elicitation: function (server) {
    server.bridge.handleElicitation(server.session, { serverName: "deploy", message: "Token?", requestedSchema: SCHEMA }, { signal: server.issueSignal().signal });
  },
  ask_user: function (server) {
    server.sdk({ yokeType: "tool_start", blockId: 0, toolId: "tu-ask", toolName: "AskUserQuestion" });
    server.sdk({ yokeType: "tool_input_delta", blockId: 0, partialJson: JSON.stringify(ASK) });
    server.sdk({ yokeType: "block_stop", blockId: 0 });
  },
  done: function (server) {
    server.sdk({ yokeType: "result", cost: 0.01, duration: 10, sessionId: "cli" });
  },
};

async function run(type, opts) {
  var push = spy();
  var server = await world.createServer({ pushModule: push, multiUser: opts.multiUser });
  try {
    await server.startQuery();
    if (opts.ownerId) server.session.ownerId = opts.ownerId;
    TYPES[type](server);
    await new Promise(function (r) { setImmediate(r); });
    return push.calls.filter(function (c) { return c.payload.type === type; });
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
}

Object.keys(TYPES).forEach(function (type) {
  test(type + ": multi-user, ownerless session: no push reaches any subscriber", async function () {
    assert.deepEqual(await run(type, { multiUser: true }), []);
  });

  test(type + ": multi-user, owned session: the owner alone is pushed", async function () {
    var calls = await run(type, { multiUser: true, ownerId: "alice" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].to, "alice");
  });

  test(type + ": single-user, ownerless session: still a broadcast", async function () {
    var calls = await run(type, { multiUser: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].to, "everyone");
  });
});

test("pushForSession: the rule, with every mode a caller can be in", function () {
  var p = { type: "x" };
  function go(owner, mode) {
    var s = spy();
    var where = pushForSession(s, owner, p, mode);
    return { where: where, calls: s.calls };
  }
  assert.equal(go("alice", function () { return true; }).calls[0].to, "alice");
  assert.equal(go("alice", function () { return false; }).calls[0].to, "alice");
  assert.deepEqual(go(null, function () { return true; }), { where: "none", calls: [] });
  assert.deepEqual(go(undefined, function () { return true; }), { where: "none", calls: [] });
  assert.deepEqual(go(null, function () { throw new Error("unreadable"); }), { where: "none", calls: [] });
  var single = go(null, function () { return false; });
  assert.equal(single.where, "broadcast");
  assert.equal(single.calls[0].to, "everyone");
  assert.equal(pushForSession(null, "alice", p), "none");
});

test("pushForSession: with no mode given it reads the stored users file, and an absent file is multi-user", function () {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "push-audience-"));
  var prev = process.env.CLAGENTIC_CONSOLE_HOME;
  process.env.CLAGENTIC_CONSOLE_HOME = home;
  var libDir = path.join(__dirname, "..", "lib") + path.sep;
  Object.keys(require.cache).forEach(function (k) {
    if (k.indexOf(libDir) === 0) delete require.cache[k];
  });
  try {
    var audience = require("../lib/push-audience");
    var s = spy();
    assert.equal(audience.pushForSession(s, null, { type: "x" }), "none");
    fs.mkdirSync(path.join(home, "console"), { recursive: true });
    fs.writeFileSync(path.join(home, "console", "users.json"), JSON.stringify({ multiUser: false }));
    assert.equal(audience.pushForSession(s, null, { type: "x" }), "broadcast");
  } finally {
    if (prev === undefined) delete process.env.CLAGENTIC_CONSOLE_HOME; else process.env.CLAGENTIC_CONSOLE_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("no push site keeps its own owner-or-broadcast branch", function () {
  ["sdk-bridge.js", "sdk-message-processor.js", "project-loop.js", "prompt-reminders.js"].forEach(function (f) {
    var src = fs.readFileSync(path.join(__dirname, "..", "lib", f), "utf8");
    assert.ok(!/pushModule\.sendPush\(|push\.sendPush\(/.test(src), f + " pushes through lib/push-audience.js");
  });
});

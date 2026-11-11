"use strict";

// Who a session's push reaches (lib/push-audience.js), on the real SDK bridge and
// message processor for the first-notice types. In multi-user mode a session
// with no owner pushes to the admins only: a broadcast would hand a non-owner
// subscriber the tool input.

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

var USERS = [
  { id: "admin-1", username: "root", role: "admin" },
  { id: "bob", username: "bob", role: "user" },
];
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
    // The push follows the prompt the permission callback opens.
    server.ask("AskUserQuestion", ASK, { toolUseID: "tu-ask" });
  },
  done: function (server) {
    server.sdk({ yokeType: "result", cost: 0.01, duration: 10, sessionId: "cli" });
  },
};

// The push payload type a notification type is raised under, where it differs
// from the name the test goes by.
var PAYLOAD_TYPE = { done: "response_done" };

async function run(type, opts) {
  var push = spy();
  var server = await world.createServer({ pushModule: push, multiUser: opts.multiUser, users: opts.users });
  try {
    await server.startQuery();
    if (opts.ownerId) server.session.ownerId = opts.ownerId;
    TYPES[type](server);
    await new Promise(function (r) { setImmediate(r); });
    return push.calls.filter(function (c) { return c.payload.type === (PAYLOAD_TYPE[type] || type); });
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
}

Object.keys(TYPES).forEach(function (type) {
  test(type + ": multi-user, ownerless session: the admin alone is pushed, never a non-admin", async function () {
    var calls = await run(type, { multiUser: true, users: USERS });
    assert.deepEqual(calls.map(function (c) { return c.to; }), ["admin-1"]);
  });

  test(type + ": multi-user, ownerless session, no admin on record: no push", async function () {
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
  function admins() { return ["admin-1", "admin-2"]; }
  function goAdmins(owner, mode, list) {
    var s = spy();
    return { where: pushForSession(s, owner, p, mode, list), calls: s.calls };
  }
  var multi = goAdmins(null, function () { return true; }, admins);
  assert.equal(multi.where, "admins");
  assert.deepEqual(multi.calls.map(function (c) { return c.to; }), ["admin-1", "admin-2"]);
  var unreadable = goAdmins(undefined, function () { throw new Error("unreadable"); }, admins);
  assert.equal(unreadable.where, "admins", "an unreadable mode counts as multi-user");
  assert.deepEqual(goAdmins(null, function () { return true; }, function () { return []; }), { where: "none", calls: [] });
  assert.deepEqual(goAdmins(null, function () { return true; }, function () { throw new Error("no store"); }), { where: "none", calls: [] });
  assert.equal(goAdmins("alice", function () { return true; }, admins).calls.length, 1, "an owned session never reaches the admins");
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
    assert.equal(audience.pushForSession(s, null, { type: "x" }), "none", "no admin on record");
    fs.mkdirSync(path.join(home, "console"), { recursive: true });
    fs.writeFileSync(path.join(home, "console", "users.json"), JSON.stringify({ users: [{ id: "a1", username: "a", role: "admin" }, { id: "u1", username: "u", role: "user" }] }));
    assert.equal(audience.pushForSession(s, null, { type: "x" }), "admins");
    assert.deepEqual(s.calls.map(function (c) { return c.to; }), ["a1"]);
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

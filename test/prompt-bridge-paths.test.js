"use strict";
// The SDK bridge's own announcements and bookkeeping around a prompt, on the
// real server modules (prompt-harness-world.js):
//   - a prompt that ended before it could be shown (its signal was already
//     aborted) is never pushed to a phone, for any kind that pushes;
//   - the SDK task-id mapping of a still-running Task survives its parent's
//     turn boundary, so the sub-agent's later task_updated and
//     task_notification still correlate.

var test = require("node:test");
var assert = require("node:assert/strict");
var world = require("./prompt-harness-world");

function pushSpy() {
  var sent = [];
  return {
    sent: sent,
    sendPush: function (payload) { sent.push(payload); },
    sendPushToUser: function (userId, payload) { sent.push(payload); },
  };
}

async function withServer(opts, fn) {
  var server = await world.createServer(opts);
  try {
    await server.startQuery();
    await fn(server);
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
}

function abortedSignal() {
  var ac = new AbortController();
  ac.abort();
  return ac.signal;
}

test("no prompt of any pushing kind is pushed once its signal has already aborted", async function () {
  var push = pushSpy();
  await withServer({ pushModule: push }, async function (server) {
    var session = server.session;
    var schema = { type: "object", properties: { token: { type: "string" } } };
    var openers = {
      elicitation: function (signal) {
        return server.bridge.handleElicitation(session, { serverName: "deploy", message: "Token?", requestedSchema: schema }, { signal: signal });
      },
      permission: function (signal) {
        return server.bridge.handleCanUseTool(session, "Bash", { command: "make" }, { toolUseID: "tu-" + Math.random(), signal: signal });
      },
      plan: function (signal) {
        return server.bridge.handleCanUseTool(session, "ExitPlanMode", { plan: "p" }, { toolUseID: "tu-" + Math.random(), signal: signal });
      },
    };
    var kinds = Object.keys(openers);
    for (var i = 0; i < kinds.length; i++) {
      push.sent.length = 0;
      var ended = await openers[kinds[i]](abortedSignal());
      assert.ok(ended.behavior === "deny" || ended.action === "reject", kinds[i] + ": an aborted prompt stops the call");
      assert.deepEqual(push.sent, [], kinds[i] + ": nothing is pushed for a prompt nobody can answer");

      var live = new AbortController();
      var pending = openers[kinds[i]](live.signal);
      assert.equal(push.sent.length, 1, kinds[i] + ": a pending prompt is pushed once");
      live.abort();
      await pending;
    }
  });
});

test("a running Task's SDK task-id mapping survives its parent's turn and keeps correlating", async function () {
  await withServer({}, async function (server) {
    var session = server.session;
    function spawn(toolId) {
      server.sdk({ yokeType: "tool_start", blockId: 0, toolId: toolId, toolName: "Task" });
      server.sdk({ yokeType: "block_stop", blockId: 0 });
    }
    spawn("task-live");
    server.sdk({ yokeType: "task_started", parentToolId: "task-live", taskId: "sdk-live" });
    spawn("task-done");
    server.sdk({ yokeType: "task_started", parentToolId: "task-done", taskId: "sdk-done" });
    server.sdk({ yokeType: "message", messageRole: "user", content: [{ type: "tool_result", tool_use_id: "task-done", content: "ok" }] });

    server.sdk({ yokeType: "result", cost: 0.01, duration: 10, sessionId: "cli" });
    assert.deepEqual(session.taskIdMap, { "task-live": "sdk-live" },
      "keyed by the Task's tool-use id: the running Task keeps its mapping, the finished one is dropped");

    server.sdk({ yokeType: "task_updated", taskId: "sdk-live", patch: { status: "running" } });
    var updated = session.history.filter(function (m) { return m.type === "task_updated"; });
    assert.deepEqual(updated.map(function (m) { return m.parentToolId; }), ["task-live"], "a later task_updated still finds its Task");

    server.sdk({ yokeType: "task_notification", parentToolId: "task-live", taskId: "sdk-live", status: "completed" });
    assert.deepEqual(session.taskIdMap, {}, "the sub-agent's completion drains its mapping");
  });
});

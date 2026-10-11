"use strict";
// A project's handlers reach the daemon through callbacks (opts.onSomething)
// that lib/daemon.js gives lib/server.js, and server.js must hand on to each
// project it creates. A callback that is not forwarded fails without a sound:
// the Settings page that uses it is answered "Not supported", as saved
// environment variables were. A real server, a real WebSocket client, and
// callbacks that record what reached them.

var test = require("node:test");
var assert = require("node:assert/strict");

var harness = require("./access-harness");

var calls = [];
var projectText = "";
var sharedText = "";

var callbacks = {
  onGetProjectEnv: function (slug) {
    calls.push({ callback: "onGetProjectEnv", args: [slug] });
    return { envrc: projectText };
  },
  onSetProjectEnv: function (slug, envrc) {
    calls.push({ callback: "onSetProjectEnv", args: [slug, envrc] });
    projectText = envrc;
    return { ok: true };
  },
  onGetSharedEnv: function () {
    calls.push({ callback: "onGetSharedEnv", args: [] });
    return { envrc: sharedText };
  },
  onSetSharedEnv: function (envrc) {
    calls.push({ callback: "onSetSharedEnv", args: [envrc] });
    sharedText = envrc;
    return { ok: true };
  },
  onSetAutoContinue: function (value) {
    calls.push({ callback: "onSetAutoContinue", args: [value] });
    return { ok: true, autoContinueOnRateLimit: value };
  },
  onSetTokensPerMbHeadroom: function (value) {
    calls.push({ callback: "onSetTokensPerMbHeadroom", args: [value] });
    return { ok: true, tokensPerMbHeadroom: value };
  },
};

var server = null;
var admin = null;

test.before(async function () {
  server = await harness.start({
    users: [{ key: "admin", username: "admin", role: "admin" }],
    projects: [{ slug: "alpha", ownerKey: "admin" }],
    serverOpts: callbacks,
  });
  admin = await server.connect("alpha", "admin");
  assert.equal(admin.ok, true);
});

test.after(async function () {
  if (server) await server.stop();
});

async function ask(message, resultType) {
  admin.inbox.length = 0;
  calls.length = 0;
  admin.send(message);
  return admin.waitFor(function (m) { return m.type === resultType; });
}

test("setting a project's environment over the WebSocket reaches the daemon's callback with the project and the text", async function () {
  var result = await ask({ type: "set_project_env", envrc: "export FROM_WS=1" }, "set_project_env_result");
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(calls, [{ callback: "onSetProjectEnv", args: ["alpha", "export FROM_WS=1"] }]);
});

test("reading a project's environment over the WebSocket is answered by the daemon's callback", async function () {
  projectText = "export READ_BACK=1";
  var result = await ask({ type: "get_project_env" }, "project_env_result");
  assert.equal(result.envrc, "export READ_BACK=1");
  assert.deepEqual(calls, [{ callback: "onGetProjectEnv", args: ["alpha"] }]);
});

test("setting the shared environment over the WebSocket reaches the daemon's callback with the text", async function () {
  var result = await ask({ type: "set_shared_env", envrc: "export SHARED_FROM_WS=1" }, "set_shared_env_result");
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(calls, [{ callback: "onSetSharedEnv", args: ["export SHARED_FROM_WS=1"] }]);
});

test("reading the shared environment over the WebSocket is answered by the daemon's callback", async function () {
  sharedText = "export SHARED_READ_BACK=1";
  var result = await ask({ type: "get_shared_env" }, "shared_env_result");
  assert.equal(result.envrc, "export SHARED_READ_BACK=1");
  assert.deepEqual(calls, [{ callback: "onGetSharedEnv", args: [] }]);
});

test("the auto-continue and tokens-per-MB settings reach the daemon's callbacks with the value sent", async function () {
  var autoContinue = await ask({ type: "set_auto_continue", value: true }, "set_auto_continue_result");
  assert.equal(autoContinue.ok, true);
  assert.equal(autoContinue.autoContinueOnRateLimit, true);
  assert.deepEqual(calls, [{ callback: "onSetAutoContinue", args: [true] }]);

  var headroom = await ask({ type: "set_tokens_per_mb_headroom", value: 321 }, "set_tokens_per_mb_headroom_result");
  assert.equal(headroom.ok, true);
  assert.equal(headroom.tokensPerMbHeadroom, 321);
  assert.deepEqual(calls, [{ callback: "onSetTokensPerMbHeadroom", args: [321] }]);
});

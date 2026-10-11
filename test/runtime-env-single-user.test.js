"use strict";
// Single-user mode: the one owner's connection has no user record, and the
// shared and the project's variables reach every runtime of the project, a
// worktree's included. A real Clagentic: Console server and WebSocket client;
// only the login gate and the Claude Agent SDK are stand-ins.

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var nodeModule = require("node:module");
var { pathToFileURL } = require("url");

// Before anything imports the SDK, so the adapter's dynamic import gets the stand-in.
nodeModule.register(pathToFileURL(path.join(__dirname, "fixtures", "fake-agent-sdk", "resolve-hook.mjs")).href);

var harness = require("./access-harness");
var { createEnvSettings } = require("../lib/daemon-env-settings");

var config = { sharedEnv: "", projects: [{ slug: "mine" }] };
var envSettings = createEnvSettings({
  getConfig: function () { return config; },
  saveConfig: function () {},
  onChanged: function () {
    server.relay.forEachProject(function (ctx) { ctx.sdk.applyRuntimeEnvChange(); });
  },
});

var server = null;
var mine = null;
var worktree = null;
var owner = null;

function fakeQueries() { return globalThis.__fakeAgentSdkQueries || []; }
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

async function waitFor(predicate, label) {
  for (var i = 0; i < 100; i++) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error("timed out waiting for " + label);
}

async function envOf(ctx, sessionOpts) {
  var session = ctx.sm.createSessionRaw(sessionOpts || {});
  var before = fakeQueries().length;
  await ctx.sdk.startQuery(session, "go", null, null);
  await waitFor(function () { return fakeQueries().length > before; }, "the query to start");
  var env = fakeQueries()[fakeQueries().length - 1].env;
  if (session.queryInstance) session.queryInstance.close();
  if (session.streamPromise) await session.streamPromise;
  return env;
}

async function save(type, resultType, envrc) {
  owner.inbox.length = 0;
  owner.send({ type: type, envrc: envrc });
  return owner.waitFor(function (m) { return m.type === resultType; });
}

test.before(async function () {
  server = await harness.start({
    multiUser: false,
    users: [],
    projects: [{ slug: "mine" }, { slug: "mine--wt", parent: "mine" }],
    serverOpts: Object.assign({ isMultiUser: function () { return false; } }, envSettings),
    beforeServer: function () {
      var serverAuth = require("../lib/server-auth");
      var attach = serverAuth.attachAuth;
      serverAuth.attachAuth = function (deps) {
        return Object.assign({}, attach(deps), {
          getMultiUserFromReq: function () { return null; },
          isRequestAuthed: function () { return true; },
        });
      };
      // The stand-in SDK needs no CLI, so hand the project the real Claude adapter.
      var yoke = require("../lib/yoke");
      yoke.createAdapters = function (opts) {
        return { adapters: { claude: yoke.createAdapter({ vendor: "claude", cwd: opts.cwd }) }, auth: { claude: true } };
      };
    },
  });
  server.relay.forEachProject(function (ctx, slug) {
    if (slug === "mine") mine = ctx;
    if (slug === "mine--wt") worktree = ctx;
  });
  owner = await server.connect("mine", null);
  assert.equal(owner.ok, true);
  await sleep(400);
});

test.after(async function () {
  if (server) await server.stop();
});

test("the owner saves variables in Settings: every session in the project gets them, owned or not", async function () {
  var shared = await save("set_shared_env", "set_shared_env_result", "export SHARED_ONLY=from-shared");
  assert.equal(shared.ok, true, shared.error);
  var project = await save("set_project_env", "set_project_env_result", "export PROJECT_ONLY=from-project\nexport ANTHROPIC_BASE_URL=https://own.example.invalid");
  assert.equal(project.ok, true, project.error);

  var unowned = await envOf(mine);
  var owned = await envOf(mine, { ownerId: "some-id" });

  [unowned, owned].forEach(function (env) {
    assert.equal(env.SHARED_ONLY, "from-shared");
    assert.equal(env.PROJECT_ONLY, "from-project");
    assert.equal(env.ANTHROPIC_BASE_URL, "https://own.example.invalid");
  });
});

test("a worktree runs with its parent's variables", async function () {
  config.sharedEnv = "SHARED_ONLY=from-shared";
  config.projects[0].envrc = "PROJECT_ONLY=from-project";
  var env = await envOf(worktree);
  assert.equal(env.PROJECT_ONLY, "from-project");
  assert.equal(env.SHARED_ONLY, "from-shared");
});

test("a runtime that serves no one session, such as a warmup, gets the project's variables too", function () {
  config.sharedEnv = "SHARED_ONLY=from-shared";
  config.projects[0].envrc = "PROJECT_ONLY=from-project";
  assert.deepEqual(mine.sdk.getRuntimeEnvOverlay(), { SHARED_ONLY: "from-shared", PROJECT_ONLY: "from-project" });
});

test("the owner's Settings page is told the variables apply to every session", async function () {
  owner.inbox.length = 0;
  owner.send({ type: "get_project_env" });
  var read = await owner.waitFor(function (m) { return m.type === "project_env_result"; });
  assert.equal(read.appliesTo, "everyone");
  assert.equal(read.canEdit, true);
});

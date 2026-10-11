"use strict";
// Environment variables saved in Settings (shared, and per project) reach the
// environment an agent runtime is started with. A real Clagentic: Console
// server, real WebSocket clients, the real project context and SDK bridge and
// the real Claude adapter; only the Claude Agent SDK is the stand-in in
// test/fixtures/fake-agent-sdk, which reports the environment the Claude Code
// subprocess would get (options.env REPLACES the inherited environment).

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var nodeModule = require("node:module");
var { pathToFileURL } = require("url");

// Before anything imports the SDK, so the adapter's dynamic import gets the stand-in.
nodeModule.register(pathToFileURL(path.join(__dirname, "fixtures", "fake-agent-sdk", "resolve-hook.mjs")).href);

var harness = require("./access-harness");

// The store the daemon keeps the two texts in (lib/daemon.js onGet/SetProjectEnv,
// onGet/SetSharedEnv): the shared text on the config, the project's on its record.
function makeConfigStore() {
  var config = { sharedEnv: "", projects: [{ slug: "alpha", envrc: "" }] };
  function projectRecord(slug) {
    return config.projects.find(function (p) { return p.slug === slug; }) || null;
  }
  return {
    config: config,
    handlers: {
      onGetProjectEnv: function (slug) { var p = projectRecord(slug); return { envrc: (p && p.envrc) || "" }; },
      onSetProjectEnv: function (slug, envrc) {
        var p = projectRecord(slug);
        if (!p) return { ok: false, error: "Project not found" };
        p.envrc = envrc;
        return { ok: true };
      },
      onGetSharedEnv: function () { return { envrc: config.sharedEnv || "" }; },
      onSetSharedEnv: function (envrc) { config.sharedEnv = envrc; return { ok: true }; },
    },
  };
}

var store = makeConfigStore();
var server = null;
var admin = null;
var alpha = null;

function fakeQueries() {
  return globalThis.__fakeAgentSdkQueries || [];
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function waitFor(predicate, label) {
  for (var i = 0; i < 100; i++) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error("timed out waiting for " + label);
}

// Starts one query in the project and returns the environment the Claude Code
// subprocess was given.
async function envOfNextQuery() {
  var before = fakeQueries().length;
  var session = alpha.sm.createSessionRaw({});
  await alpha.sdk.startQuery(session, "go", null, null);
  await waitFor(function () { return fakeQueries().length > before; }, "the query to start");
  var env = fakeQueries()[fakeQueries().length - 1].env;
  if (session.queryInstance) session.queryInstance.close();
  if (session.streamPromise) await session.streamPromise;
  return env;
}

test.before(async function () {
  server = await harness.start({
    users: [{ key: "admin", username: "admin", role: "admin" }],
    projects: [{ slug: "alpha", ownerKey: "admin" }],
    serverOpts: store.handlers,
    beforeServer: function () {
      // The project context builds its adapters from the host's installed CLIs;
      // the stand-in SDK needs no CLI, so hand it the real Claude adapter.
      var yoke = require("../lib/yoke");
      yoke.createAdapters = function (opts) {
        return { adapters: { claude: yoke.createAdapter({ vendor: "claude", cwd: opts.cwd }) }, auth: { claude: true } };
      };
    },
  });
  server.relay.forEachProject(function (ctx, slug) { if (slug === "alpha") alpha = ctx; });
  admin = await server.connect("alpha", "admin");
  assert.equal(admin.ok, true);
  // The first connection warms the adapters up; let that query pass.
  await sleep(400);
});

test.after(async function () {
  if (server) await server.stop();
});

function resetSettings() {
  store.config.sharedEnv = "";
  store.config.projects[0].envrc = "";
}

test("variables saved as the shared and the project text are in the environment the runtime starts with", async function () {
  resetSettings();
  store.config.sharedEnv = "OPENAI_BASE_URL=https://shared.example.invalid/v1\nSHARED_ONLY=from-shared\nOVERRIDDEN=shared";
  store.config.projects[0].envrc = "PROJECT_ONLY=from-project\nOVERRIDDEN=project";

  var env = await envOfNextQuery();

  assert.equal(env.OPENAI_BASE_URL, "https://shared.example.invalid/v1");
  assert.equal(env.SHARED_ONLY, "from-shared");
  assert.equal(env.PROJECT_ONLY, "from-project");
  assert.equal(env.OVERRIDDEN, "project", "the project text overrides the shared text");
});

test("the SDK replaces the environment, so the runtime still has the daemon's PATH and HOME next to the settings", async function () {
  resetSettings();
  store.config.sharedEnv = "SHARED_ONLY=from-shared";

  var env = await envOfNextQuery();

  assert.equal(env.SHARED_ONLY, "from-shared");
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.HOME, process.env.HOME);
});

test("a user who saves variables in Settings causes them to reach the runtime", async function () {
  resetSettings();
  // The rows the Settings pages write: "export KEY=VALUE".
  admin.inbox.length = 0;
  admin.send({ type: "set_shared_env", envrc: "export OPENAI_BASE_URL=https://ui.example.invalid/v1\nexport SHARED_ONLY=ui-shared" });
  var sharedSaved = await admin.waitFor(function (m) { return m.type === "set_shared_env_result"; });
  assert.equal(sharedSaved.ok, true, "the shared text is accepted: " + sharedSaved.error);

  admin.send({ type: "set_project_env", envrc: "export PROJECT_ONLY=ui-project" });
  var projectSaved = await admin.waitFor(function (m) { return m.type === "set_project_env_result"; });
  assert.equal(projectSaved.ok, true, "the project text is accepted: " + projectSaved.error);

  var env = await envOfNextQuery();

  assert.equal(env.OPENAI_BASE_URL, "https://ui.example.invalid/v1");
  assert.equal(env.SHARED_ONLY, "ui-shared");
  assert.equal(env.PROJECT_ONLY, "ui-project");
});

"use strict";
// Environment variables saved in Settings (shared, and per project) reach the
// environment an agent runtime is started with. A real Clagentic: Console
// server, real WebSocket clients, the real project context and SDK bridge, the
// real Claude adapter and the daemon's own settings store; only the Claude
// Agent SDK is the stand-in in test/fixtures/fake-agent-sdk, which reports the
// environment the Claude Code subprocess would get (options.env REPLACES the
// inherited environment).

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var nodeModule = require("node:module");
var { pathToFileURL } = require("url");

// Before anything imports the SDK, so the adapter's dynamic import gets the stand-in.
nodeModule.register(pathToFileURL(path.join(__dirname, "fixtures", "fake-agent-sdk", "resolve-hook.mjs")).href);

var harness = require("./access-harness");
var { createEnvSettings } = require("../lib/daemon-env-settings");

// What lib/daemon.js keeps: the shared text on the config, a project's on its record.
var config = { sharedEnv: "", projects: [{ slug: "alpha" }, { slug: "beta" }] };
var saves = 0;
var envSettings = createEnvSettings({
  getConfig: function () { return config; },
  saveConfig: function () { saves++; },
});

var server = null;
var admin = null;
var alpha = null;
var beta = null;

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

// Starts one query in the project and returns the session and the environment
// the Claude Code subprocess was given. The session belongs to the project's
// owner (the administrator here): in multi-user mode a project's variables
// reach the owner's sessions, and test/runtime-env-owner-scope.test.js covers
// everyone else's.
async function startQueryIn(ctx, session) {
  var before = fakeQueries().length;
  session = session || ctx.sm.createSessionRaw({ ownerId: server.people.admin.id });
  await ctx.sdk.startQuery(session, "go", null, null);
  await waitFor(function () { return fakeQueries().length > before; }, "the query to start");
  return { session: session, env: fakeQueries()[fakeQueries().length - 1].env };
}

async function endQuery(session) {
  if (session.queryInstance) session.queryInstance.close();
  if (session.streamPromise) await session.streamPromise;
}

async function envOfNextQuery(ctx) {
  var started = await startQueryIn(ctx || alpha);
  await endQuery(started.session);
  return started.env;
}

async function save(type, resultType, envrc) {
  admin.inbox.length = 0;
  admin.send({ type: type, envrc: envrc });
  return admin.waitFor(function (m) { return m.type === resultType; });
}

function resetSettings() {
  config.sharedEnv = "";
  delete config.projects[0].envrc;
  delete config.projects[1].envrc;
}

test.before(async function () {
  server = await harness.start({
    users: [{ key: "admin", username: "admin", role: "admin" }],
    projects: [{ slug: "alpha", ownerKey: "admin" }, { slug: "beta", ownerKey: "admin" }],
    serverOpts: envSettings,
    beforeServer: function () {
      // The project context builds its adapters from the host's installed CLIs;
      // the stand-in SDK needs no CLI, so hand it the real Claude adapter.
      var yoke = require("../lib/yoke");
      yoke.createAdapters = function (opts) {
        return { adapters: { claude: yoke.createAdapter({ vendor: "claude", cwd: opts.cwd }) }, auth: { claude: true } };
      };
    },
  });
  server.relay.forEachProject(function (ctx, slug) {
    if (slug === "alpha") alpha = ctx;
    if (slug === "beta") beta = ctx;
  });
  admin = await server.connect("alpha", "admin");
  assert.equal(admin.ok, true);
  // The first connection warms the adapters up; let that query pass.
  await sleep(400);
});

test.after(async function () {
  if (server) await server.stop();
});

test("variables saved as the shared and the project text are in the environment the runtime starts with", async function () {
  resetSettings();
  config.sharedEnv = "OPENAI_BASE_URL=https://shared.example.invalid/v1\nSHARED_ONLY=from-shared\nOVERRIDDEN=shared";
  config.projects[0].envrc = "PROJECT_ONLY=from-project\nOVERRIDDEN=project";

  var env = await envOfNextQuery();

  assert.equal(env.OPENAI_BASE_URL, "https://shared.example.invalid/v1");
  assert.equal(env.SHARED_ONLY, "from-shared");
  assert.equal(env.PROJECT_ONLY, "from-project");
  assert.equal(env.OVERRIDDEN, "project", "the project text overrides the shared text");
});

test("the SDK replaces the environment, so the runtime still has the daemon's PATH and HOME next to the settings", async function () {
  resetSettings();
  config.sharedEnv = "SHARED_ONLY=from-shared";

  var env = await envOfNextQuery();

  assert.equal(env.SHARED_ONLY, "from-shared");
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.HOME, process.env.HOME);
});

test("a project's variables reach that project's runtimes and no other project's", async function () {
  resetSettings();
  config.projects[0].envrc = "ALPHA_ONLY=1";

  var alphaEnv = await envOfNextQuery(alpha);
  var betaEnv = await envOfNextQuery(beta);

  assert.equal(alphaEnv.ALPHA_ONLY, "1");
  assert.equal(betaEnv.ALPHA_ONLY, undefined);
});

test("a project with no variables of its own and no shared variables starts with the daemon's environment", async function () {
  resetSettings();

  var started = await startQueryIn(alpha);
  await endQuery(started.session);

  var query = fakeQueries()[fakeQueries().length - 1];
  assert.equal(query.env.PATH, process.env.PATH);
  assert.equal(query.env.ALPHA_ONLY, undefined, "no Settings variable is added");
  assert.equal(query.env.CLAUDE_AGENT_SDK_CLIENT_APP, "clagentic-console/" + require("../package.json").version, "only the product identity is");
});

test("a user who saves variables in Settings causes them to reach the runtime", async function () {
  resetSettings();
  // The rows the Settings pages write: "export KEY=VALUE".
  var sharedSaved = await save("set_shared_env", "set_shared_env_result",
    "export OPENAI_BASE_URL=https://ui.example.invalid/v1\nexport SHARED_ONLY=ui-shared");
  assert.equal(sharedSaved.ok, true, "the shared text is accepted: " + sharedSaved.error);

  var projectSaved = await save("set_project_env", "set_project_env_result", "export PROJECT_ONLY=ui-project");
  assert.equal(projectSaved.ok, true, "the project text is accepted: " + projectSaved.error);

  var env = await envOfNextQuery();

  assert.equal(env.OPENAI_BASE_URL, "https://ui.example.invalid/v1");
  assert.equal(env.SHARED_ONLY, "ui-shared");
  assert.equal(env.PROJECT_ONLY, "ui-project");
  assert.equal(admin.inbox.some(function (m) { return JSON.stringify(m).indexOf("ui-project") !== -1; }), false,
    "the answer to a save carries no value");
});

test("what a user saved is what the Settings pages read back", async function () {
  resetSettings();
  await save("set_shared_env", "set_shared_env_result", "export A=1\nexport B=two");
  admin.inbox.length = 0;
  admin.send({ type: "get_shared_env" });
  var shared = await admin.waitFor(function (m) { return m.type === "shared_env_result"; });
  assert.equal(shared.envrc, "export A=1\nexport B=two");
});

test("a protected variable is refused when saved, from the shared page and the project page alike", async function () {
  resetSettings();
  var savesBefore = saves;

  var shared = await save("set_shared_env", "set_shared_env_result", "export OK_ONE=1\nexport PATH=/tmp/evil");
  assert.equal(shared.ok, false);
  assert.match(shared.error, /PATH cannot be set here/);
  assert.match(shared.error, /line 2/i);

  var project = await save("set_project_env", "set_project_env_result", "export BASH_ENV=/tmp/evil.sh");
  assert.equal(project.ok, false);
  assert.match(project.error, /BASH_ENV cannot be set here/);

  assert.equal(saves, savesBefore, "nothing was stored");
  assert.equal(config.sharedEnv, "");
  assert.equal(config.projects[0].envrc, undefined);
});

test("a protected variable already in a saved text is dropped when the runtime starts, with one warning and no value", async function () {
  resetSettings();
  config.sharedEnv = "KEEP_SHARED=kept\nPATH=/tmp/evil-path\nNODE_OPTIONS=--require=/tmp/evil-secret.js";
  config.projects[0].envrc = "KEEP_PROJECT=kept\nBASH_ENV=/tmp/evil-secret.sh";
  var warnings = [];
  var realWarn = console.warn;
  console.warn = function () { warnings.push(Array.prototype.join.call(arguments, " ")); };
  var first;
  var second;
  try {
    first = await envOfNextQuery();
    second = await envOfNextQuery();
  } finally {
    console.warn = realWarn;
  }

  assert.equal(first.KEEP_SHARED, "kept");
  assert.equal(first.KEEP_PROJECT, "kept");
  assert.equal(first.PATH, process.env.PATH);
  assert.notEqual(first.NODE_OPTIONS, "--require=/tmp/evil-secret.js");
  assert.equal(first.BASH_ENV, process.env.BASH_ENV, "the project text cannot set it");
  assert.equal(second.PATH, process.env.PATH);

  var mine = warnings.filter(function (w) { return w.indexOf("[runtime-env]") !== -1; });
  ["PATH", "NODE_OPTIONS", "BASH_ENV"].forEach(function (name) {
    assert.equal(mine.filter(function (w) { return w.indexOf(name) !== -1; }).length, 1, name + " is warned about once");
  });
  mine.forEach(function (w) { assert.equal(w.indexOf("evil"), -1, "a warning never carries a value: " + w); });
});

test("a runtime attached when Settings change is untouched; a session started after the save has the change", async function () {
  resetSettings();
  var started = await startQueryIn(alpha);
  var attached = started.session;
  assert.equal(started.env.LATE_ADDITION, undefined);
  attached.isProcessing = false;
  var runtime = attached.queryInstance;
  assert.ok(runtime, "the runtime is up, waiting for the next message");

  var saved = await save("set_project_env", "set_project_env_result", "export LATE_ADDITION=now");
  assert.equal(saved.ok, true, saved.error);

  var outcome = await Promise.race([
    attached.streamPromise.then(function () { return "ended"; }),
    sleep(400).then(function () { return "still running"; }),
  ]);
  assert.equal(outcome, "still running", "the idle attached runtime was not ended by the save");
  assert.equal(attached.queryInstance, runtime);

  var next = await startQueryIn(alpha);
  assert.equal(next.env.LATE_ADDITION, "now", "a session started after the save has the new variables");

  await endQuery(next.session);
  await endQuery(attached);
});

test("a runtime that is running a turn when Settings change is not killed", async function () {
  resetSettings();
  var started = await startQueryIn(alpha);
  var session = started.session;
  session.isProcessing = true;
  var runtime = session.queryInstance;

  var saved = await save("set_project_env", "set_project_env_result", "export WHILE_RUNNING=1");
  assert.equal(saved.ok, true, saved.error);
  await sleep(100);

  assert.equal(session.queryInstance, runtime, "the running turn's runtime is untouched");

  session.isProcessing = false;
  await endQuery(session);
});

test("title generation runs with the saved variables", async function () {
  resetSettings();
  config.sharedEnv = "TITLE_SEES_THIS=yes";
  var session = alpha.sm.createSessionRaw({});
  alpha.sm.recordHistoryEntry(session, { type: "user_message", text: "fix the build" }, true);
  var before = fakeQueries().length;

  await alpha.sdk._test_autoGenerateTitle(session);

  var titleQueries = fakeQueries().slice(before).filter(function (q) { return q.model === "haiku"; });
  assert.equal(titleQueries.length, 1);
  assert.equal(titleQueries[0].env.TITLE_SEES_THIS, "yes");
  assert.equal(titleQueries[0].env.PATH, process.env.PATH);
});

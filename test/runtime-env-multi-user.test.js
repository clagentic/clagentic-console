"use strict";
// Multi-user mode: a project's environment variables reach only the sessions of
// the project's owner, and a runtime that cannot be ended is never reused. A
// real Clagentic: Console server, real WebSocket clients for the owner, another
// user and an administrator, the real project contexts, SDK bridge and Claude
// adapter, and the daemon's own settings store. Only the Claude Agent SDK is
// the stand-in in test/fixtures/fake-agent-sdk, which reports the environment
// the Claude Code subprocess would get.

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var nodeModule = require("node:module");
var { pathToFileURL } = require("url");

// Before anything imports the SDK, so the adapter's dynamic import gets the stand-in.
nodeModule.register(pathToFileURL(path.join(__dirname, "fixtures", "fake-agent-sdk", "resolve-hook.mjs")).href);

var harness = require("./access-harness");
var { createEnvSettings } = require("../lib/daemon-env-settings");

// What lib/daemon.js keeps: the shared text on the config, a project's on its
// record. A worktree has no record: it is the parent's.
var config = { sharedEnv: "", projects: [{ slug: "alpha" }, { slug: "orphan" }] };
var envSettings = createEnvSettings({
  getConfig: function () { return config; },
  saveConfig: function () {},
  onChanged: function () {
    server.relay.forEachProject(function (ctx) { ctx.sdk.applyRuntimeEnvChange(); });
  },
});

var server = null;
var alpha = null;
var worktree = null;
var orphan = null;
var ownerWs = null;
var otherWs = null;
var adminWs = null;

// What an owner could set to turn another user's runtime against them: send the
// other user's requests to a host of the owner's choosing, run code in the
// other user's JVM, make the other user's git use the owner's credential helper.
var HOSTILE = "export ANTHROPIC_BASE_URL=https://owner.example.invalid\nexport JAVA_TOOL_OPTIONS=-javaagent:/tmp/owner.jar\nexport XDG_CONFIG_HOME=/tmp/owner-config";
var HOSTILE_NAMES = ["ANTHROPIC_BASE_URL", "JAVA_TOOL_OPTIONS", "XDG_CONFIG_HOME"];

function fakeQueries() { return globalThis.__fakeAgentSdkQueries || []; }
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

async function waitFor(predicate, label) {
  for (var i = 0; i < 100; i++) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error("timed out waiting for " + label);
}

function sessionOf(ctx, userKey) {
  return ctx.sm.createSessionRaw(userKey ? { ownerId: server.people[userKey].id } : {});
}

// Starts one query in the project for the session and returns the environment
// the Claude Code subprocess was given.
async function startQueryIn(ctx, session) {
  var before = fakeQueries().length;
  await ctx.sdk.startQuery(session, "go", null, null);
  await waitFor(function () { return fakeQueries().length > before; }, "the query to start");
  return fakeQueries()[fakeQueries().length - 1].env;
}

async function endQuery(session) {
  if (session.queryInstance) session.queryInstance.close();
  if (session.streamPromise) await session.streamPromise;
}

async function envOf(ctx, userKey) {
  var session = sessionOf(ctx, userKey);
  var env = await startQueryIn(ctx, session);
  await endQuery(session);
  return env;
}

async function save(client, type, resultType, envrc) {
  client.inbox.length = 0;
  client.send({ type: type, envrc: envrc });
  return client.waitFor(function (m) { return m.type === resultType; });
}

function resetSettings() {
  config.sharedEnv = "";
  config.projects.forEach(function (p) { delete p.envrc; });
}

test.before(async function () {
  server = await harness.start({
    users: [
      { key: "owner", username: "owner", permissions: { projectSettings: true } },
      { key: "other", username: "other", permissions: { projectSettings: true } },
      { key: "admin", username: "admin", role: "admin" },
    ],
    projects: [
      { slug: "alpha", ownerKey: "owner", visibility: "public" },
      { slug: "alpha--wt", parent: "alpha" },
      { slug: "orphan", visibility: "public" },
    ],
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
    if (slug === "alpha--wt") worktree = ctx;
    if (slug === "orphan") orphan = ctx;
  });
  ownerWs = await server.connect("alpha", "owner");
  otherWs = await server.connect("alpha", "other");
  adminWs = await server.connect("alpha", "admin");
  assert.equal(ownerWs.ok && otherWs.ok && adminWs.ok, true);
  // The first connection warms the adapters up; let that query pass.
  await sleep(400);
});

test.after(async function () {
  if (server) await server.stop();
});

// --- Who gets the project's variables -------------------------------------

test("the owner saves variables in Settings: the owner's session gets them and another user's session in the project does not", async function () {
  resetSettings();
  var saved = await save(ownerWs, "set_project_env", "set_project_env_result", HOSTILE + "\nexport OWNER_ONLY=1");
  assert.equal(saved.ok, true, saved.error);

  var ownersEnv = await envOf(alpha, "owner");
  var othersEnv = await envOf(alpha, "other");

  assert.equal(ownersEnv.ANTHROPIC_BASE_URL, "https://owner.example.invalid");
  assert.equal(ownersEnv.JAVA_TOOL_OPTIONS, "-javaagent:/tmp/owner.jar");
  assert.equal(ownersEnv.XDG_CONFIG_HOME, "/tmp/owner-config");
  assert.equal(ownersEnv.OWNER_ONLY, "1");
  HOSTILE_NAMES.concat(["OWNER_ONLY"]).forEach(function (name) {
    assert.equal(othersEnv[name], process.env[name], name + " does not reach another user's session");
  });
  assert.equal(othersEnv.PATH, process.env.PATH);
});

test("the shared variables reach the owner's session and another user's alike", async function () {
  resetSettings();
  var saved = await save(adminWs, "set_shared_env", "set_shared_env_result", "export SHARED_ONLY=from-shared");
  assert.equal(saved.ok, true, saved.error);
  config.projects[0].envrc = "OWNER_ONLY=1";

  var ownersEnv = await envOf(alpha, "owner");
  var othersEnv = await envOf(alpha, "other");

  assert.equal(ownersEnv.SHARED_ONLY, "from-shared");
  assert.equal(othersEnv.SHARED_ONLY, "from-shared");
  assert.equal(ownersEnv.OWNER_ONLY, "1");
  assert.equal(othersEnv.OWNER_ONLY, undefined);
});

test("a worktree runs with its parent's variables under the same rule", async function () {
  resetSettings();
  config.sharedEnv = "SHARED_ONLY=from-shared";
  config.projects[0].envrc = "OWNER_ONLY=1\nANTHROPIC_BASE_URL=https://owner.example.invalid";

  var ownersEnv = await envOf(worktree, "owner");
  var othersEnv = await envOf(worktree, "other");

  assert.equal(ownersEnv.OWNER_ONLY, "1", "the owner's session in the worktree gets the parent's variables");
  assert.equal(ownersEnv.ANTHROPIC_BASE_URL, "https://owner.example.invalid");
  assert.equal(othersEnv.OWNER_ONLY, undefined, "another user's session in the worktree does not");
  assert.equal(othersEnv.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_BASE_URL);
  assert.equal(othersEnv.SHARED_ONLY, "from-shared", "it still gets the shared variables");
});

test("a project with no owner and a session with no owner get no project variables, only the shared ones", async function () {
  resetSettings();
  config.sharedEnv = "SHARED_ONLY=from-shared";
  config.projects[1].envrc = "ORPHAN_ONLY=1";
  config.projects[0].envrc = "OWNER_ONLY=1";

  var inOrphan = await envOf(orphan, "owner");
  var noOwnerSession = await envOf(alpha, null);

  assert.equal(inOrphan.ORPHAN_ONLY, undefined, "nobody owns the project");
  assert.equal(inOrphan.SHARED_ONLY, "from-shared");
  assert.equal(noOwnerSession.OWNER_ONLY, undefined, "the session has no owner");
  assert.equal(noOwnerSession.SHARED_ONLY, "from-shared");
});

test("an administrator's session in someone else's project does not get that project's variables either", async function () {
  resetSettings();
  config.projects[0].envrc = "OWNER_ONLY=1";
  var env = await envOf(alpha, "admin");
  assert.equal(env.OWNER_ONLY, undefined);
});

test("a runtime that serves no one session, such as a model-list warmup, gets the shared variables only", function () {
  resetSettings();
  config.sharedEnv = "SHARED_ONLY=from-shared";
  config.projects[0].envrc = "OWNER_ONLY=1";
  assert.deepEqual(alpha.sdk.getRuntimeEnvOverlay(), { SHARED_ONLY: "from-shared" });
  assert.deepEqual(alpha.sdk.getRuntimeEnvOverlay(sessionOf(alpha, "owner")), { SHARED_ONLY: "from-shared", OWNER_ONLY: "1" });
});

test("only the project owner and an administrator may read or change the project's variables", async function () {
  resetSettings();
  config.projects[0].envrc = "OWNER_ONLY=secret-value";

  var refused = await save(otherWs, "set_project_env", "set_project_env_result", "export PLANTED=1");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /owner or an administrator/);
  assert.equal(config.projects[0].envrc, "OWNER_ONLY=secret-value", "nothing was changed");

  otherWs.inbox.length = 0;
  otherWs.send({ type: "get_project_env" });
  var read = await otherWs.waitFor(function (m) { return m.type === "project_env_result"; });
  assert.equal(read.envrc, "", "another user is sent no value");
  assert.equal(read.canEdit, false);
  assert.equal(JSON.stringify(read).indexOf("secret-value"), -1);

  ownerWs.inbox.length = 0;
  ownerWs.send({ type: "get_project_env" });
  var ownersRead = await ownerWs.waitFor(function (m) { return m.type === "project_env_result"; });
  assert.equal(ownersRead.envrc, "OWNER_ONLY=secret-value");
  assert.equal(ownersRead.canEdit, true);
  assert.equal(ownersRead.appliesTo, "owner", "the page can say whom the variables reach");

  var byAdmin = await save(adminWs, "set_project_env", "set_project_env_result", "export BY_ADMIN=1");
  assert.equal(byAdmin.ok, true, byAdmin.error);
});

test("a worktree's Settings page reads and writes its parent's variables", async function () {
  resetSettings();
  config.projects[0].envrc = "OWNER_ONLY=1";
  var ownerInWorktree = await server.connect("alpha--wt", "owner");
  assert.equal(ownerInWorktree.ok, true);

  ownerInWorktree.send({ type: "get_project_env" });
  var read = await ownerInWorktree.waitFor(function (m) { return m.type === "project_env_result"; });
  assert.equal(read.envrc, "OWNER_ONLY=1");

  var saved = await save(ownerInWorktree, "set_project_env", "set_project_env_result", "export FROM_WORKTREE_PAGE=1");
  assert.equal(saved.ok, true, saved.error);
  assert.equal(config.projects[0].envrc, "export FROM_WORKTREE_PAGE=1");
});

// --- A runtime that cannot be ended is never reused --------------------------

// Starts a query for the owner and makes its runtime refuse to close, the way
// a failing child process would.
async function ownersRuntimeThatCannotClose() {
  var session = sessionOf(alpha, "owner");
  await startQueryIn(alpha, session);
  session.isProcessing = false;
  var handle = session.queryInstance;
  var realClose = handle.close.bind(handle);
  handle.close = function () { throw new Error("close failed"); };
  return { session: session, stream: session.streamPromise, endForReal: realClose };
}

test("close() throws on retirement: the runtime does not count as retired and is not reused", async function () {
  resetSettings();
  var stale = await ownersRuntimeThatCannotClose();
  var logged = [];
  var realError = console.error;
  console.error = function () { logged.push(Array.prototype.join.call(arguments, " ")); };
  var retired;
  try {
    config.projects[0].envrc = "LATE_ADDITION=now";
    retired = alpha.sdk.applyRuntimeEnvChange();
  } finally {
    console.error = realError;
  }

  assert.equal(retired, 0, "a runtime that did not close is not counted as retired");
  assert.equal(stale.session.queryInstance, null, "it is detached, so the next message cannot be pushed into it");
  assert.ok(logged.some(function (line) { return line.indexOf("close failed") !== -1; }), "the failure is reported");

  stale.endForReal();
  await stale.stream;
});

test("close() throws on retirement: the next message gets a fresh runtime with the new variables", async function () {
  resetSettings();
  var stale = await ownersRuntimeThatCannotClose();

  var saved = await save(ownerWs, "set_project_env", "set_project_env_result", "export LATE_ADDITION=now");
  assert.equal(saved.ok, true, saved.error);
  assert.equal(stale.session.queryInstance, null);

  var next = await startQueryIn(alpha, stale.session);
  assert.equal(next.LATE_ADDITION, "now", "the fresh runtime carries the new environment");
  assert.ok(stale.session.queryInstance, "and it is the session's runtime now");

  stale.endForReal();
  await stale.stream;
  assert.ok(stale.session.queryInstance, "the old stream ending does not take the new runtime away");
  await endQuery(stale.session);
});

test("close() that works still retires an idle runtime and counts it", async function () {
  resetSettings();
  var session = sessionOf(alpha, "owner");
  await startQueryIn(alpha, session);
  session.isProcessing = false;
  config.projects[0].envrc = "LATE_ADDITION=now";
  assert.equal(alpha.sdk.applyRuntimeEnvChange(), 1);
  await session.streamPromise;
  assert.equal(session.queryInstance, null);
});

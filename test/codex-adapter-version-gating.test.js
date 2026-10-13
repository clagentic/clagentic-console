"use strict";
// The Codex adapter against recorded app-server answers, per running version:
// which config keys the app-server is started with, which turn field a turn
// carries, that a rewind is refused, and what happens to a Codex that is too
// old. The app-server is a stand-in that reports the version it is told to and
// records every call; no Codex is run. Caller shapes: 0.148.x-0.150.x (no turn
// trigger), 0.151.x (turn trigger), 0.152.x and 0.162.x (plan tool), plus
// session create, resume, rewind (refused), model switch, plan display and abort.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var codexAppServerModule = require("../lib/yoke/codex-app-server");
var servers = [];
var scenario = { version: "0.162.1", reportedUserAgent: null, models: null };

function FakeAppServer(executablePath, opts) {
  this.opts = opts || {};
  this.resolution = { path: "/usr/local/bin/codex", version: scenario.version, source: "path" };
  this.started = false;
  this.stopped = false;
  this.calls = [];
  this.handlers = [];
  servers.push(this);
}
FakeAppServer.prototype.start = function () { this.started = true; return Promise.resolve(); };
FakeAppServer.prototype.stop = function () { this.started = false; this.stopped = true; };
FakeAppServer.prototype.notify = function () {};
FakeAppServer.prototype.respond = function () {};
FakeAppServer.prototype.send = function (method, params) {
  var self = this;
  this.calls.push({ method: method, params: params });
  if (method === "initialize") {
    var ua = scenario.reportedUserAgent || ("clagentic-console/" + scenario.version + " (Ubuntu 24.4.0; x86_64) test");
    return Promise.resolve({ userAgent: ua, codexHome: "/home/u/.codex", platformFamily: "unix", platformOs: "linux" });
  }
  if (method === "model/list") {
    return Promise.resolve({ data: scenario.models || [{ model: "gpt-test", displayName: "GPT Test", isDefault: true }] });
  }
  if (method === "skills/list") return Promise.resolve({ data: [] });
  if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
  if (method === "thread/resume") return Promise.resolve({ thread: { id: params.threadId } });
  if (method === "thread/read") return Promise.resolve({ thread: { id: params.threadId, turns: [{ id: "turn-a" }, { id: "turn-b" }, { id: "turn-c" }] } });
  if (method === "turn/start") {
    // A held turn stays in flight until the test releases it.
    if (scenario.holdTurn) return Promise.resolve({ turn: { id: "turn-x" } });
    setImmediate(function () {
      self.emit({ method: "turn/started", params: { threadId: "thread-1" } });
      if (scenario.plan) self.emit({ method: "turn/plan/updated", params: Object.assign({ threadId: "thread-1", turnId: "turn-x" }, scenario.plan) });
      self.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } });
    });
    return Promise.resolve({ turn: { id: "turn-x" } });
  }
  return Promise.resolve({});
};
FakeAppServer.prototype.emit = function (msg) {
  this.handlers.forEach(function (h) { if (h.threadId === null || h.threadId === "thread-1") h.fn(msg); });
};
FakeAppServer.prototype.addEventHandler = function (fn, threadId) { var h = { fn: fn, threadId: threadId || null }; this.handlers.push(h); return h; };
FakeAppServer.prototype.removeEventHandler = function (h) { this.handlers = this.handlers.filter(function (x) { return x !== h; }); };
FakeAppServer.prototype.updateHandlerThreadId = function (h, id) { h.threadId = id || null; };
codexAppServerModule.CodexAppServer = FakeAppServer;

var codexModule = require("../lib/yoke/adapters/codex");
var { INITIATORS } = require("../lib/turn-initiator");

var tmpRoots = [];
test.after(function () { tmpRoots.forEach(function (d) { fs.rmSync(d, { recursive: true, force: true }); }); });
function projectDir() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gating-"));
  tmpRoots.push(dir);
  return dir;
}

function setScenario(version, extra) {
  scenario = Object.assign({ version: version, reportedUserAgent: null, models: null }, extra);
}

function callsOf(server, method) { return server.calls.filter(function (c) { return c.method === method; }); }
function lastServer() { return servers[servers.length - 1]; }
function until(predicate, label) {
  return new Promise(function (resolve, reject) {
    var deadline = Date.now() + 3000;
    (function poll() {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error("timed out waiting for " + label));
      setTimeout(poll, 5);
    })();
  });
}

async function startAdapter(version, adapterOptions, extra) {
  setScenario(version, extra);
  var dir = projectDir();
  var adapter = codexModule.createCodexAdapter({ cwd: dir, slug: "p" });
  var init = await adapter.init({ runtimeEnv: null, adapterOptions: adapterOptions });
  return { adapter: adapter, dir: dir, server: lastServer(), init: init };
}

// --- The config the app-server is started with ---

test("0.162.1: the plan tool is enabled and the project the user opened is trusted", async function () {
  var run = await startAdapter("0.162.1");
  assert.deepEqual(run.server.opts.config.tools, { update_plan: { enabled: true } });
  assert.deepEqual(run.server.opts.config.projects[run.dir], { trust_level: "trusted" });
  await run.adapter.shutdown();
});

test("0.152.0: the plan tool key is sent; 0.151.x and below do not get it", async function () {
  var at = await startAdapter("0.152.0");
  assert.deepEqual(at.server.opts.config.tools, { update_plan: { enabled: true } });
  await at.adapter.shutdown();
  var below = await startAdapter("0.151.4");
  assert.equal(below.server.opts.config.tools, undefined);
  await below.adapter.shutdown();
});

test("0.150.0 is when untrusted projects lose AGENTS.md, so that is when the project is marked trusted", async function () {
  var at = await startAdapter("0.150.0");
  assert.deepEqual(at.server.opts.config.projects[at.dir], { trust_level: "trusted" });
  await at.adapter.shutdown();
  var below = await startAdapter("0.149.9");
  assert.equal(below.server.opts.config.projects, undefined);
  await below.adapter.shutdown();
});

test("0.148.0, the floor: no console config keys at all", async function () {
  var run = await startAdapter("0.148.0");
  assert.equal(run.server.opts.config.tools, undefined);
  assert.equal(run.server.opts.config.projects, undefined);
  await run.adapter.shutdown();
});

test("trusting the project can be turned off, and a config the caller supplies wins over the console's", async function () {
  var off = await startAdapter("0.162.1", { CODEX: { trustProject: false, config: { tools: { update_plan: { enabled: false } } } } });
  assert.equal(off.server.opts.config.projects, undefined);
  assert.deepEqual(off.server.opts.config.tools, { update_plan: { enabled: false } });
  await off.adapter.shutdown();
});

// --- Who started a turn ---

async function turnsWith(version, initiators) {
  setScenario(version);
  var dir = projectDir();
  var adapter = codexModule.createCodexAdapter({ cwd: dir, slug: "p" });
  var handle = await adapter.createQuery({ cwd: dir, model: "gpt-test", runtimeEnv: null });
  var server = lastServer();
  initiators.forEach(function (initiator, i) {
    handle.pushMessage("turn " + i, undefined, initiator);
  });
  await until(function () { return callsOf(server, "turn/start").length >= initiators.length; }, "the turns");
  var turns = callsOf(server, "turn/start").map(function (c) { return c.params; });
  handle.close();
  await adapter.shutdown();
  return turns;
}

test(">= 0.151.0: a typed turn carries no trigger and every other kind of turn carries the automation trigger, per turn", async function () {
  var turns = await turnsWith("0.162.1", [INITIATORS.HUMAN, INITIATORS.SCHEDULED, INITIATORS.HUMAN, INITIATORS.LOOP, INITIATORS.SCHEDULED_NOW, INITIATORS.TRIGGER, undefined]);
  assert.deepEqual(turns.map(function (t) { return t.turnTrigger; }), [
    undefined, "automation_heartbeat_scheduled", undefined, "automation_heartbeat_scheduled",
    "automation_heartbeat_scheduled", "automation_heartbeat_scheduled", undefined,
  ]);
  turns.forEach(function (t) { assert.equal("turn_trigger" in t, false); });
});

test("0.151.0 sends the trigger; 0.150.x and 0.148.x never do, whatever started the turn", async function () {
  var at = await turnsWith("0.151.0", [INITIATORS.SCHEDULED]);
  assert.equal(at[0].turnTrigger, "automation_heartbeat_scheduled");
  var below = await turnsWith("0.150.9", [INITIATORS.SCHEDULED, INITIATORS.LOOP]);
  below.forEach(function (t) { assert.equal("turnTrigger" in t, false); });
  var floor = await turnsWith("0.148.0", [INITIATORS.TRIGGER]);
  assert.equal("turnTrigger" in floor[0], false);
});

// --- Starting, resuming and approving ---

async function threadParamsFor(adapterOptions, resume) {
  setScenario("0.162.1");
  var dir = projectDir();
  var adapter = codexModule.createCodexAdapter({ cwd: dir, slug: "p" });
  var handle = await adapter.createQuery({ cwd: dir, model: "gpt-test", runtimeEnv: null, adapterOptions: adapterOptions, resumeSessionId: resume });
  var server = lastServer();
  handle.pushMessage("go");
  await until(function () { return callsOf(server, resume ? "thread/resume" : "thread/start").length > 0; }, "the thread");
  var params = callsOf(server, resume ? "thread/resume" : "thread/start")[0].params;
  handle.close();
  await adapter.shutdown();
  return params;
}

test("a session starts and resumes with an approval policy the running Codex accepts, never on-failure", async function () {
  var created = await threadParamsFor({ CODEX: { approvalPolicy: "on-failure" } });
  assert.equal(created.approvalPolicy, "on-request");
  var resumed = await threadParamsFor({ CODEX: { approvalPolicy: "on-failure" } }, "thread-9");
  assert.equal(resumed.approvalPolicy, "on-request");
  assert.equal(resumed.threadId, "thread-9");
  var untouched = await threadParamsFor({ CODEX: { approvalPolicy: "never" } });
  assert.equal(untouched.approvalPolicy, "never");
  var defaulted = await threadParamsFor({});
  assert.equal(defaulted.approvalPolicy, "on-request", "the default is the explicit value");
});

// --- Rewind ---

test("a rewind is refused on every supported version, with its reason, and the app-server is sent nothing", async function () {
  var versions = ["0.148.0", "0.151.0", "0.152.0", "0.162.1"];
  for (var i = 0; i < versions.length; i++) {
    var run = await startAdapter(versions[i]);
    var callsBefore = run.server.calls.length;
    await assert.rejects(run.adapter.rollbackThread("thread-1", 1, { runtimeEnv: null }), {
      code: "CODEX_REWIND_UNAVAILABLE",
      message: /Rewind is not available for Codex sessions yet/,
    }, versions[i]);
    await assert.rejects(run.adapter.rollbackThread("thread-1", 3, { runtimeEnv: null }), { code: "CODEX_REWIND_UNAVAILABLE" });
    assert.equal(run.server.calls.length, callsBefore, versions[i] + ": not even a thread/read");
    ["thread/revert", "thread/rollback"].forEach(function (method) {
      assert.equal(callsOf(run.server, method).length, 0, versions[i] + ": " + method + " is never sent");
    });
    await run.adapter.shutdown();
  }
});

// --- The running version ---

test("a Codex whose app-server reports a version under the floor is refused, with the stated message, and stopped", async function () {
  setScenario("0.150.0", { reportedUserAgent: "clagentic-console/0.147.2 (Linux) test" });
  var adapter = codexModule.createCodexAdapter({ cwd: projectDir(), slug: "p" });
  await assert.rejects(adapter.init({ runtimeEnv: null }), function (e) {
    return e.code === "CODEX_TOO_OLD" && /Codex 0\.147\.2 is too old; Clagentic: Console needs 0\.148\.0 or newer/.test(e.message);
  });
  assert.equal(lastServer().stopped, true);
  await adapter.shutdown();
});

test("the version the app-server reports decides, over the one the binary reported", async function () {
  var run = await startAdapter("0.150.0", null, { reportedUserAgent: "clagentic-console/0.162.1 (Linux) test" });
  var handle = await run.adapter.createQuery({ cwd: run.dir, model: "gpt-test", runtimeEnv: null });
  handle.pushMessage("go", undefined, INITIATORS.SCHEDULED);
  await until(function () { return callsOf(run.server, "turn/start").length > 0; }, "the turn");
  assert.equal(callsOf(run.server, "turn/start")[0].params.turnTrigger, "automation_heartbeat_scheduled");
  handle.close();
  await run.adapter.shutdown();
});

test("an app-server whose userAgent cannot be read falls back to the binary's version", async function () {
  var run = await startAdapter("0.152.0", null, { reportedUserAgent: "garbled" });
  var handle = await run.adapter.createQuery({ cwd: run.dir, model: "gpt-test", runtimeEnv: null });
  handle.pushMessage("go", undefined, INITIATORS.LOOP);
  await until(function () { return callsOf(run.server, "turn/start").length > 0; }, "the turn");
  assert.equal(callsOf(run.server, "turn/start")[0].params.turnTrigger, "automation_heartbeat_scheduled");
  handle.close();
  await run.adapter.shutdown();
});

test("settleRunningVersion: reported wins, binary is the fallback, neither is null", function () {
  var settle = codexModule._test_settleRunningVersion;
  assert.equal(settle("0.150.0", { userAgent: "x/0.162.1 (y)" }).text, "0.162.1");
  assert.equal(settle("0.150.0", { userAgent: "nonsense" }).text, "0.150.0");
  assert.equal(settle("0.150.0", {}).text, "0.150.0");
  assert.equal(settle(undefined, { userAgent: "x/0.162.1 (y)" }).text, "0.162.1");
  assert.equal(settle(undefined, {}), null);
});

// --- Model switch, capabilities, plan display, abort ---

test("each running version lists its own models, and a switch is sent on the next turn", async function () {
  var newer = [{ model: "gpt-new", displayName: "GPT New", isDefault: true }, { model: "gpt-new-mini", displayName: "GPT New Mini" }];
  var run = await startAdapter("0.162.1", null, { models: newer });
  assert.deepEqual(run.init.models.map(function (m) { return m.value; }), ["gpt-new", "gpt-new-mini"]);
  assert.equal(run.init.defaultModel, "gpt-new");
  var handle = await run.adapter.createQuery({ cwd: run.dir, runtimeEnv: null });
  await handle.setModel("gpt-new-mini");
  handle.pushMessage("go");
  await until(function () { return callsOf(run.server, "turn/start").length > 0; }, "the turn");
  assert.equal(callsOf(run.server, "turn/start")[0].params.model, "gpt-new-mini");
  handle.close();
  await run.adapter.shutdown();
});

test("the session advertises rewinding as unavailable and forking as available, on every supported version", async function () {
  var versions = ["0.148.0", "0.162.1"];
  for (var i = 0; i < versions.length; i++) {
    var run = await startAdapter(versions[i]);
    assert.equal(run.init.capabilities.rewind, false);
    assert.equal(run.init.capabilities.rollback, false);
    assert.equal(run.init.capabilities.fork, true);
    await run.adapter.shutdown();
  }
});

test("a plan the app-server streams is shown, with statuses normalized", async function () {
  var run = await startAdapter("0.162.1", null, { plan: { explanation: "because", plan: [
    { step: "one", status: "completed" }, { step: "two", status: "inProgress" }, { step: "three", status: "pending" } ] } });
  var handle = await run.adapter.createQuery({ cwd: run.dir, model: "gpt-test", runtimeEnv: null });
  var seen = [];
  var reader = (async function () { for await (var evt of handle) { seen.push(evt); if (evt.yokeType === "result") break; } })();
  handle.pushMessage("plan it");
  await reader;
  var plan = seen.filter(function (e) { return e.yokeType === "plan_updated"; })[0];
  assert.ok(plan, "a plan_updated event reached the console");
  assert.deepEqual(plan.plan, [{ step: "one", status: "completed" }, { step: "two", status: "in_progress" }, { step: "three", status: "pending" }]);
  handle.close();
  await run.adapter.shutdown();
});

test("an abort interrupts the running turn on the thread", async function () {
  var run = await startAdapter("0.162.1");
  var handle = await run.adapter.createQuery({ cwd: run.dir, model: "gpt-test", runtimeEnv: null });
  handle.pushMessage("go");
  await until(function () { return callsOf(run.server, "turn/start").length > 0; }, "the turn");
  handle.abort();
  await until(function () { return callsOf(run.server, "turn/interrupt").length > 0; }, "the interrupt");
  assert.deepEqual(callsOf(run.server, "turn/interrupt")[0].params, { threadId: "thread-1" });
  await run.adapter.shutdown();
});

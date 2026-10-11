"use strict";
// The daemon's idle reaper reaches the Codex adapter's per-environment
// app-servers through the real project context. A real Clagentic: Console
// server and project context, the real Codex adapter and the daemon's own
// reaper module; only the Codex app-server process is a stand-in.

var test = require("node:test");
var assert = require("node:assert/strict");
var os = require("os");

// The Codex adapter takes its app-server class when it is loaded: swap in a
// recording one first.
var codexAppServerModule = require("../lib/yoke/codex-app-server");
var appServers = [];
function FakeAppServer(executablePath, opts) {
  this.opts = opts || {};
  this.started = false;
  this.proc = null;
  this.stopped = false;
  appServers.push(this);
}
FakeAppServer.prototype.start = function () { this.started = true; return Promise.resolve(); };
FakeAppServer.prototype.stop = function () { this.started = false; this.stopped = true; };
FakeAppServer.prototype.notify = function () {};
FakeAppServer.prototype.send = function (method) {
  if (method === "model/list") return Promise.resolve({ data: [{ model: "gpt-test", displayName: "GPT Test", isDefault: true }] });
  if (method === "skills/list") return Promise.resolve({ data: [] });
  return Promise.resolve({});
};
FakeAppServer.prototype.addEventHandler = function () { return {}; };
FakeAppServer.prototype.removeEventHandler = function () {};
FakeAppServer.prototype.updateHandlerThreadId = function () {};
codexAppServerModule.CodexAppServer = FakeAppServer;

var harness = require("./access-harness");
var { reapIdleAdapters, startIdleAdapterReaper } = require("../lib/idle-adapter-reaper");

var server = null;
var codex = null;

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

async function waitFor(predicate, label) {
  for (var i = 0; i < 100; i++) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error("timed out waiting for " + label);
}

function openQuery(env) {
  return codex.createQuery({ cwd: os.tmpdir(), model: "gpt-test", runtimeEnv: env });
}

test.before(async function () {
  server = await harness.start({
    users: [{ key: "admin", username: "admin", role: "admin" }],
    projects: [{ slug: "alpha", visibility: "public" }],
    beforeServer: function () {
      var yoke = require("../lib/yoke");
      yoke.createAdapters = function (opts) {
        codex = yoke.createAdapter({ vendor: "codex", cwd: opts.cwd, slug: opts.slug });
        return { adapters: { codex: codex }, auth: { codex: true } };
      };
    },
  });
});

test.after(async function () {
  if (server) await server.stop();
});

test("the project context reaches its adapters, so the reaper has something to reclaim", function () {
  var reachable = false;
  server.relay.forEachProject(function (ctx) { reachable = typeof ctx.reclaimIdleAdapters === "function"; });
  assert.equal(reachable, true);
});

test("a reaper tick ends an idle per-environment app-server and leaves one a query is using", async function () {
  var busy = await openQuery({ ONE: "1" });
  var busyServer = appServers[appServers.length - 1];
  var done = await openQuery({ ONE: "2" });
  var doneServer = appServers[appServers.length - 1];
  assert.notEqual(busyServer, doneServer);
  done.close();
  await sleep(20);

  await reapIdleAdapters(server.relay, 0);

  assert.equal(doneServer.stopped, true, "the idle server is reclaimed through the project context");
  assert.equal(busyServer.stopped, false, "the server a query is using is not");

  busy.close();
  await sleep(20);
  await reapIdleAdapters(server.relay, 0);
  assert.equal(busyServer.stopped, true, "it is reclaimed once its query is done");
});

test("a server that has not been quiet for the idle window is kept", async function () {
  var query = await openQuery({ ONE: "3" });
  var kept = appServers[appServers.length - 1];
  query.close();
  await sleep(20);
  await reapIdleAdapters(server.relay, 60 * 1000);
  assert.equal(kept.stopped, false);
  await reapIdleAdapters(server.relay, 0);
  assert.equal(kept.stopped, true);
});

test("the daemon's timer drives the same reclaim", async function () {
  var query = await openQuery({ ONE: "4" });
  var target = appServers[appServers.length - 1];
  query.close();
  await sleep(20);

  var stop = startIdleAdapterReaper(function () { return server.relay; }, { idleMs: 0, intervalMs: 20 });
  try {
    await waitFor(function () { return target.stopped; }, "the timer to reclaim the idle server");
  } finally {
    stop();
  }
});

test("a project whose reclaim fails does not stop the others from being looked at", async function () {
  var calls = [];
  var relay = {
    forEachProject: function (fn) {
      fn({ reclaimIdleAdapters: function () { throw new Error("boom"); } }, "broken");
      fn({ reclaimIdleAdapters: function () { return Promise.reject(new Error("later")); } }, "rejects");
      fn({ reclaimIdleAdapters: function () { calls.push("ok"); return Promise.resolve(true); } }, "fine");
      fn({}, "no-method");
    },
  };
  var realError = console.error;
  var logged = [];
  console.error = function () { logged.push(Array.prototype.join.call(arguments, " ")); };
  try {
    await reapIdleAdapters(relay, 0);
  } finally {
    console.error = realError;
  }
  assert.deepEqual(calls, ["ok"]);
  assert.equal(logged.length, 2, "both failures are reported");
});

"use strict";
// Every prompt that ends without an answer says who or what ended it: one
// source from a stable vocabulary (lib/prompt-source.js), recorded on the
// prompt_cancel event, in the journal line and in the replayed promptState,
// the way a resolved prompt records its responder. One test per cancel site.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var world = require("./prompt-harness-world");
var { createPromptRegistry } = require("../lib/prompt-registry");
var claudeAdapter = require("../lib/yoke/adapters/claude");

var client = world.client;
var withServer = world.withServer;

var BASH = { toolName: "Bash", toolInput: { command: "make" }, vendor: "claude" };

function makeRegistry(extra) {
  var recorded = [];
  var session = { localId: 1, queryInstance: null };
  var registry = createPromptRegistry(Object.assign({
    index: Object.create(null),
    getSession: function () { return session; },
    sendAndRecord: function (s, m) { recorded.push(m); },
    saveSessionFile: function () {},
    getProjectSlug: function () { return "alpha"; },
  }, extra || {}));
  return { registry: registry, session: session, recorded: recorded };
}

function cancelEvents(events) {
  return events.filter(function (m) { return m.type === "prompt_cancel"; });
}

// Records the source every cancel settles with, whether or not its kind
// journals an event (a project-scope extension command does not).
function spyCancelSources(t, promptSource) {
  var seen = [];
  var original = promptSource.cancelSource;
  t.mock.method(promptSource, "cancelSource", function (value, reason) {
    var source = original(value, reason);
    seen.push({ reason: reason, source: source });
    return source;
  });
  return seen;
}

function captureLog(t) {
  var lines = [];
  t.mock.method(console, "log", function () { lines.push(Array.prototype.join.call(arguments, " ")); });
  var warnings = [];
  t.mock.method(console, "warn", function () { warnings.push(Array.prototype.join.call(arguments, " ")); });
  return {
    settled: function () { return lines.filter(function (l) { return l.indexOf("[prompt-registry] prompt cancelled") === 0; }); },
    warnings: warnings,
  };
}

// --- the registry's own cancel paths ---------------------------------------

test("a plain signal abort ends the prompt with source session_end", function (t) {
  var log = captureLog(t);
  var h = makeRegistry();
  var ac = new AbortController();
  var opened = h.registry.open(h.session, "permission", BASH, { toolUseId: "tu-a", signal: ac.signal });
  ac.abort();
  var event = cancelEvents(h.recorded)[0];
  assert.equal(event.reason, "aborted");
  assert.equal(event.source, "session_end");
  assert.match(log.settled()[0], / reason=aborted source=session_end$/);
  assert.equal(h.registry.lookup(opened.requestId), null);
});

test("an expiry relayed from a worker ends the prompt with source worker", function (t) {
  var log = captureLog(t);
  var h = makeRegistry();
  var ac = new AbortController();
  h.registry.open(h.session, "permission", BASH, { toolUseId: "tu-e", signal: ac.signal });
  ac.abort("expired");
  var event = cancelEvents(h.recorded)[0];
  assert.equal(event.reason, "expired");
  assert.equal(event.source, "worker");
  assert.match(log.settled()[0], / reason=expired source=worker$/);
});

test("a worker's permission_expired message reaches the registry as source worker", function (t) {
  captureLog(t);
  var h = makeRegistry();
  var worker = { sent: [], handler: null, onMessage: function (fn) { worker.handler = fn; }, send: function (m) { worker.sent.push(m); } };
  function canUseTool(toolName, input, opts) {
    return h.registry.open(h.session, "permission", BASH, { toolUseId: opts.toolUseID, signal: opts.signal }).answer;
  }
  claudeAdapter._test_createWorkerQueryHandle(worker, canUseTool, null, null);
  worker.handler({ type: "permission_request", requestId: "w1", toolName: "Bash", input: {}, toolUseId: "tu-w" });
  assert.equal(h.registry.pendingCount(h.session), 1);
  worker.handler({ type: "permission_expired", requestId: "w1" });
  assert.equal(cancelEvents(h.recorded)[0].source, "worker");
});

test("a prompt that times out ends with source timeout", function (t) {
  var log = captureLog(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  var h = makeRegistry();
  h.registry.open(h.session, "permission", BASH, { toolUseId: "tu-t", timeoutMs: 5000 });
  t.mock.timers.tick(5000);
  var event = cancelEvents(h.recorded)[0];
  assert.equal(event.reason, "expired");
  assert.equal(event.source, "timeout");
  assert.match(log.settled()[0], / reason=expired source=timeout$/);
});

test("a browser-extension command timeout ends with source timeout", function (t) {
  var promptSource = require("../lib/prompt-source");
  var seen = spyCancelSources(t, promptSource);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  var h = makeRegistry();
  var opened = h.registry.open(null, "extension", { command: "tab_console", args: {} }, { timeoutMs: 3000 });
  t.mock.timers.tick(3000);
  assert.deepEqual(seen, [{ reason: "expired", source: "timeout" }]);
  return opened.answer.then(function (value) { assert.equal(value, null); });
});

test("a turn ending cancels with source session_end", function (t) {
  captureLog(t);
  var h = makeRegistry();
  h.registry.open(h.session, "permission", BASH, { toolUseId: "tu-1" });
  h.registry.endTurn(h.session);
  var event = cancelEvents(h.recorded)[0];
  assert.deepEqual([event.reason, event.source], ["turn_ended", "session_end"]);
});

test("a query ending cancels with source session_end", function (t) {
  captureLog(t);
  var h = makeRegistry();
  var query = {};
  h.registry.open(h.session, "permission", BASH, { toolUseId: "tu-1" });
  h.session.queryInstance = query;
  h.registry.endQuery(h.session, query, true);
  var event = cancelEvents(h.recorded)[0];
  assert.deepEqual([event.reason, event.source], ["query_ended", "session_end"]);
});

test("a daemon shutdown cancels session and project prompts with source daemon_restart", function (t) {
  captureLog(t);
  var promptSource = require("../lib/prompt-source");
  var seen = spyCancelSources(t, promptSource);
  var h = makeRegistry();
  h.registry.open(h.session, "permission", BASH, { toolUseId: "tu-1" });
  h.registry.open(null, "extension", { command: "tab_console" }, { timeoutMs: 60000 });
  h.registry.shutdown();
  assert.deepEqual(cancelEvents(h.recorded).map(function (m) { return [m.reason, m.source]; }), [["shutdown", "daemon_restart"]]);
  assert.deepEqual(seen.map(function (x) { return x.source; }), ["daemon_restart", "daemon_restart"]);
});

// --- the paths wired through the real session manager and project ----------

test("a query closing cancels the prompt with source session_end, recorded and replayed", async function (t) {
  var log = captureLog(t);
  await withServer(async function (server) {
    var asked = server.ask("Bash", { command: "make" });
    await server.endQuery();
    await asked.promise;
    var event = cancelEvents(server.session.history)[0];
    assert.equal(event.source, "session_end");
    assert.match(log.settled()[0], / source=session_end$/);

    var late = client();
    server.connect(late.ws);
    var replayed = late.inbox.filter(function (m) { return m.type === "prompt_request" && m.requestId === asked.id; })[0];
    assert.ok(replayed, "the request is replayed to a client that connects later");
    assert.equal(replayed.promptState.state, "cancelled");
    assert.equal(replayed.promptState.source, "session_end");
  });
});

test("a daemon shutdown through the session manager records source daemon_restart", async function (t) {
  captureLog(t);
  await withServer(async function (server) {
    var asked = server.ask("Bash", { command: "make" });
    server.sm.destroy();
    await asked.promise;
    var event = cancelEvents(server.session.history)[0];
    assert.deepEqual([event.reason, event.source], ["shutdown", "daemon_restart"]);
  });
});

test("a project torn down for a daemon restart records daemon_restart, not the sessions' own abort", async function (t) {
  var sessionReclaim = require("../lib/session-reclaim");
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "ccon-cancel-src-home-"));
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccon-cancel-src-cwd-"));
  var prevHome = process.env.CLAGENTIC_CONSOLE_HOME;
  process.env.CLAGENTIC_CONSOLE_HOME = home;
  ["../lib/config", "../lib/sessions", "../lib/utils", "../lib/project", "../lib/prompt-registry", "../lib/prompt-source"].forEach(function (m) {
    delete require.cache[require.resolve(m)];
  });
  t.after(function () {
    if (prevHome === undefined) delete process.env.CLAGENTIC_CONSOLE_HOME;
    else process.env.CLAGENTIC_CONSOLE_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  captureLog(t);
  var ctx = require("../lib/project").createProjectContext({ cwd: cwd, slug: "cancel-src", title: "cancel-src", debug: false, currentVersion: "0.0.0" });
  var freshSource = require("../lib/prompt-source");
  var seen = spyCancelSources(t, freshSource);
  var ac = new AbortController();
  var session = { localId: 7, queryInstance: null, abortController: ac, history: [] };
  ctx.sm.sessions.set(7, session);
  require("../lib/prompt-registry").promptsFor(ctx.sm).open(session, "permission", BASH, { toolUseId: "tu-d", signal: ac.signal });
  await ctx.destroy({ reason: sessionReclaim.RESTART_REASON });
  assert.deepEqual(seen, [{ reason: "shutdown", source: "daemon_restart" }]);
});

test("deleting a session cancels its prompts with source session_end", async function (t) {
  captureLog(t);
  await withServer(async function (server) {
    var promptSource = require("../lib/prompt-source");
    var seen = spyCancelSources(t, promptSource);
    var asked = server.ask("Bash", { command: "make" });
    server.sm.deleteSessionQuiet(server.session.localId);
    await asked.promise;
    assert.deepEqual(seen, [{ reason: "session_deleted", source: "session_end" }]);
  });
});

test("clearing context for a plan cancels the other prompts with source user", async function (t) {
  captureLog(t);
  await withServer(async function (server) {
    var c = client();
    server.connect(c.ws);
    t.mock.method(require("../lib/users"), "canAccessSession", function () { return true; });
    var other = server.ask("Bash", { command: "make" });
    var plan = server.sm.prompts.open(server.session, "plan", { toolName: "ExitPlanMode", toolInput: { plan: "p" } }, { toolUseId: "tu-plan" });
    server.handlers.handleSessionsMessage(c.ws, { type: "prompt_response", requestId: plan.requestId, kind: "plan", decision: "allow_clear_context", planContent: "p" });
    await other.promise;
    var event = cancelEvents(server.session.history).filter(function (m) { return m.requestId === other.id; })[0];
    assert.deepEqual([event.reason, event.source], ["cleared", "user"]);
  });
});

test("a rewind cancels the session's prompts with source user", async function (t) {
  captureLog(t);
  await withServer(async function (server) {
    var c = client();
    server.connect(c.ws);
    server.session.cliSessionId = "cli-1";
    server.session.messageUUIDs = [];
    var asked = server.ask("Bash", { command: "make" });
    server.handlers.handleSessionsMessage(c.ws, { type: "rewind_execute", uuid: "u-1", mode: "chat" });
    await asked.promise;
    var event = cancelEvents(server.session.history)[0];
    assert.deepEqual([event.reason, event.source], ["rewind", "user"]);
  });
});

// --- the vocabulary rule ---------------------------------------------------

test("a cancel with a missing or unknown source is recorded as unspecified, with a warning", function (t) {
  var log = captureLog(t);
  var promptSource = require("../lib/prompt-source");
  var values = [undefined, null, "", "robot", 7, "caller:", "caller:has space", "caller:" + "x".repeat(65)];
  values.forEach(function (v) { assert.equal(promptSource.cancelSource(v, "aborted"), "unspecified"); });
  assert.equal(log.warnings.length, values.length);
  log.warnings.forEach(function (w) { assert.match(w, /recorded as unspecified$/); });
});

test("every vocabulary value, and caller:<name>, is kept as given", function (t) {
  var log = captureLog(t);
  var promptSource = require("../lib/prompt-source");
  ["user", "timeout", "session_end", "daemon_restart", "worker", "caller:my-agent.1"].forEach(function (v) {
    assert.equal(promptSource.cancelSource(v, "aborted"), v);
  });
  assert.deepEqual(log.warnings, []);
});

test("cancelSession with no source records unspecified on the event, never undefined", function (t) {
  captureLog(t);
  var h = makeRegistry();
  h.registry.open(h.session, "permission", BASH, { toolUseId: "tu-1" });
  h.registry.cancelSession(h.session, "rewind");
  var event = cancelEvents(h.recorded)[0];
  assert.equal(event.source, "unspecified");
  assert.ok(Object.prototype.hasOwnProperty.call(event, "source"));
});

test("a caller-named source is recorded verbatim", function (t) {
  var log = captureLog(t);
  var h = makeRegistry();
  h.registry.open(h.session, "permission", BASH, { toolUseId: "tu-1" });
  h.registry.cancelSession(h.session, "rewind", { source: "caller:nightly-runner" });
  assert.equal(cancelEvents(h.recorded)[0].source, "caller:nightly-runner");
  assert.match(log.settled()[0], / source=caller:nightly-runner$/);
});

// --- replay and history paging ---------------------------------------------

test("a paged replay stamps a cancelled prompt with its recorded source; an older recording reads unspecified", function (t) {
  captureLog(t);
  var h = makeRegistry();
  var history = [
    { type: "prompt_request", requestId: "r1", kind: "permission" },
    { type: "prompt_cancel", requestId: "r1", kind: "permission", reason: "expired", source: "worker" },
    { type: "prompt_request", requestId: "r2", kind: "permission" },
    { type: "prompt_cancel", requestId: "r2", kind: "permission", reason: "aborted" },
    { type: "prompt_request", requestId: "r3", kind: "permission" },
  ];
  var annotate = h.registry.replayAnnotator(h.session, history, 0);
  var states = history.filter(function (m) { return m.type === "prompt_request"; }).map(function (m) { return annotate(m).promptState; });
  assert.deepEqual(states, [
    { state: "cancelled", reason: "expired", source: "worker" },
    { state: "cancelled", reason: "aborted", source: "unspecified" },
    { state: "cancelled", reason: "stale", source: "unspecified" },
  ]);
});

test("the client's prompt state keeps the source and the card label is unchanged", async function () {
  var states = (await import("../lib/public/modules/prompt-state.js"));
  var card = (await import("../lib/public/modules/prompt-card.js"));
  var n = states.normalizePromptMessage({ type: "prompt_cancel", requestId: "r1", kind: "permission", reason: "expired", source: "worker" });
  assert.equal(n.fields.source, "worker");
  var store = states.createPromptStates();
  store.apply("r1", { state: "cancelled", reason: n.fields.reason, source: n.fields.source });
  assert.equal(store.get("r1").source, "worker");
  assert.equal(card.cancelledLabel("expired"), "Expired");
  assert.equal(card.cancelledLabel("aborted"), "Cancelled");
});

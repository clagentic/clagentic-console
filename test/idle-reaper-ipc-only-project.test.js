"use strict";
// A project's idle reaper runs from the moment the project is attached, so a
// project reached only over IPC (open-session, send-input, scheduled input,
// external trigger, loop) has its idle sessions reaped the same as one a
// browser connected to. Drives the real project context with the interval
// clock mocked.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { promptsFor } = require("../lib/prompt-registry");

var TICK_MS = 60 * 1000;
var IDLE_MS = 40 * 60 * 1000;

function makeProject(t) {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "ccon-reaper-home-"));
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccon-reaper-cwd-"));
  var prevHome = process.env.CLAGENTIC_CONSOLE_HOME;
  process.env.CLAGENTIC_CONSOLE_HOME = home;
  ["../lib/config", "../lib/sessions", "../lib/utils", "../lib/project"].forEach(function (m) {
    delete require.cache[require.resolve(m)];
  });
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  var intervals = [];
  var realSetInterval = global.setInterval;
  global.setInterval = function (fn, ms) {
    var h = realSetInterval.apply(this, arguments);
    intervals.push({ ms: ms, handle: h });
    return h;
  };
  var ctx = require("../lib/project").createProjectContext({
    cwd: cwd, slug: "ipc-only", title: "ipc-only", debug: false, currentVersion: "0.0.0",
  });
  t.after(function () {
    try { ctx.destroy({ reason: "test" }); } catch (e) { /* already destroyed */ }
    global.setInterval = realSetInterval;
    t.mock.timers.reset();
    if (prevHome === undefined) delete process.env.CLAGENTIC_CONSOLE_HOME;
    else process.env.CLAGENTIC_CONSOLE_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  return { ctx: ctx, intervals: intervals };
}

function idleSession(ctx, id, extra) {
  var closed = { value: false };
  var s = Object.assign({
    localId: id,
    queryInstance: { close: function () { closed.value = true; } },
    messageQueue: null,
    isProcessing: false,
    singleTurn: false,
    destroying: false,
    lastActivityAt: Date.now() - IDLE_MS,
    history: [],
    _closed: closed,
  }, extra || {});
  ctx.sm.sessions.set(id, s);
  return s;
}

function reaperTicks(h) {
  return h.intervals.filter(function (i) { return i.ms === TICK_MS; }).length;
}

test("AC1/AC2: a project nobody connected to over WebSocket has a running reaper that reaps an idle session", function (t) {
  var h = makeProject(t);
  assert.ok(reaperTicks(h) >= 1, "the idle reaper timer exists after attach, with no WebSocket");
  var s = idleSession(h.ctx, 9001);
  t.mock.timers.tick(TICK_MS * 2);
  assert.equal(s._closed.value, true, "the idle IPC-only session is reaped");
});

test("AC3: an IPC-only session with an open prompt while not processing is skipped and named", function (t) {
  var h = makeProject(t);
  var s = idleSession(h.ctx, 9002);
  promptsFor(h.ctx.sm).open(s, "permission", {
    toolName: "Bash", toolInput: { command: "make" }, vendor: "claude",
  }, { toolUseId: "toolu_ipc" });
  var lines = [];
  t.mock.method(console, "log", function () { lines.push(Array.prototype.join.call(arguments, " ")); });
  t.mock.timers.tick(TICK_MS * 2);
  assert.equal(s._closed.value, false);
  var skip = lines.filter(function (l) { return /Idle reaper: skipped 1 session\(s\) with an open prompt/.test(l); });
  assert.ok(skip.length >= 1, "the skip line is logged");
  assert.match(skip[0], /project=ipc-only/);
  assert.match(skip[0], /sessions=9002/);
});

test("AC4: repeated starts and a later WebSocket connection leave exactly one reaper", function (t) {
  var h = makeProject(t);
  var before = reaperTicks(h);
  h.ctx.sdk.startIdleReaper();
  h.ctx.sdk.startIdleReaper();
  assert.equal(reaperTicks(h), before, "a second start is a no-op");

  var ws = {
    readyState: 1, send: function () {}, close: function () {}, on: function () {},
    _clagenticUser: null,
  };
  try { h.ctx.handleConnection(ws, null, h.ctx.handleMessage, h.ctx.handleDisconnection); }
  catch (e) { /* a bare socket may fail later in the handshake; warmup ran first */ }
  assert.equal(reaperTicks(h), before, "the WebSocket warmup does not start a second reaper");
  assert.equal(before, 1);
});

test("destroy stops the reaper", function (t) {
  var h = makeProject(t);
  h.ctx.destroy({ reason: "test" });
  var s = idleSession(h.ctx, 9003);
  t.mock.timers.tick(TICK_MS * 2);
  assert.equal(s._closed.value, false, "a destroyed project's timer no longer sweeps");
});

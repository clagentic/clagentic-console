"use strict";
// Codex: a command the person typed goes to the app-server's thread/shellCommand
// with the console's timeout. The app-server answers {} and reports the command
// only as turn and item notifications, so every one of them is matched on the
// command's turn id: the turn-id table below proves each way a model turn or an
// earlier command could otherwise be confused with the running command.

var test = require("node:test");
var assert = require("node:assert/strict");

var codexAdapter = require("../lib/yoke/adapters/codex");

function tick() { return new Promise(function (resolve) { setImmediate(resolve); }); }

function rpcError(message, code) {
  var e = new Error(message);
  e.rpcCode = code;
  return e;
}

// A fake app-server. The first turn starts and completes by itself; what
// thread/shellCommand does is up to the test.
function fakeAppServer(shellBehavior) {
  var handlers = [];
  var fake = { calls: [] };
  fake.dispatch = function (method, params) {
    var msg = { method: method, params: Object.assign({ threadId: "thread-1" }, params || {}) };
    handlers.forEach(function (h) { if (h.threadId === null || h.threadId === "thread-1") h.fn(msg); });
  };
  fake.appServer = {
    started: true,
    addEventHandler: function (fn, threadId) { var e = { fn: fn, threadId: threadId || null }; handlers.push(e); return e; },
    removeEventHandler: function (e) { handlers = handlers.filter(function (h) { return h !== e; }); },
    updateHandlerThreadId: function (e, threadId) { e.threadId = threadId || null; },
    respond: function () {},
    send: function (method, params) {
      fake.calls.push({ method: method, params: params });
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      if (method === "turn/start") {
        setImmediate(function () {
          fake.dispatch("turn/started", { turn: { id: "turn-1" } });
          fake.dispatch("turn/completed", { turn: { id: "turn-1", status: "completed" } });
        });
        return Promise.resolve({});
      }
      if (method === "thread/shellCommand") return shellBehavior ? shellBehavior(params, fake) : Promise.resolve({});
      return Promise.resolve({});
    },
  };
  fake.callsTo = function (method) { return fake.calls.filter(function (c) { return c.method === method; }); };
  return fake;
}

// A handle whose first turn has finished, and the stream's events as they arrive.
async function idleHandle(fake) {
  var handle = codexAdapter._test_createCodexQueryHandle(fake.appServer, { approvalPolicy: "on-request" });
  var events = [];
  // A reader that dies fails the test that ends the handle (see finish), so a
  // dead stream cannot make the "nothing reached the stream" checks pass.
  var reader = (async function () { for await (var e of handle) events.push(e); })();
  handle.pushMessage("first", null, "human", "m1");
  for (var i = 0; i < 100 && fake.callsTo("turn/start").length === 0; i++) await tick();
  for (i = 0; i < 10; i++) await tick();
  return { handle: handle, events: events, reader: reader };
}

async function finish(h) {
  h.handle.close();
  await h.reader;
}

function cmdItem(extra) {
  return Object.assign({ type: "commandExecution", id: "cmd-1" }, extra);
}

function startShellTurn(fake, id) {
  fake.dispatch("turn/started", { turn: { id: id || "turn-shell" } });
}

function completeShellItem(fake, item, id) {
  fake.dispatch("item/completed", { turnId: id || "turn-shell", item: cmdItem(item) });
}

function endShellTurn(fake, status, id) {
  fake.dispatch("turn/completed", { turn: { id: id || "turn-shell", status: status || "completed" } });
}

// The whole of an idle-thread command: its turn, its item, its end.
function commandTurn(fake, item, turnStatus) {
  startShellTurn(fake);
  fake.dispatch("item/started", { turnId: "turn-shell", item: cmdItem({ command: item.command, status: "inProgress" }) });
  completeShellItem(fake, item);
  endShellTurn(fake, turnStatus);
}

async function modelTurnEnded(h, fake, id) {
  var before = h.events.length;
  fake.dispatch("turn/started", { turn: { id: id } });
  fake.dispatch("turn/completed", { turn: { id: id, status: "completed" } });
  await tick();
  return h.events.length > before;
}

test("the request carries the thread, the command exactly as typed, and the console's timeout", async function () {
  var fake = fakeAppServer();
  var h = await idleHandle(fake);
  var typed = "echo $(touch /tmp/never); rm -rf / # \"quoted\"";
  var pending = h.handle.runUserShellCommand(typed, null, 600000, 262144);
  await tick();
  var calls = fake.callsTo("thread/shellCommand");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, { threadId: "thread-1", command: typed, timeoutMs: 600000 });
  commandTurn(fake, { command: typed, aggregatedOutput: "ok", exitCode: 0, durationMs: 9, status: "completed" });
  var result = await pending;
  assert.deepEqual(result, { exitCode: 0, durationMs: 9, output: "ok", truncated: false, timedOut: false, interrupted: false });
  await finish(h);
});

test("the command's own turn and items never reach the event stream", async function () {
  var fake = fakeAppServer();
  var h = await idleHandle(fake);
  var baseline = h.events.length;
  assert.ok(baseline > 0, "the first turn's events flowed");
  var pending = h.handle.runUserShellCommand("ls", null, 1000, 1024);
  await tick();
  commandTurn(fake, { command: "ls", aggregatedOutput: "a\nb", exitCode: 0, durationMs: 3, status: "completed" });
  await pending;
  await tick();
  assert.equal(h.events.length, baseline, "no turn_start, tool or result event came from the command");
  await finish(h);
});

test("output past the cap is cut with the marker and the result says so", async function () {
  var fake = fakeAppServer();
  var h = await idleHandle(fake);
  var pending = h.handle.runUserShellCommand("big", null, 1000, 100);
  await tick();
  commandTurn(fake, { command: "big", aggregatedOutput: "z".repeat(5000), exitCode: 0, durationMs: 3, status: "completed" });
  var result = await pending;
  assert.equal(result.truncated, true);
  assert.equal(result.output, "z".repeat(100) + "\n[output truncated at 100 bytes]");
  await finish(h);
});

test("a cap inside a multibyte character backs off to the character boundary", async function () {
  var fake = fakeAppServer();
  var h = await idleHandle(fake);
  var pending = h.handle.runUserShellCommand("big", null, 1000, 10);
  await tick();
  commandTurn(fake, { command: "big", aggregatedOutput: "a".repeat(9) + "éé", exitCode: 0, durationMs: 3, status: "completed" });
  var result = await pending;
  assert.equal(result.output, "a".repeat(9) + "\n[output truncated at 10 bytes]");
  await finish(h);
});

test("failure text cannot push the output past the cap", async function () {
  var fake = fakeAppServer();
  var h = await idleHandle(fake);
  var pending = h.handle.runUserShellCommand("big", null, 1000, 50);
  await tick();
  startShellTurn(fake);
  fake.dispatch("item/started", { turnId: "turn-shell", item: cmdItem({ command: "big", aggregatedOutput: "q".repeat(50), status: "inProgress" }) });
  fake.dispatch("turn/failed", { turn: { id: "turn-shell", status: "failed" }, error: { message: "boom ".repeat(40) } });
  var result = await pending;
  var kept = result.output.slice(0, result.output.indexOf("\n[output truncated"));
  assert.ok(Buffer.byteLength(kept) <= 50);
  assert.equal(result.truncated, true);
  await finish(h);
});

test("a command the app-server stopped for its timeout reports timedOut", async function () {
  var fake = fakeAppServer();
  var h = await idleHandle(fake);
  var pending = h.handle.runUserShellCommand("sleep 999", null, 1500, 1024);
  await tick();
  commandTurn(fake, { command: "sleep 999", aggregatedOutput: "", status: "failed" });
  var result = await pending;
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  await finish(h);
});

test("a request the app-server refuses rejects, and a second command may follow", async function () {
  var refusing = true;
  var fake = fakeAppServer(function () {
    return refusing ? Promise.reject(rpcError("thread not found", -32600)) : Promise.resolve({});
  });
  var h = await idleHandle(fake);
  await assert.rejects(h.handle.runUserShellCommand("ls", null, 1000, 1024), /thread not found/);
  refusing = false;
  var pending = h.handle.runUserShellCommand("ls", null, 1000, 1024);
  await tick();
  commandTurn(fake, { command: "ls", aggregatedOutput: "x", exitCode: 0, durationMs: 1, status: "completed" });
  assert.equal((await pending).exitCode, 0);
  await finish(h);
});

test("one command at a time, and none without a running thread", async function () {
  var fake = fakeAppServer();
  var h = await idleHandle(fake);
  var first = h.handle.runUserShellCommand("ls", null, 1000, 1024);
  await assert.rejects(h.handle.runUserShellCommand("pwd", null, 1000, 1024), /already running/);
  await tick();
  commandTurn(fake, { command: "ls", aggregatedOutput: "", exitCode: 0, durationMs: 1, status: "completed" });
  await first;
  await finish(h);

  var cold = codexAdapter._test_createCodexQueryHandle(fakeAppServer().appServer, { approvalPolicy: "on-request" });
  await assert.rejects(cold.runUserShellCommand("ls", null, 1000, 1024), /no running Codex thread/);
});

test("after a command, the next real turn is delivered as usual", async function () {
  var fake = fakeAppServer();
  var h = await idleHandle(fake);
  var pending = h.handle.runUserShellCommand("ls", null, 1000, 1024);
  await tick();
  commandTurn(fake, { command: "ls", aggregatedOutput: "x", exitCode: 0, durationMs: 1, status: "completed" });
  await pending;
  var before = h.events.length;
  h.handle.pushMessage("second", null, "human", "m2");
  for (var i = 0; i < 100 && fake.callsTo("turn/start").length < 2; i++) await tick();
  for (i = 0; i < 10; i++) await tick();
  assert.ok(h.events.slice(before).some(function (e) { return e.yokeType === "turn_start"; }), "the second turn's events were not swallowed");
  await finish(h);
});

// --- The turn-id table: one proving row for each way a turn can be mistaken ---

test("turn-id table U3: a late end of a settled command's turn is taken by its id, never by count", async function () {
  var fake = fakeAppServer();
  var h = await idleHandle(fake);
  test.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // Two commands settle on the grace time with their turns still to end.
    var first = h.handle.runUserShellCommand("one", null, 1000, 1024);
    await tick();
    startShellTurn(fake, "turn-a");
    completeShellItem(fake, { command: "one", aggregatedOutput: "1", exitCode: 0, durationMs: 1, status: "completed" }, "turn-a");
    test.mock.timers.tick(3000);
    assert.equal((await first).output, "1");

    var second = h.handle.runUserShellCommand("two", null, 1000, 1024);
    await tick();
    startShellTurn(fake, "turn-b");
    completeShellItem(fake, { id: "cmd-2", command: "two", aggregatedOutput: "2", exitCode: 0, durationMs: 1, status: "completed" }, "turn-b");
    test.mock.timers.tick(3000);
    assert.equal((await second).output, "2");

    // A model turn ending inside the window is not one of the expected endings.
    assert.equal(await modelTurnEnded(h, fake, "turn-model"), true, "the model turn's end reached the stream");

    var afterModel = h.events.length;
    endShellTurn(fake, "completed", "turn-b");
    endShellTurn(fake, "completed", "turn-a");
    await tick();
    assert.equal(h.events.length, afterModel, "both late command endings stayed out of the stream, in either order");

    assert.equal(await modelTurnEnded(h, fake, "turn-model-2"), true, "an ending that is nobody's expected one is delivered");
  } finally {
    test.mock.timers.reset();
  }
  await finish(h);
});

test("turn-id table V2: an abort before turn/started is held with no timer, and sent when that run's turn starts", async function () {
  var fake = fakeAppServer();
  var h = await idleHandle(fake);
  var ac = new AbortController();
  var pending = h.handle.runUserShellCommand("sleep 999", null, 60000, 1024, { signal: ac.signal });
  await tick();
  ac.abort();
  await tick();
  assert.equal(fake.callsTo("turn/interrupt").length, 0, "no turn to interrupt yet");
  startShellTurn(fake);
  await tick();
  assert.equal(fake.callsTo("turn/interrupt").length, 1, "sent once, when the shell turn's id is known");
  completeShellItem(fake, { command: "sleep 999", aggregatedOutput: "", status: "failed" });
  endShellTurn(fake, "interrupted");
  assert.equal((await pending).interrupted, true);
  await finish(h);
});

test("turn-id table V2: an abort is held however long the turn takes to start, and a run with no turn settles timedOut", async function () {
  var fake = fakeAppServer();
  var h = await idleHandle(fake);
  test.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    var ac = new AbortController();
    var pending = h.handle.runUserShellCommand("sleep 999", null, 60000, 1024, { signal: ac.signal });
    await tick();
    ac.abort();
    test.mock.timers.tick(30000);
    await tick();
    assert.equal(fake.callsTo("turn/interrupt").length, 0, "no timer sends or settles an abort held before the turn");
    var settled = false;
    pending.then(function () { settled = true; });
    await tick();
    assert.equal(settled, false, "still held well past the old grace times");
    test.mock.timers.tick(60000);
    var result = await pending;
    assert.equal(result.timedOut, true, "no turn before the timeout plus the margin");
    assert.equal(result.interrupted, false, "the command may still be running");
  } finally {
    test.mock.timers.reset();
  }
  await finish(h);
});

test("turn-id table V2: an interrupt the turn never answers is not reported as interrupted", async function () {
  var fake = fakeAppServer();
  var h = await idleHandle(fake);
  test.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    var ac = new AbortController();
    var pending = h.handle.runUserShellCommand("sleep 999", null, 60000, 1024, { signal: ac.signal });
    await tick();
    startShellTurn(fake);
    ac.abort();
    assert.equal(fake.callsTo("turn/interrupt").length, 1);
    test.mock.timers.tick(3000);
    assert.equal((await pending).interrupted, false, "the turn did not end, so the command may still run");
  } finally {
    test.mock.timers.reset();
  }
  await finish(h);
});

test("turn-id table X1: a model turn ending while the command is starting does not settle it and is delivered", async function () {
  var fake = fakeAppServer();
  var h = await idleHandle(fake);
  var pending = h.handle.runUserShellCommand("ls", null, 1000, 1024);
  var settled = false;
  pending.then(function () { settled = true; });
  await tick();
  // The command's turn has not started; a model turn ends with another id.
  var before = h.events.length;
  fake.dispatch("turn/completed", { turn: { id: "turn-model", status: "completed" } });
  await tick();
  assert.equal(settled, false, "a turn end with another id does not settle the command");
  assert.ok(h.events.length > before, "the model's turn end reached the stream");

  commandTurn(fake, { command: "ls", aggregatedOutput: "real", exitCode: 0, durationMs: 2, status: "completed" });
  var result = await pending;
  assert.equal(result.output, "real", "the result is the command's own, not an empty one from the model's end");
  await finish(h);
});

test("a command asked for in another directory is refused with a reason, never run or sent", async function () {
  var fake = fakeAppServer();
  var h = await idleHandle(fake);
  var other = require("path").resolve(require("os").tmpdir(), "not-the-thread-directory");
  var result = await h.handle.runUserShellCommand("pwd", other, 20000, 1024);
  assert.equal(result.exitCode, null);
  assert.equal(result.interrupted, false);
  assert.match(result.output, /only in its own working directory/);
  assert.equal(fake.callsTo("thread/shellCommand").length, 0, "not sent to the thread");
  await finish(h);
});

test("a command is refused, without being sent, while a model turn is running", async function () {
  var fake = fakeAppServer();
  var h = await idleHandle(fake);
  fake.dispatch("turn/started", { turn: { id: "turn-model" } });
  var before = h.events.length;
  var result = await h.handle.runUserShellCommand("ls", null, 1000, 1024);
  assert.equal(fake.callsTo("thread/shellCommand").length, 0);
  assert.equal(result.exitCode, null);
  assert.match(result.output, /agent is working/);
  fake.dispatch("turn/completed", { turn: { id: "turn-model", status: "completed" } });
  await tick();
  assert.ok(h.events.length > before, "the model turn's end reached the stream");
  await finish(h);
});

test("turn-id table Y7: a turn that starts after a run gave up is never bound by timing and is delivered", async function () {
  var fake = fakeAppServer();
  var h = await idleHandle(fake);
  test.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    var pending = h.handle.runUserShellCommand("sleep 999", null, 60000, 1024);
    await tick();
    test.mock.timers.tick(80000);
    assert.equal((await pending).timedOut, true);

    var before = h.events.length;
    assert.equal(await modelTurnEnded(h, fake, "turn-after"), true, "a turn after the run settled is delivered, not captured");
    assert.ok(h.events.length > before);
  } finally {
    test.mock.timers.reset();
  }
  await finish(h);
});

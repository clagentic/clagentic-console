"use strict";
// However many projects the daemon opens at startup, they share one process
// "exit" listener: fifty session managers used to add fifty and tripped Node's
// MaxListenersExceededWarning (51 listeners against the daemon's raised cap of
// 50). The cap is not raised; the registration is shared.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { registerExitFlush } = require("../lib/exit-flush");

function newListeners(before) {
  return process.listeners("exit").filter(function (fn) { return before.indexOf(fn) === -1; });
}

test("many flushers share one exit listener, which runs every one of them", function () {
  var before = process.listeners("exit");
  var ran = [];
  var unregister = [];
  for (var i = 0; i < 60; i++) {
    (function (n) { unregister.push(registerExitFlush(function () { ran.push(n); })); })(i);
  }
  var added = newListeners(before);
  assert.equal(added.length, 1, "sixty flushers, one listener");

  added[0]();
  assert.equal(ran.length, 60);

  unregister.forEach(function (fn) { fn(); });
  assert.equal(newListeners(before).length, 0, "the last unregister removes it");
  assert.equal(process.listeners("exit").length, before.length);
});

test("one flusher throwing does not stop the others, and the failure is logged", function (t) {
  var errors = [];
  t.mock.method(console, "error", function () { errors.push(Array.prototype.join.call(arguments, " ")); });
  var before = process.listeners("exit");
  var ran = [];
  var off = [
    registerExitFlush(function () { throw new Error("disk full"); }),
    registerExitFlush(function () { ran.push("second"); }),
  ];
  newListeners(before)[0]();
  assert.deepEqual(ran, ["second"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /disk full/);
  off.forEach(function (fn) { fn(); });
});

test("unregistering twice is harmless and does not remove a listener other flushers still need", function () {
  var before = process.listeners("exit");
  var offA = registerExitFlush(function () {});
  var offB = registerExitFlush(function () {});
  offA();
  offA();
  assert.equal(newListeners(before).length, 1, "B still holds the listener");
  offB();
  assert.equal(newListeners(before).length, 0);
});

test("opening many real session managers at startup adds one listener and no MaxListeners warning", async function () {
  var homes = [];
  var warnings = [];
  function onWarning(w) { warnings.push(w); }
  process.on("warning", onWarning);
  var origHome = process.env.CLAGENTIC_CONSOLE_HOME;
  var managers = [];
  var before = process.listeners("exit");
  try {
    for (var i = 0; i < 60; i++) {
      var home = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-exit-flush-"));
      homes.push(home);
      process.env.CLAGENTIC_CONSOLE_HOME = home;
      ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) { delete require.cache[require.resolve(m)]; });
      managers.push(require("../lib/sessions").createSessionManager({
        cwd: home, send: function () {}, sendTo: function () {}, sendEach: function () {},
      }));
    }
    assert.equal(newListeners(before).length, 1);
    await new Promise(function (resolve) { setImmediate(resolve); });
    assert.deepEqual(warnings.filter(function (w) { return w.name === "MaxListenersExceededWarning"; }), []);
  } finally {
    managers.forEach(function (sm) { sm.destroy(); });
    process.removeListener("warning", onWarning);
    if (origHome === undefined) delete process.env.CLAGENTIC_CONSOLE_HOME;
    else process.env.CLAGENTIC_CONSOLE_HOME = origHome;
    homes.forEach(function (h) { fs.rmSync(h, { recursive: true, force: true }); });
  }
  assert.equal(newListeners(before).length, 0);
});

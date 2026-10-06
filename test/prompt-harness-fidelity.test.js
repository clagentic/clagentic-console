"use strict";
// The prompt invariant harness is only as good as its likeness to the
// daemon and its own verdicts: its world must hand the session handlers the
// same connected sockets the transport serves, and the history matrix must
// fail when a scenario still fails just after its fix.

var test = require("node:test");
var assert = require("node:assert/strict");
var world = require("./prompt-harness-world");
var history = require("../scripts/prompt-harness-history");

test("the harness world gives the session handlers the sockets connect() adds, in production's shape", async function () {
  var server = await world.createServer();
  try {
    var ws = { send: function () {} };
    server.connect(ws);
    var handed = server.handlerContext.clients;
    assert.equal(handed, server.clients, "one collection for the transport and the handlers");
    assert.ok(handed instanceof Set, "a Set, as lib/project.js keeps them");
    assert.ok(handed.has(ws), "a connected socket is visible to the handlers");
    assert.equal(handed.size, 1);
    server.disconnect(ws);
    assert.equal(handed.has(ws), false, "and gone once it disconnects");
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

var ROW = { scenario: "s", before: "b", after: "a", signature: /the defect \(I7\)/ };
var PASS = { passed: true, codes: [], output: "ok" };
var DEFECT = { passed: false, codes: ["I7"], output: "the defect (I7)" };
var LATER = { passed: false, codes: ["I2"], output: "a defect fixed later (I2)" };
var CRASH = { passed: false, codes: ["error"], output: "TypeError" };

test("every row of the history matrix names the violation its defect produces", function () {
  history.MATRIX.forEach(function (row) {
    assert.ok(row.signature instanceof RegExp, row.scenario);
  });
});

test("the history matrix rejects an after-fix run that still shows the defect or crashed, and a before run that does not show it", function () {
  assert.deepEqual(history.rowProblems(ROW, DEFECT, PASS, PASS), [], "defect before, gone after, pass now: holds");
  assert.deepEqual(history.rowProblems(ROW, DEFECT, LATER, PASS), [], "a defect fixed later may remain after this fix");
  assert.match(history.rowProblems(ROW, DEFECT, DEFECT, PASS)[0], /still fails with its defect after its fix/);
  assert.match(history.rowProblems(ROW, DEFECT, CRASH, PASS)[0], /still fails with its defect after its fix/);
  assert.match(history.rowProblems(ROW, PASS, PASS, PASS)[0], /does not show its defect before its fix/);
  assert.match(history.rowProblems(ROW, LATER, PASS, PASS)[0], /does not show its defect before its fix/);
  assert.match(history.rowProblems(ROW, DEFECT, PASS, LATER)[0], /fails on this checkout/);
});

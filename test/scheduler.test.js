var test = require("node:test");
var assert = require("node:assert");
var { parseCronField, parseCron, nextRunTime } = require("../lib/scheduler");

// --- parseCronField: step validation ---

test("parseCronField: step=0 throws (infinite-loop guard)", function () {
  assert.throws(
    function () { parseCronField("*/0", 0, 59); },
    /invalid cron step value/
  );
});

test("parseCronField: step=0 in range expression throws", function () {
  assert.throws(
    function () { parseCronField("0-59/0", 0, 59); },
    /invalid cron step value/
  );
});

test("parseCronField: negative step throws", function () {
  assert.throws(
    function () { parseCronField("*/-1", 0, 59); },
    /invalid cron step value/
  );
});

test("parseCronField: float step throws", function () {
  // parseInt("1.5", 10) === 1, which is valid. But "0.5" => parseInt => 0, which is < 1.
  // Test a value where the raw string is a float that parseInt turns into 0.
  assert.throws(
    function () { parseCronField("*/0.5", 0, 59); },
    /invalid cron step value/
  );
});

test("parseCronField: non-numeric step throws", function () {
  // parseInt("abc", 10) === NaN; NaN is not an integer.
  assert.throws(
    function () { parseCronField("*/abc", 0, 59); },
    /invalid cron step value/
  );
});

// --- parseCronField: valid cases still work ---

test("parseCronField: */1 returns all values in range", function () {
  var result = parseCronField("*/1", 0, 4);
  assert.deepStrictEqual(result, [0, 1, 2, 3, 4]);
});

test("parseCronField: */15 returns correct minute marks", function () {
  var result = parseCronField("*/15", 0, 59);
  assert.deepStrictEqual(result, [0, 15, 30, 45]);
});

test("parseCronField: */2 with range 0-6", function () {
  var result = parseCronField("0-6/2", 0, 6);
  assert.deepStrictEqual(result, [0, 2, 4, 6]);
});

test("parseCronField: wildcard expands correctly", function () {
  var result = parseCronField("*", 0, 2);
  assert.deepStrictEqual(result, [0, 1, 2]);
});

test("parseCronField: range without step", function () {
  var result = parseCronField("1-3", 0, 59);
  assert.deepStrictEqual(result, [1, 2, 3]);
});

test("parseCronField: single value", function () {
  var result = parseCronField("5", 0, 59);
  assert.deepStrictEqual(result, [5]);
});

// --- parseCron: step=0 in full expression ---

test("parseCron: */0 in minute field returns null (parseCronField throws, parseCron propagates)", function () {
  // parseCron does not catch; the Error propagates to the caller.
  assert.throws(
    function () { parseCron("*/0 * * * *"); },
    /invalid cron step value/
  );
});

test("parseCron: */0 in hour field throws", function () {
  assert.throws(
    function () { parseCron("* */0 * * *"); },
    /invalid cron step value/
  );
});

// --- nextRunTime: valid expressions still work ---

test("nextRunTime: returns a future timestamp for a valid expression", function () {
  var now = Date.now();
  var result = nextRunTime("* * * * *", now);
  assert.ok(typeof result === "number", "expected a number");
  assert.ok(result > now, "expected result to be in the future");
});

test("nextRunTime: returns null for a malformed expression (wrong field count)", function () {
  var result = nextRunTime("* * * *", Date.now());
  assert.strictEqual(result, null);
});

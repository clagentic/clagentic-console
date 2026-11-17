// Plan usage read at turn end: the adapter's one capability check, the
// rate-limited reader, and the store's closed-window rule on a recorded reading.
var test = require("node:test");
var assert = require("node:assert/strict");
var { createUsageStore } = require("../lib/usage-store");
var { createPlanUsageReader, SOURCE } = require("../lib/plan-usage-reader");
var claude = require("../lib/yoke/adapters/claude");

var METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
var NOW = Date.parse("2026-11-16T12:00:00Z");
var FUTURE_ISO = "2026-11-20T00:00:00Z";
var PAST_ISO = "2026-11-10T00:00:00Z";

function quiet() { return createUsageStore({ log: function () {} }); }
function handleOver(raw) { return claude._test_createQueryHandle(raw, { push: function () {}, end: function () {} }, null, {}); }
function reply(fiveHour, sevenDay, extra) {
  return Object.assign({ rate_limits_available: true, rate_limits: { five_hour: fiveHour, seven_day: sevenDay } }, extra);
}
function win(utilization, resetsAt) { return { utilization: utilization, resets_at: resetsAt }; }
function bucket(store, name, now) {
  return store.snapshot({ now: now, staleSeconds: 1800, vendorIds: ["claude"] }).vendors.claude.buckets[name];
}
// Reads once through a real handle over a fake SDK query.
async function readOnce(raw, store) {
  var reader = createPlanUsageReader({ store: store, now: function () { return NOW; } });
  await reader.maybeRead(handleOver(raw), "claude");
}

test("AC1: a reading is recorded as utilization/100 with resetsAt and the read time", async function () {
  var s = quiet();
  var calls = [];
  var raw = {};
  raw[METHOD] = function (o) { calls.push(o); return Promise.resolve(reply(win(7, FUTURE_ISO), win(42, FUTURE_ISO))); };
  await readOnce(raw, s);
  assert.deepEqual(calls, [{ skipBehaviors: true }]);
  var seven = bucket(s, "seven_day", NOW);
  assert.equal(seven.utilization, 0.42);
  assert.equal(seven.resetsAt, new Date(FUTURE_ISO).toISOString());
  assert.equal(seven.utilizationObservedAt, new Date(NOW).toISOString());
  assert.equal(seven.source, SOURCE);
  assert.equal(bucket(s, "five_hour", NOW).utilization, 0.07);
});

test("AC2: reads inside the interval are not issued; one after it is", async function () {
  var s = quiet();
  var n = 0;
  var raw = {};
  raw[METHOD] = function () { n++; return Promise.resolve(reply(win(1, FUTURE_ISO), win(2, FUTURE_ISO))); };
  var t = NOW;
  var reader = createPlanUsageReader({ store: s, intervalMs: 1000, now: function () { return t; } });
  var h = handleOver(raw);
  assert.equal(await reader.maybeRead(h, "claude"), true);
  t += 999;
  assert.equal(await reader.maybeRead(h, "claude"), false);
  t += 1;
  assert.equal(await reader.maybeRead(h, "claude"), true);
  assert.equal(n, 2);
});

var DEGRADED = [
  ["method absent", function () { return {}; }],
  ["method throws", function () { var r = {}; r[METHOD] = function () { throw new Error("gone"); }; return r; }],
  ["method rejects", function () { var r = {}; r[METHOD] = function () { return Promise.reject(new Error("no")); }; return r; }],
  ["rate_limits_available false", function () { var r = {}; r[METHOD] = function () { return Promise.resolve({ rate_limits_available: false, rate_limits: null }); }; return r; }],
  ["rate_limits null", function () { var r = {}; r[METHOD] = function () { return Promise.resolve({ rate_limits_available: true, rate_limits: null }); }; return r; }],
  ["malformed utilization", function () { var r = {}; r[METHOD] = function () { return Promise.resolve(reply(win("12", FUTURE_ISO), win(null, FUTURE_ISO))); }; return r; }],
  ["reply not an object", function () { var r = {}; r[METHOD] = function () { return Promise.resolve("x"); }; return r; }],
];
DEGRADED.forEach(function (row) {
  test("AC3: " + row[0] + " records nothing and leaves the event record as it was", async function () {
    var s = quiet();
    s.record("claude", { rateLimitType: "seven_day", utilization: 0.9, resetsAt: NOW / 1000 + 86400, status: "allowed_warning" }, { now: NOW, source: "claude-cli:rate_limit_event" });
    var before = JSON.stringify(bucket(s, "seven_day", NOW));
    await readOnce(row[1](), s);
    assert.equal(JSON.stringify(bucket(s, "seven_day", NOW)), before);
    assert.equal(bucket(s, "five_hour", NOW).state, "unknown");
  });
});

test("AC3: a handle with no readPlanUsage is not read", async function () {
  var reader = createPlanUsageReader({ store: quiet(), now: function () { return NOW; } });
  assert.equal(await reader.maybeRead({}, "claude"), false);
  assert.equal(await reader.maybeRead(null, "claude"), false);
});

test("AC4: a reading whose resets_at is past reads as a closed window, never zero", async function () {
  var s = quiet();
  var raw = {};
  raw[METHOD] = function () { return Promise.resolve(reply(win(30, PAST_ISO), win(55, PAST_ISO))); };
  await readOnce(raw, s);
  var b = bucket(s, "seven_day", NOW);
  assert.equal(b.utilization, null);
  assert.equal(b.lastKnownUtilization, 0.55);
  assert.equal(b.lastKnownPreReset, true);
  assert.equal(b.state, "expired");
});

test("a reading is stamped when the reply lands, after an event recorded while the read was pending", async function () {
  var s = quiet();
  var t = NOW;
  var release;
  var raw = {};
  raw[METHOD] = function () { return new Promise(function (res) { release = function () { res(reply(null, win(50, FUTURE_ISO))); }; }); };
  var reader = createPlanUsageReader({ store: s, now: function () { return t; } });
  var done = reader.maybeRead(handleOver(raw), "claude");
  t = NOW + 500;
  s.record("claude", { rateLimitType: "seven_day", utilization: 0.9, resetsAt: Date.parse(FUTURE_ISO) / 1000, status: "allowed_warning" }, { now: t, source: "claude-cli:rate_limit_event" });
  t = NOW + 1000;
  release();
  await done;
  var b = bucket(s, "seven_day", t);
  assert.equal(b.utilizationObservedAt, new Date(NOW + 1000).toISOString());
  assert.equal(b.utilization, 0.5);
});

test("a reading keeps the status a rate-limit event reported for the same window", async function () {
  var s = quiet();
  s.record("claude", { rateLimitType: "seven_day", utilization: 0.8, resetsAt: Date.parse(FUTURE_ISO) / 1000, status: "allowed_warning" }, { now: NOW - 1000 });
  var raw = {};
  raw[METHOD] = function () { return Promise.resolve(reply(null, win(81, FUTURE_ISO))); };
  await readOnce(raw, s);
  var b = bucket(s, "seven_day", NOW);
  assert.equal(b.utilization, 0.81);
  assert.equal(b.status, "allowed_warning");
});

test("a fractional resets_at in the same window keeps the event status and is no reset", function () {
  var s = quiet();
  var sec = Date.parse(FUTURE_ISO) / 1000;
  s.record("claude", { rateLimitType: "seven_day", utilization: 0.8, resetsAt: sec, status: "allowed_warning" }, { now: NOW - 1000 });
  s.record("claude", { rateLimitType: "seven_day", utilization: null, resetsAt: sec + 0.4 }, { now: NOW, keepStatus: true });
  var b = bucket(s, "seven_day", NOW);
  assert.equal(b.status, "allowed_warning");
  assert.equal(b.utilization, 0.8);
  assert.equal(b.resetsAt, new Date(FUTURE_ISO).toISOString());
});

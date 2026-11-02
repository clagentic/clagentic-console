// Account usage store, the --usage verb wiring, and the codex missing-usedPercent fix.
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var { execFileSync } = require("child_process");
var { createUsageStore } = require("../lib/usage-store");

var NOW = Date.parse("2026-11-02T12:00:00Z");
var FUTURE = NOW / 1000 + 3600;
var PAST = NOW / 1000 - 3600;

function snap(store, extra) {
  return store.snapshot(Object.assign({ now: NOW, staleSeconds: 1800, vendorIds: ["claude", "codex"] }, extra));
}

test("event with utilization yields a fresh record", function () {
  var s = createUsageStore();
  s.record("claude", { rateLimitType: "five_hour", utilization: 0.42, resetsAt: FUTURE, status: "allowed" }, { now: NOW - 60000, source: "claude-cli:rate_limit_event" });
  var b = snap(s).vendors.claude.buckets.five_hour;
  assert.equal(b.utilization, 0.42);
  assert.equal(b.state, "fresh");
  assert.equal(b.ageSeconds, 60);
  assert.equal(b.source, "claude-cli:rate_limit_event");
});

test("event without utilization is null, not 0", function () {
  var s = createUsageStore();
  s.record("claude", { rateLimitType: "seven_day", resetsAt: FUTURE, status: "allowed" }, { now: NOW });
  assert.equal(snap(s).vendors.claude.buckets.seven_day.utilization, null);
});

test("null after known in the same window keeps the known value", function () {
  var s = createUsageStore();
  s.record("claude", { rateLimitType: "five_hour", utilization: 0.5, resetsAt: FUTURE, status: "allowed" }, { now: NOW - 120000 });
  s.record("claude", { rateLimitType: "five_hour", resetsAt: FUTURE, status: "allowed_warning" }, { now: NOW - 10000 });
  var b = snap(s).vendors.claude.buckets.five_hour;
  assert.equal(b.utilization, 0.5);
  assert.equal(b.status, "allowed_warning");
  assert.equal(b.ageSeconds, 10);
  assert.equal(b.utilizationObservedAt, new Date(NOW - 120000).toISOString());
});

test("null in a new window does not keep the old value", function () {
  var s = createUsageStore();
  s.record("claude", { rateLimitType: "five_hour", utilization: 0.5, resetsAt: FUTURE }, { now: NOW - 5000 });
  s.record("claude", { rateLimitType: "five_hour", resetsAt: FUTURE + 18000 }, { now: NOW });
  assert.equal(snap(s).vendors.claude.buckets.five_hour.utilization, null);
});

test("resetsAt in the past is expired and not zeroed", function () {
  var s = createUsageStore();
  s.record("claude", { rateLimitType: "five_hour", utilization: 0.9, resetsAt: PAST }, { now: NOW - 5000 });
  var b = snap(s).vendors.claude.buckets.five_hour;
  assert.equal(b.state, "expired");
  assert.equal(b.utilization, 0.9);
});

test("observedAt older than the threshold is stale", function () {
  var s = createUsageStore();
  s.record("claude", { rateLimitType: "five_hour", utilization: 0.1, resetsAt: FUTURE }, { now: NOW - 3600 * 1000 / 2 - 1000 });
  assert.equal(snap(s).vendors.claude.buckets.five_hour.state, "stale");
});

test("never-seen five_hour and seven_day are unknown for every registered vendor", function () {
  var v = snap(createUsageStore()).vendors;
  ["claude", "codex"].forEach(function (id) {
    ["five_hour", "seven_day"].forEach(function (b) {
      var r = v[id].buckets[b];
      assert.equal(r.state, "unknown");
      assert.equal(r.utilization, null);
      assert.equal(r.observedAt, null);
    });
  });
});

test("per-model bucket key passes through verbatim and appears only once seen", function () {
  var s = createUsageStore();
  assert.equal(snap(s).vendors.claude.buckets.seven_day_opus, undefined);
  s.record("claude", { rateLimitType: "seven_day_opus", utilization: 0.3, resetsAt: FUTURE }, { now: NOW });
  assert.equal(snap(s).vendors.claude.buckets.seven_day_opus.utilization, 0.3);
});

test("stale threshold is overridable by CLAGENTIC_CONSOLE_USAGE_STALE_SECONDS", function () {
  var out = createUsageStore().snapshot({ now: NOW, env: { CLAGENTIC_CONSOLE_USAGE_STALE_SECONDS: "60" } });
  assert.equal(out.staleAfterSeconds, 60);
});

test("codex adapter: missing usedPercent gives null utilization, present gives a fraction", async function () {
  var codexAdapter = require("../lib/yoke/adapters/codex");
  var handlers = [];
  var appServer = {
    started: true,
    addEventHandler: function (fn, t) { var e = { fn: fn, threadId: t || null }; handlers.push(e); return e; },
    removeEventHandler: function () {},
    updateHandlerThreadId: function (e, t) { e.threadId = t || null; },
    respond: function () {},
    send: function (method) { return Promise.resolve(method === "thread/start" ? { thread: { id: "t1" } } : {}); },
  };
  var handle = codexAdapter._test_createCodexQueryHandle(appServer, { model: "gpt-5.5" });
  var events = [];
  var done = (async function () {
    for await (var evt of handle) {
      if (evt.yokeType === "rate_limit") events.push(evt);
      if (evt.yokeType === "result") break;
    }
  })();
  handle.pushMessage("hello");
  await new Promise(function (r) { setImmediate(r); });
  var dispatch = function (m) { handlers.forEach(function (h) { h.fn(m); }); };
  dispatch({ method: "account/rateLimits/updated", params: { rateLimits: {
    primary: { resetsAt: 1234567890 },
    secondary: { usedPercent: 0, resetsAt: 1234567890 },
  } } });
  dispatch({ method: "turn/completed", params: { threadId: "t1", turn: { id: "turn-1", status: "completed" } } });
  await Promise.race([done, new Promise(function (r) { setTimeout(r, 200); })]);
  assert.equal(events.length, 2);
  assert.equal(events[0].rateLimitInfo.utilization, null);
  assert.equal(events[0].rateLimitSource, "codex:rateLimits");
  assert.equal(events[1].rateLimitInfo.utilization, 0, "a real 0% stays 0");
  handle.close();
});

test("daemon get_usage case and --usage help are wired", function () {
  var daemon = fs.readFileSync(path.join(__dirname, "..", "lib/daemon.js"), "utf8");
  assert.ok(/case "get_usage":[\s\S]{0,200}usage-store/.test(daemon));
  var help = execFileSync(process.execPath, [path.join(__dirname, "..", "bin/cli.js"), "--help"], { encoding: "utf8" });
  assert.ok(/--usage\s+Print account usage per vendor and rate-limit bucket as JSON/.test(help));
});

test("the unknown-argument guard accepts --usage", function () {
  var { findUnrecognisedArg } = require("../lib/cli/arg-validation");
  assert.strictEqual(findUnrecognisedArg(["--usage"]), null);
});

// Usage store persistence: roundtrip, honest freshness after reload, bad files.
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { createUsageStore } = require("../lib/usage-store");

var NOW = Date.parse("2026-11-02T12:00:00Z");
var FUTURE = NOW / 1000 + 86400;

function tmpFile() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-persist-"));
  return { dir: dir, file: path.join(dir, "usage-store.json") };
}
function snap(s, now) {
  return s.snapshot({ now: now, staleSeconds: 1800, vendorIds: ["claude"] });
}

test("persist and reload keeps observedAt, utilization, utilizationObservedAt", function () {
  var t = tmpFile();
  var a = createUsageStore({ file: t.file, log: function () {} });
  a.record("claude", { rateLimitType: "five_hour", utilization: 0.4, resetsAt: FUTURE, status: "allowed" }, { now: NOW, source: "s", sessionLocalId: "7" });
  a.flush();
  var b = createUsageStore({ file: t.file, log: function () {} });
  b.load();
  var x = snap(b, NOW + 1000).vendors.claude.buckets.five_hour;
  assert.equal(x.utilization, 0.4);
  assert.equal(x.observedAt, new Date(NOW).toISOString());
  assert.equal(x.utilizationObservedAt, new Date(NOW).toISOString());
  assert.equal(x.state, "fresh");
});

test("reloaded old record reads stale, then expired, never re-stamped fresh", function () {
  var t = tmpFile();
  var a = createUsageStore({ file: t.file, log: function () {} });
  a.record("claude", { rateLimitType: "five_hour", utilization: 0.4, resetsAt: NOW / 1000 + 7200, status: "allowed" }, { now: NOW });
  a.flush();
  var b = createUsageStore({ file: t.file, log: function () {} });
  b.load();
  assert.equal(snap(b, NOW + 3600 * 1000).vendors.claude.buckets.five_hour.state, "stale");
  var e = snap(b, NOW + 3 * 3600 * 1000).vendors.claude.buckets.five_hour;
  assert.equal(e.state, "expired");
  assert.equal(e.observedAt, new Date(NOW).toISOString());
});

test("corrupt file gives an empty store, one log line, file kept as .corrupt", function () {
  var t = tmpFile();
  fs.writeFileSync(t.file, "{not json");
  var logs = [];
  var s = createUsageStore({ file: t.file, log: function (m) { logs.push(m); } });
  s.load();
  assert.equal(snap(s, NOW).vendors.claude.buckets.five_hour.state, "unknown");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Clagentic: Console/);
  assert.ok(fs.existsSync(t.file + ".corrupt"));
});

test("wrong-shape file gives an empty store and a log line", function () {
  var t = tmpFile();
  fs.writeFileSync(t.file, JSON.stringify([1, 2]));
  var logs = [];
  var s = createUsageStore({ file: t.file, log: function (m) { logs.push(m); } });
  s.load();
  assert.equal(logs.length, 1);
  assert.equal(snap(s, NOW).vendors.claude.buckets.five_hour.state, "unknown");
});

test("missing file is empty and quiet", function () {
  var t = tmpFile();
  var logs = [];
  var s = createUsageStore({ file: t.file, log: function (m) { logs.push(m); } });
  s.load();
  assert.deepEqual(logs, []);
  assert.equal(snap(s, NOW).vendors.claude.buckets.five_hour.state, "unknown");
});

test("malformed records are dropped, valid ones kept", function () {
  var t = tmpFile();
  var good = { utilization: 0.1, utilizationObservedAt: new Date(NOW).toISOString(), resetsAt: null, status: "allowed", observedAt: new Date(NOW).toISOString(), source: null, sessionLocalId: null };
  var bad = Object.assign({}, good, { utilization: "high" });
  fs.writeFileSync(t.file, JSON.stringify({ version: 1, vendors: { claude: { five_hour: good, seven_day: bad } } }));
  var logs = [];
  var s = createUsageStore({ file: t.file, log: function (m) { logs.push(m); } });
  s.load();
  var v = snap(s, NOW).vendors.claude.buckets;
  assert.equal(v.five_hour.utilization, 0.1);
  assert.equal(v.seven_day.state, "unknown");
  assert.equal(logs.length, 1);
});

test("throttle coalesces several records into one write", function () {
  var writes = 0;
  var fake = {
    mkdirSync: function () {},
    writeFileSync: function () { writes++; },
    renameSync: function () {},
  };
  var s = createUsageStore({ file: "/x/usage-store.json", fs: fake, throttleMs: 10000, log: function () {} });
  for (var i = 0; i < 5; i++) s.record("claude", { rateLimitType: "five_hour", utilization: i / 10, status: "allowed" }, { now: NOW });
  assert.equal(writes, 0);
  s.flush();
  assert.equal(writes, 1);
  s.flush();
  assert.equal(writes, 1);
});

test("write failure logs and never throws into record()", function () {
  var logs = [];
  var fake = {
    mkdirSync: function () {},
    writeFileSync: function () { throw new Error("disk full"); },
    renameSync: function () {},
  };
  var s = createUsageStore({ file: "/x/u.json", fs: fake, log: function (m) { logs.push(m); } });
  s.record("claude", { rateLimitType: "five_hour", utilization: 0.2, status: "allowed" }, { now: NOW });
  s.flush();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /disk full/);
});

test("a store with no file does no I/O", function () {
  var s = createUsageStore();
  s.record("claude", { rateLimitType: "five_hour", utilization: 0.2, status: "allowed" }, { now: NOW });
  s.flush();
  s.load();
  assert.equal(snap(s, NOW).vendors.claude.buckets.five_hour.utilization, 0.2);
});

test("__proto__ vendor and bucket keys in the file do not pollute and the store stays usable", function () {
  var t = tmpFile();
  var rec = { utilization: 0.1, utilizationObservedAt: new Date(NOW).toISOString(), resetsAt: null, status: "allowed", observedAt: new Date(NOW).toISOString(), source: null, sessionLocalId: null };
  // JSON.parse makes "__proto__" an own key, as a hostile file would.
  fs.writeFileSync(t.file, '{"version":1,"vendors":{"__proto__":{"five_hour":' + JSON.stringify(rec) +
    '},"claude":{"__proto__":' + JSON.stringify(rec) + ',"seven_day":' + JSON.stringify(rec) + '}}}');
  var logs = [];
  var s = createUsageStore({ file: t.file, log: function (m) { logs.push(m); } });
  s.load();
  assert.equal(({}).utilization, undefined);
  assert.equal(({}).five_hour, undefined);
  assert.equal(Object.prototype.utilization, undefined);
  var v = snap(s, NOW).vendors.claude.buckets;
  assert.equal(v.seven_day.utilization, 0.1);
  assert.equal(Object.keys(v).indexOf("__proto__"), -1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /dropped 2 /);
  s.record("claude", { rateLimitType: "five_hour", utilization: 0.3, status: "allowed" }, { now: NOW });
  assert.equal(snap(s, NOW).vendors.claude.buckets.five_hour.utilization, 0.3);
});

test("record() with __proto__ or inherited-member names does not pollute", function () {
  var s = createUsageStore();
  s.record("claude", { rateLimitType: "__proto__", utilization: 0.9, status: "allowed" }, { now: NOW });
  s.record("__proto__", { rateLimitType: "five_hour", utilization: 0.9, status: "allowed" }, { now: NOW });
  s.record("toString", { rateLimitType: "constructor", utilization: 0.5, status: "allowed" }, { now: NOW });
  assert.equal(({}).utilization, undefined);
  assert.equal(({}).five_hour, undefined);
  assert.equal(typeof Object.prototype.toString.utilization, "undefined");
  var out = snap(s, NOW);
  assert.equal(out.vendors.claude.buckets.five_hour.state, "unknown");
  assert.equal(out.vendors.toString.buckets.constructor.utilization, 0.5);
});

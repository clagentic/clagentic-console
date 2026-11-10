// Usage store: every persisted field the writer produces must load back.
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { createUsageStore } = require("../lib/usage-store");

var NOW = Date.parse("2026-11-02T12:00:00Z");
var FUTURE = NOW / 1000 + 86400;

function tmpFile() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-types-"));
  return path.join(dir, "usage-store.json");
}
function notLoaded(logs) {
  return logs.filter(function (m) { return !/ loaded \d+ usage record/.test(m); });
}
function snap(s) {
  return s.snapshot({ now: NOW + 1000, staleSeconds: 1800, vendorIds: ["claude"] }).vendors.claude.buckets.five_hour;
}
function roundtrip(info, meta) {
  var file = tmpFile();
  var logs = [];
  var a = createUsageStore({ file: file, log: function (m) { logs.push(m); } });
  a.record("claude", Object.assign({ rateLimitType: "five_hour" }, info), Object.assign({ now: NOW }, meta));
  a.flush();
  var b = createUsageStore({ file: file, log: function (m) { logs.push(m); } });
  b.load();
  return { stored: JSON.parse(fs.readFileSync(file, "utf8")).vendors.claude.five_hour, view: snap(b), logs: logs, store: b };
}

test("numeric sessionLocalId survives record, flush, load and snapshot", function () {
  var r = roundtrip({ utilization: 0.4, resetsAt: FUTURE, status: "allowed" }, { source: "s", sessionLocalId: 12 });
  assert.equal(r.stored.sessionLocalId, "12");
  assert.equal(r.view.observedAt, new Date(NOW).toISOString());
  assert.equal(r.view.utilization, 0.4);
  assert.deepEqual(notLoaded(r.logs), []);
});

test("a file on disk with a numeric sessionLocalId loads and is not dropped", function () {
  var file = tmpFile();
  var iso = new Date(NOW).toISOString();
  fs.writeFileSync(file, JSON.stringify({ version: 1, vendors: { claude: { five_hour: {
    utilization: 0.3, utilizationObservedAt: iso, resetsAt: null, status: "allowed",
    observedAt: iso, confirmedAt: null, source: null, sessionLocalId: 5,
  } } } }));
  var logs = [];
  var s = createUsageStore({ file: file, log: function (m) { logs.push(m); } });
  s.load();
  assert.deepEqual(notLoaded(logs), []);
  assert.equal(snap(s).observedAt, iso);
  assert.equal(snap(s).utilization, 0.3);
});

test("a non-finite or non-number sessionLocalId on disk is still dropped", function () {
  [{}, true, [1]].forEach(function (bad) {
    var file = tmpFile();
    var iso = new Date(NOW).toISOString();
    fs.writeFileSync(file, JSON.stringify({ version: 1, vendors: { claude: { five_hour: {
      utilization: null, utilizationObservedAt: null, resetsAt: null, status: null,
      observedAt: iso, confirmedAt: null, source: null, sessionLocalId: bad,
    } } } }));
    var logs = [];
    var s = createUsageStore({ file: file, log: function (m) { logs.push(m); } });
    s.load();
    assert.equal(notLoaded(logs).length, 1);
    assert.match(notLoaded(logs)[0], /dropped 1 malformed/);
  });
});

test("numeric id keeps confirm() working across the coercion", function () {
  var s = createUsageStore({ log: function () {} });
  s.record("claude", { rateLimitType: "five_hour", utilization: 0.1 }, { now: NOW, sessionLocalId: 9, processKey: "p1" });
  assert.equal(s.confirm("claude", { sessionLocalId: 9, processKey: "p1" }, { now: NOW + 1 }), true);
});

test("wrongly typed fields are normalised on write so they reload", function () {
  var cases = [
    { info: { status: 42, utilization: 0.2 }, meta: {} },
    { info: { status: { a: 1 }, utilization: 0.2 }, meta: {} },
    { info: { utilization: NaN }, meta: {} },
    { info: { utilization: Infinity }, meta: {} },
    { info: { utilization: "0.5" }, meta: {} },
    { info: { resetsAt: "soon" }, meta: {} },
    { info: { resetsAt: NaN }, meta: {} },
    { info: { resetsAt: 1e20 }, meta: {} },
    { info: {}, meta: { source: 7 } },
    { info: {}, meta: { source: {} } },
    { info: {}, meta: { sessionLocalId: {} } },
    { info: {}, meta: { sessionLocalId: NaN } },
    { info: {}, meta: { sessionLocalId: true } },
  ];
  cases.forEach(function (c) {
    var r = roundtrip(c.info, c.meta);
    assert.deepEqual(notLoaded(r.logs), [], JSON.stringify(c));
    assert.equal(r.view.observedAt, new Date(NOW).toISOString(), JSON.stringify(c));
  });
});

test("wrongly typed values become null, valid ones are kept", function () {
  var r = roundtrip({ status: 42, utilization: NaN, resetsAt: "soon" }, { source: 7, sessionLocalId: {} });
  assert.equal(r.stored.status, null);
  assert.equal(r.stored.utilization, null);
  assert.equal(r.stored.resetsAt, null);
  assert.equal(r.stored.source, null);
  assert.equal(r.stored.sessionLocalId, null);
  var ok = roundtrip({ status: "allowed", utilization: 0.5, resetsAt: FUTURE }, { source: "cli", sessionLocalId: "abc" });
  assert.equal(ok.stored.status, "allowed");
  assert.equal(ok.stored.source, "cli");
  assert.equal(ok.stored.sessionLocalId, "abc");
  assert.equal(ok.stored.resetsAt, new Date(FUTURE * 1000).toISOString());
});

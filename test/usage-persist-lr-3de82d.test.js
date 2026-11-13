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

test("pre-reset fields survive persist and reload; a file without them loads unchanged", function () {
  var t = tmpFile();
  var a = createUsageStore({ file: t.file, log: function () {} });
  a.record("claude", { rateLimitType: "seven_day", utilization: 0.99, resetsAt: FUTURE, status: "allowed_warning" }, { now: NOW });
  a.record("claude", { rateLimitType: "seven_day", resetsAt: FUTURE, status: "allowed" }, { now: NOW + 1000 });
  a.flush();
  var b = createUsageStore({ file: t.file, log: function () {} });
  b.load();
  var x = snap(b, NOW + 2000).vendors.claude.buckets.seven_day;
  assert.equal(x.utilization, null);
  assert.equal(x.lastKnownUtilization, 0.99);
  assert.equal(x.lastKnownObservedAt, new Date(NOW).toISOString());
  assert.equal(x.lastKnownPreReset, true);

  var old = tmpFile();
  var iso = new Date(NOW).toISOString();
  fs.writeFileSync(old.file, JSON.stringify({ version: 1, vendors: { claude: { five_hour: {
    utilization: 0.4, utilizationObservedAt: iso, resetsAt: null, status: "allowed", observedAt: iso, source: null, sessionLocalId: null,
  } } } }));
  var c = createUsageStore({ file: old.file, log: function () {} });
  c.load();
  var y = snap(c, NOW + 1000).vendors.claude.buckets.five_hour;
  assert.equal(y.utilization, 0.4);
  assert.equal(y.lastKnownUtilization, null);
  assert.equal(y.lastKnownPreReset, false);
});

test("a record persisted in the host state reads as last known hours later, never a zero", function () {
  var t = tmpFile();
  fs.writeFileSync(t.file, JSON.stringify({ version: 1, vendors: { claude: { seven_day: {
    utilization: 0.99, utilizationObservedAt: "2026-11-12T11:56:06.000Z", resetsAt: "2026-11-17T00:00:00.000Z",
    status: "allowed", observedAt: "2026-11-12T13:59:00.000Z", confirmedAt: null, source: "s", sessionLocalId: null,
  } } } }));
  var s = createUsageStore({ file: t.file, log: function () {} });
  s.load();
  var x = snap(s, Date.parse("2026-11-12T14:00:00Z")).vendors.claude.buckets.seven_day;
  assert.equal(x.utilization, null);
  assert.equal(x.lastKnownUtilization, 0.99);
  assert.equal(x.lastKnownObservedAt, "2026-11-12T11:56:06.000Z");
  assert.equal(x.lastKnownStale, true);
  assert.equal(x.lastKnownAgeSeconds, 7434);
  assert.equal(x.lastKnownPreReset, false);
  assert.equal(x.utilizationObservedAt, "2026-11-12T11:56:06.000Z");
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
  assert.equal(logs.length, 2);
  assert.match(logs[0], /dropped 1 malformed usage record\(s\)/);
  assert.match(logs[1], /loaded 1 usage record\(s\) from .*, newest observedAt 2026-11-02T12:00:00\.000Z$/);
});

test("load logs one line with the record count and newest observedAt", function () {
  var t = tmpFile();
  var mk = function (iso) { return { utilization: 0.1, utilizationObservedAt: iso, resetsAt: null, status: "allowed", observedAt: iso, source: null, sessionLocalId: null }; };
  fs.writeFileSync(t.file, JSON.stringify({ version: 1, vendors: {
    claude: { five_hour: mk("2026-11-02T10:00:00.000Z"), seven_day: mk("2026-11-02T11:30:00.000Z") },
    codex: { five_hour: mk("2026-11-02T09:00:00.000Z") },
  } }));
  var logs = [];
  createUsageStore({ file: t.file, log: function (m) { logs.push(m); } }).load();
  assert.equal(logs.length, 1);
  assert.equal(logs[0], "[usage-store] Clagentic: Console loaded 3 usage record(s) from " + t.file + ", newest observedAt 2026-11-02T11:30:00.000Z");
});

test("a valid file with zero records logs loaded 0 and newest observedAt none", function () {
  var t = tmpFile();
  fs.writeFileSync(t.file, JSON.stringify({ version: 1, vendors: {} }));
  var logs = [];
  createUsageStore({ file: t.file, log: function (m) { logs.push(m); } }).load();
  assert.deepEqual(logs, ["[usage-store] Clagentic: Console loaded 0 usage record(s) from " + t.file + ", newest observedAt none"]);
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
  assert.equal(logs.length, 2);
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

function failingFs(failures) {
  var state = { failures: failures };
  var wrapped = Object.assign({}, fs, {
    writeFileSync: function (p, d, o) {
      if (state.failures > 0) { state.failures--; var e = new Error("ENOSPC: no space left"); e.code = "ENOSPC"; throw e; }
      return fs.writeFileSync(p, d, o);
    },
  });
  return wrapped;
}
function onDisk(file) { return JSON.parse(fs.readFileSync(file, "utf8")).vendors.claude.five_hour; }
var REC = function (u) { return { rateLimitType: "five_hour", utilization: u, resetsAt: FUTURE, status: "allowed" }; };

// The store's throttle and retry run on the global setTimeout. Mock it so the
// test advances time explicitly; t.mock restores real timers when the test ends.
test("a write that fails once is retried and persists the latest record", function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  var f = tmpFile();
  var logs = [];
  var s = createUsageStore({ file: f.file, fs: failingFs(1), throttleMs: 20, log: function (m) { logs.push(m); } });
  s.record("claude", REC(0.3), { now: NOW });
  t.mock.timers.tick(20);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(logs.length, 1);
  s.record("claude", REC(0.6), { now: NOW });
  t.mock.timers.tick(20);
  assert.equal(onDisk(f.file).utilization, 0.6);
  assert.equal(logs.length, 1);
  assert.equal(fs.existsSync(f.file + ".tmp"), false);
});

test("a failed write retries on its own without a new record", function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  var f = tmpFile();
  var s = createUsageStore({ file: f.file, fs: failingFs(1), throttleMs: 20, log: function () {} });
  s.record("claude", REC(0.5), { now: NOW });
  t.mock.timers.tick(20);
  assert.equal(fs.existsSync(f.file), false);
  t.mock.timers.tick(20);
  assert.equal(onDisk(f.file).utilization, 0.5);
});

test("flush after a failed write still writes", function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  var f = tmpFile();
  var s = createUsageStore({ file: f.file, fs: failingFs(1), throttleMs: 20, log: function () {} });
  s.record("claude", REC(0.7), { now: NOW });
  t.mock.timers.tick(20);
  assert.equal(fs.existsSync(f.file), false);
  s.flush();
  assert.equal(onDisk(f.file).utilization, 0.7);
});

test("a failed rename leaves no tmp file behind and keeps the change pending", function () {
  var t = tmpFile();
  var renameFails = true;
  var wrapped = Object.assign({}, fs, {
    renameSync: function (a, b) {
      if (renameFails) { renameFails = false; throw new Error("EACCES: denied"); }
      return fs.renameSync(a, b);
    },
  });
  var s = createUsageStore({ file: t.file, fs: wrapped, throttleMs: 20, log: function () {} });
  s.record("claude", REC(0.2), { now: NOW });
  s.flush();
  assert.equal(fs.existsSync(t.file + ".tmp"), false);
  s.flush();
  assert.equal(onDisk(t.file).utilization, 0.2);
});

test("daemon shutdown flush logs one line on failure and does not throw", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "lib", "daemon.js"), "utf8");
  var i = src.indexOf('require("./usage-store").flush()');
  assert.ok(i > 0);
  var block = src.slice(i - 20, i + 260);
  assert.match(block, /catch \(e\) \{\s*console\.error\(/);
  assert.doesNotMatch(block, /catch \(e\) \{\}/);
});

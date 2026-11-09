// Usage freshness: confirmation by session result, freshness reasons, and the
// processor and bridge wiring that feeds the store.
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { createUsageStore } = require("../lib/usage-store");

var NOW = Date.parse("2026-11-02T12:00:00Z");
var FUTURE = NOW / 1000 + 86400;
var STALE = 1800;
var MIN = 60000;

function snap(s, now) {
  return s.snapshot({ now: now, staleSeconds: STALE, vendorIds: ["claude", "codex"] });
}
function quiet() { return createUsageStore({ log: function () {} }); }
function ev(s, extra, now, meta) {
  s.record("claude", Object.assign({ rateLimitType: "five_hour", utilization: 0.4, resetsAt: FUTURE, status: "allowed" }, extra), Object.assign({ now: now, sessionLocalId: "s1", processKey: "p1" }, meta));
}
var WHO = { sessionLocalId: "s1", processKey: "p1" };

test("steady value with confirming results stays fresh past staleAfterSeconds", function () {
  var s = quiet();
  ev(s, {}, NOW);
  assert.equal(s.confirm("claude", WHO, { now: NOW + 40 * MIN }), true);
  var b = snap(s, NOW + 41 * MIN).vendors.claude.buckets.five_hour;
  assert.equal(b.state, "fresh");
  assert.equal(b.ageSeconds, 60);
  assert.equal(b.observedAt, new Date(NOW).toISOString());
  assert.equal(b.confirmedAt, new Date(NOW + 40 * MIN).toISOString());
  assert.equal(b.staleReason, undefined);
});

test("without confirmation the same bucket is stale with a plain-words reason", function () {
  var s = quiet();
  ev(s, {}, NOW);
  var b = snap(s, NOW + 41 * MIN).vendors.claude.buckets.five_hour;
  assert.equal(b.state, "stale");
  assert.match(b.staleReason, /no rate-limit change reported and no confirming session result since 2026-11-02T12:00:00.000Z/);
});

test("a result from a session that has not emitted does not confirm", function () {
  var s = quiet();
  ev(s, {}, NOW);
  assert.equal(s.confirm("claude", { sessionLocalId: "other", processKey: "p9" }, { now: NOW + MIN }), false);
  assert.equal(snap(s, NOW + MIN).vendors.claude.buckets.five_hour.confirmedAt, null);
});

test("confirmation applies only to the emitting process's last bucket", function () {
  var s = quiet();
  ev(s, { rateLimitType: "seven_day" }, NOW - MIN, { sessionLocalId: "s2", processKey: "q" });
  ev(s, { rateLimitType: "five_hour" }, NOW);
  s.confirm("claude", WHO, { now: NOW + MIN });
  var b = snap(s, NOW + MIN).vendors.claude.buckets;
  assert.equal(b.five_hour.confirmedAt, new Date(NOW + MIN).toISOString());
  assert.equal(b.seven_day.confirmedAt, null);
});

test("a session that switches bucket confirms the newly reported one", function () {
  var s = quiet();
  ev(s, { rateLimitType: "five_hour" }, NOW);
  ev(s, { rateLimitType: "seven_day" }, NOW + MIN);
  s.confirm("claude", WHO, { now: NOW + 2 * MIN });
  var b = snap(s, NOW + 2 * MIN).vendors.claude.buckets;
  assert.equal(b.five_hour.confirmedAt, null);
  assert.ok(b.seven_day.confirmedAt);
});

test("process restart clears the session's emitted flag", function () {
  var s = quiet();
  ev(s, {}, NOW);
  s.endProcess("claude", "s1", "p1");
  assert.equal(s.confirm("claude", WHO, { now: NOW + MIN }), false);
  assert.equal(snap(s, NOW).vendors.claude.freshness.activeSessions, 0);
});

test("a new process of the same session does not confirm until it emits; the old exit does not clear it", function () {
  var s = quiet();
  ev(s, {}, NOW);
  assert.equal(s.confirm("claude", { sessionLocalId: "s1", processKey: "p2" }, { now: NOW + MIN }), false);
  ev(s, {}, NOW + 2 * MIN, { processKey: "p2" });
  s.endProcess("claude", "s1", "p1");
  assert.equal(s.confirm("claude", { sessionLocalId: "s1", processKey: "p2" }, { now: NOW + 3 * MIN }), true);
});

test("a new event resets confirmedAt", function () {
  var s = quiet();
  ev(s, {}, NOW);
  s.confirm("claude", WHO, { now: NOW + MIN });
  ev(s, { utilization: 0.5 }, NOW + 2 * MIN);
  assert.equal(snap(s, NOW + 2 * MIN).vendors.claude.buckets.five_hour.confirmedAt, null);
});

test("freshness reason: event", function () {
  var s = quiet();
  ev(s, {}, NOW);
  var f = snap(s, NOW + MIN).vendors.claude.freshness;
  assert.equal(f.reason, "event");
  assert.equal(f.activeSessions, 1);
  assert.equal(f.lastEventAt, new Date(NOW).toISOString());
  assert.equal(f.lastConfirmedAt, null);
});

test("freshness reason: confirmed_by_result", function () {
  var s = quiet();
  ev(s, {}, NOW);
  s.confirm("claude", WHO, { now: NOW + MIN });
  var f = snap(s, NOW + 2 * MIN).vendors.claude.freshness;
  assert.equal(f.reason, "confirmed_by_result");
  assert.equal(f.lastConfirmedAt, new Date(NOW + MIN).toISOString());
});

test("freshness reason: no_active_session when stale and nothing can confirm", function () {
  var s = quiet();
  ev(s, {}, NOW);
  s.endProcess("claude", "s1", "p1");
  var f = snap(s, NOW + 41 * MIN).vendors.claude.freshness;
  assert.equal(f.reason, "no_active_session");
  assert.equal(f.activeSessions, 0);
});

test("freshness reason: no_event_since_start, including after a persisted load", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-confirm-"));
  var file = path.join(dir, "usage-store.json");
  var a = createUsageStore({ file: file, log: function () {} });
  ev(a, {}, NOW);
  a.flush();
  var b = createUsageStore({ file: file, log: function () {} });
  b.load();
  var v = snap(b, NOW + 41 * MIN).vendors;
  assert.equal(v.claude.freshness.reason, "no_event_since_start");
  assert.equal(v.codex.freshness.reason, "no_event_since_start");
  assert.equal(v.codex.freshness.lastEventAt, null);
});

test("utilizationConfirmed: true only when the latest event carried the value and it was confirmed", function () {
  var s = quiet();
  ev(s, {}, NOW);
  assert.equal(snap(s, NOW).vendors.claude.buckets.five_hour.utilizationConfirmed, false);
  s.confirm("claude", WHO, { now: NOW + MIN });
  var b = snap(s, NOW + MIN).vendors.claude.buckets.five_hour;
  assert.equal(b.utilizationConfirmed, true);
  assert.equal(b.utilizationObservedAt, new Date(NOW).toISOString());

  var t = quiet();
  ev(t, { utilization: undefined }, NOW);
  t.confirm("claude", WHO, { now: NOW + MIN });
  assert.equal(snap(t, NOW + MIN).vendors.claude.buckets.five_hour.utilizationConfirmed, false);
});

test("persisted file keeps confirmedAt; a file without it loads null; a malformed one is dropped", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-confirm-"));
  var file = path.join(dir, "usage-store.json");
  var a = createUsageStore({ file: file, log: function () {} });
  ev(a, {}, NOW);
  a.confirm("claude", WHO, { now: NOW + MIN });
  a.flush();
  var raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.vendors.claude.five_hour.confirmedAt, new Date(NOW + MIN).toISOString());

  var b = createUsageStore({ file: file, log: function () {} });
  b.load();
  assert.equal(snap(b, NOW + 2 * MIN).vendors.claude.buckets.five_hour.confirmedAt, new Date(NOW + MIN).toISOString());

  delete raw.vendors.claude.five_hour.confirmedAt;
  fs.writeFileSync(file, JSON.stringify(raw));
  var c = createUsageStore({ file: file, log: function () {} });
  c.load();
  assert.equal(snap(c, NOW + 2 * MIN).vendors.claude.buckets.five_hour.confirmedAt, null);

  raw.vendors.claude.five_hour.confirmedAt = "not a date";
  fs.writeFileSync(file, JSON.stringify(raw));
  var logs = [];
  var d = createUsageStore({ file: file, log: function (m) { logs.push(m); } });
  d.load();
  assert.equal(snap(d, NOW).vendors.claude.buckets.five_hour.state, "unknown");
  assert.equal(logs.length, 2);
  assert.match(logs[0], /dropped 1 malformed/);
});

test("confirm updates are throttled into one write", function () {
  var writes = 0;
  var fake = { mkdirSync: function () {}, writeFileSync: function () { writes++; }, renameSync: function () {} };
  var s = createUsageStore({ file: "/x/usage-store.json", fs: fake, throttleMs: 10000, log: function () {} });
  ev(s, {}, NOW);
  s.flush();
  assert.equal(writes, 1);
  for (var i = 0; i < 20; i++) s.confirm("claude", WHO, { now: NOW + i * 1000 });
  assert.equal(writes, 1, "no write per confirm");
  s.flush();
  assert.equal(writes, 2);
});

test("a failed write after a confirm keeps it dirty and retries the confirmedAt", async function () {
  var fail = false;
  var writes = [];
  var fake = {
    mkdirSync: function () {},
    writeFileSync: function (f, data) {
      if (fail) throw new Error("disk full");
      writes.push(JSON.parse(data));
    },
    renameSync: function () {},
  };
  var s = createUsageStore({ file: "/x/u.json", fs: fake, throttleMs: 5, log: function () {} });
  ev(s, {}, NOW);
  s.flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].vendors.claude.five_hour.confirmedAt, null);
  fail = true;
  assert.equal(s.confirm("claude", WHO, { now: NOW + MIN }), true);
  s.flush();
  assert.equal(writes.length, 1, "the failing write persisted nothing");
  fail = false;
  await new Promise(function (r) { setTimeout(r, 60); });
  assert.equal(writes.length, 2, "the retry wrote after the failure cleared");
  assert.equal(writes[1].vendors.claude.five_hour.confirmedAt, new Date(NOW + MIN).toISOString());
});

test("__proto__ and inherited names are refused by confirm and endProcess", function () {
  var s = quiet();
  ev(s, {}, NOW);
  assert.equal(s.confirm("__proto__", WHO), false);
  assert.equal(s.confirm("claude", { sessionLocalId: "__proto__", processKey: "p1" }), false);
  s.endProcess("constructor", "toString", "x");
  assert.equal(s.confirm("constructor", WHO), false);
});

test("an event with no rateLimitType logs one line and is dropped", function () {
  var logs = [];
  var s = createUsageStore({ log: function (m) { logs.push(m); } });
  s.record("claude", { status: "allowed", utilization: 0.3 }, { now: NOW });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Clagentic: Console dropped a rate-limit event with no rateLimitType \(vendor=claude status=allowed\)/);
  assert.equal(snap(s, NOW).vendors.claude.buckets.five_hour.state, "unknown");
});

// --- processor wiring ---

function makeProcessor(vendor) {
  var { attachMessageProcessor } = require("../lib/sdk-message-processor.js");
  var sm = {
    skillMeta: [], workflowMeta: [], skillNames: [], slashCommands: null,
    currentModel: null, _savedDefaultModel: null,
    sendAndRecord: function () {}, sendToSession: function () {},
    saveSessionFile: function () {}, broadcastSessionList: function () {},
    modelsByVendor: {}, availableModels: [], availableVendors: [], installedVendors: [],
  };
  return attachMessageProcessor({
    sm: sm, send: function () {}, slug: "t", cwd: "/tmp", pushModule: null,
    getNotificationsModule: function () { return null; },
    adapter: { vendor: vendor }, onProcessingChanged: function () {}, onTurnDone: null, onAutoTitle: null, opts: {},
    discoverSkillDirs: function () { return []; }, mergeSkills: function () { return []; },
    discoverWorkflows: function () { return []; }, discoverSkillsWithMeta: function () { return []; },
    mergeSkillsWithMeta: function () { return []; }, getSDK: null,
  });
}
function makeSession(vendor, id, qi) {
  return {
    localId: id, cliSessionId: null, vendor: vendor, history: [], messageUUIDs: [], blocks: {},
    sentToolResults: {}, pendingPermissions: {}, pendingElicitations: {}, pendingAskUser: {},
    activeTaskToolIds: {}, taskIdMap: {}, streamedText: false, responsePreview: "", isProcessing: false,
    loop: null, queryInstance: qi,
  };
}

test("processor: rate_limit logs type and utilization; result confirms only an emitting process", function () {
  var shared = require("../lib/usage-store");
  shared.reset();
  var lines = [];
  var orig = console.log;
  console.log = function (m) { lines.push(String(m)); };
  try {
    var proc = makeProcessor("claude");
    var qi = {};
    var emitting = makeSession("claude", "a1", qi);
    var silent = makeSession("claude", "b1", {});
    proc.processSDKMessage(emitting, { yokeType: "rate_limit", rateLimitSource: "claude-cli:rate_limit_event", rateLimitInfo: { status: "allowed", rateLimitType: "seven_day", utilization: 0.31, resetsAt: FUTURE } });
    proc.processSDKMessage(silent, { yokeType: "result", subtype: "success", cost: 0.01 });
    var before = shared.snapshot({ vendorIds: ["claude"] }).vendors.claude.buckets.seven_day;
    assert.equal(before.confirmedAt, null);
    proc.processSDKMessage(emitting, { yokeType: "result", subtype: "success", cost: 0.01 });
    var after = shared.snapshot({ vendorIds: ["claude"] }).vendors.claude.buckets.seven_day;
    assert.ok(after.confirmedAt);
    // a replaced process (new queryInstance) confirms nothing
    var restarted = makeSession("claude", "a1", {});
    var c0 = after.confirmedAt;
    proc.processSDKMessage(restarted, { yokeType: "result", subtype: "success", cost: 0.01 });
    assert.equal(shared.snapshot({ vendorIds: ["claude"] }).vendors.claude.buckets.seven_day.confirmedAt, c0);
  } finally {
    console.log = orig;
    shared.reset();
  }
  var l = lines.filter(function (x) { return x.indexOf("[sdk-bridge] rate_limit_event") === 0; });
  assert.equal(l.length, 1);
  assert.match(l[0], /rateLimitType=seven_day utilization=0\.31 /);
});

test("processor: error and interrupted results confirm nothing; a success from the same process does", function () {
  var shared = require("../lib/usage-store");
  shared.reset();
  var orig = console.log;
  var origErr = console.error;
  console.log = function () {};
  console.error = function () {};
  try {
    var proc = makeProcessor("claude");
    var s = makeSession("claude", "e1", {});
    var bucket = function () { return shared.snapshot({ vendorIds: ["claude"] }).vendors.claude.buckets.five_hour; };
    proc.processSDKMessage(s, { yokeType: "rate_limit", rateLimitInfo: { status: "allowed", rateLimitType: "five_hour", utilization: 0.2, resetsAt: FUTURE } });
    ["error_during_execution", "error_max_turns", "interrupted", undefined].forEach(function (sub) {
      proc.processSDKMessage(s, { yokeType: "result", subtype: sub, cost: 0.01, errors: ["x"] });
      assert.equal(bucket().confirmedAt, null, "subtype " + sub + " must not confirm");
    });
    proc.processSDKMessage(s, { yokeType: "result", subtype: "success", cost: 0.01 });
    assert.ok(bucket().confirmedAt);
  } finally {
    console.log = orig;
    console.error = origErr;
    shared.reset();
  }
});

test("processor: a non-Claude vendor is neither tracked nor confirmed by result", function () {
  var shared = require("../lib/usage-store");
  shared.reset();
  var orig = console.log;
  console.log = function () {};
  try {
    var proc = makeProcessor("codex");
    var qi = {};
    var s = makeSession("codex", "c1", qi);
    proc.processSDKMessage(s, { yokeType: "rate_limit", rateLimitInfo: { status: "allowed", rateLimitType: "five_hour", utilization: 0.2, resetsAt: FUTURE } });
    proc.processSDKMessage(s, { yokeType: "result", subtype: "success", cost: 0.01 });
    var v = shared.snapshot({ vendorIds: ["codex"] }).vendors.codex;
    assert.equal(v.buckets.five_hour.confirmedAt, null);
    assert.equal(v.freshness.activeSessions, 0);
  } finally {
    console.log = orig;
    shared.reset();
  }
});

test("sdk-bridge: when the query stream ends, the process can no longer confirm", async function () {
  var shared = require("../lib/usage-store");
  shared.reset();
  var modPath = require.resolve("../lib/sdk-bridge");
  delete require.cache[modPath];
  var { createSDKBridge } = require("../lib/sdk-bridge");
  var sm = {
    sessions: new Map(), currentModel: null, currentPermissionMode: null, currentEffort: null,
    currentBetas: [], modelsByVendor: {}, availableVendors: [], installedVendors: [], defaultVendor: "claude",
    saveSessionFile: function () {}, broadcastSessionList: function () {},
    getActiveSession: function () { return null; }, setSlashCommandsForVendor: function () {},
    sendAndRecord: function () {}, sendToSession: function () {},
  };
  var bridge = createSDKBridge({
    cwd: "/tmp", slug: "t", sessionManager: sm, send: function () {},
    adapter: { vendor: "claude" }, adapters: {}, onProcessingChanged: function () {},
  });
  var event = { yokeType: "rate_limit", rateLimitInfo: { status: "allowed", rateLimitType: "five_hour", utilization: 0.2, resetsAt: FUTURE } };
  var queryInstance = {};
  queryInstance[Symbol.asyncIterator] = function () {
    var sent = false;
    return { next: function () {
      if (sent) return Promise.resolve({ done: true, value: undefined });
      sent = true;
      return Promise.resolve({ done: false, value: event });
    } };
  };
  var session = {
    localId: "q1", vendor: "claude", queryInstance: queryInstance, messageQueue: null, abortController: null,
    isProcessing: false, cliSessionId: null, history: [], blocks: {}, sentToolResults: {},
    pendingPermissions: {}, pendingAskUser: {}, pendingElicitations: {}, activeTaskToolIds: {},
    taskIdMap: {}, singleTurn: false, destroying: false, lastActivityAt: Date.now(),
  };
  var orig = console.log;
  console.log = function () {};
  try {
    await bridge.processQueryStream(session);
    assert.equal(shared.snapshot({ vendorIds: ["claude"] }).vendors.claude.buckets.five_hour.state !== "unknown", true, "the event was recorded");
    assert.equal(shared.confirm("claude", { sessionLocalId: "q1", processKey: queryInstance }), false);
  } finally {
    console.log = orig;
    shared.reset();
  }
});

test("usageVendorFor: session vendor, then adapter vendor, then claude", function () {
  var { usageVendorFor } = require("../lib/usage-store");
  assert.equal(usageVendorFor({ vendor: "codex" }, { vendor: "claude" }), "codex");
  assert.equal(usageVendorFor({}, { vendor: "codex" }), "codex");
  assert.equal(usageVendorFor({}, null), "claude");
  assert.equal(usageVendorFor({ vendor: "" }, undefined), "claude");
});

"use strict";
// A reaped session that gets a runtime again (send-input, the browser, a loop or
// scheduled turn all start it through sdk-bridge startQuery) must not leave two
// non-reaped sessions with one name: it comes back unnamed, the stored meta is
// cleared, the delivery is not refused, and the current holder keeps the name.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { createSDKBridge } = require("../lib/sdk-bridge");

function rig(tmpHome) {
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) {
    delete require.cache[require.resolve(m)];
  });
  var orig = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var sm;
  try {
    sm = require("../lib/sessions").createSessionManager({
      cwd: tmpHome, send: function () {}, sendTo: function () {}, sendEach: function () {},
    });
  } finally {
    if (orig === undefined) delete process.env.CLAGENTIC_HOME; else process.env.CLAGENTIC_HOME = orig;
  }
  var bridge = createSDKBridge({
    cwd: tmpHome, slug: "p", sessionManager: sm, send: function () {},
    adapter: { vendor: "claude" }, adapters: {},
  });
  return { sm: sm, bridge: bridge };
}

// A stored, named, reaped session. Its vendor is unregistered so startQuery
// stops at its first refusal after the name rule, without starting a runtime.
function reapedNamed(sm, cliSessionId, name) {
  var s = sm.createSessionRaw({});
  s.cliSessionId = cliSessionId;
  s.sessionName = name;
  s.vendor = "no-such-vendor";
  sm.sendAndRecord(s, { type: "user_message", text: "hello" });
  sm.saveSessionFile(s);
  return s;
}

function metaOf(sm, cliSessionId) {
  return JSON.parse(fs.readFileSync(path.join(sm.sessionsDir, cliSessionId + ".jsonl"), "utf8").split("\n")[0]);
}

test("reaped lane-a, a new lane-a opened, then the old one is started: it is unnamed, the new one keeps lane-a", async function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-namerevive-"));
  try {
    var r = rig(tmpHome);
    var old = reapedNamed(r.sm, "sess-old", "lane-a");
    var fresh = r.sm.createSessionRaw({});
    fresh.cliSessionId = "sess-new";
    fresh.sessionName = "lane-a";
    fresh.isProcessing = true;
    assert.equal(metaOf(r.sm, "sess-old").sessionName, "lane-a");

    await r.bridge.startQuery(old, "hello again", null, undefined);

    assert.ok(!old.sessionName, "the revived session is unnamed");
    assert.ok(!metaOf(r.sm, "sess-old").sessionName, "and its stored meta no longer carries the name");
    assert.equal(fresh.sessionName, "lane-a", "the current holder keeps the name");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("a revived session keeps its name when nobody else holds it, or only a reaped session does", async function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-namerevive-"));
  try {
    var r = rig(tmpHome);
    var a = reapedNamed(r.sm, "sess-a", "lane-a");
    var other = r.sm.createSessionRaw({});
    other.cliSessionId = "sess-other";
    other.sessionName = "lane-a";
    await r.bridge.startQuery(a, "x", null, undefined);
    assert.equal(a.sessionName, "lane-a");
    assert.equal(metaOf(r.sm, "sess-a").sessionName, "lane-a");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

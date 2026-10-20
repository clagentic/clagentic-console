"use strict";
// --reply finds the newest injected message even when it lies further back than
// the in-memory history window, without loading that history into the heap.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { createSessionInput } = require("../lib/session-input");
var { senderFields } = require("../lib/injected-sender");

function freshSessionsModule(tmpHome) {
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) {
    delete require.cache[require.resolve(m)];
  });
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  try {
    return require("../lib/sessions");
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
}

test("reply: an injected message older than the in-memory window still answers", function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-replywin-"));
  try {
    var sm = freshSessionsModule(tmpHome).createSessionManager({
      cwd: tmpHome,
      historyInMemMax: 20,
      send: function () {},
      sendTo: function () {},
      sendEach: function () {},
    });
    var caller = sm.createSessionRaw({});
    caller.cliSessionId = "sess-caller";
    caller.queryInstance = {};
    caller.vendor = "claude";
    sm.saveSessionFile(caller);
    sm.sendAndRecord(caller, Object.assign({ type: "user_message", text: "ping", source: "external-trigger", initiator: "trigger" },
      senderFields("trigger", undefined, { name: "naomi@lane", project: "lane", sessionId: "3", cliSessionId: "cli-3", agent: "naomi", agentSlug: "naomi", vendor: "claude" })));
    for (var i = 0; i < sm.HISTORY_INMEM_MAX * 3; i++) sm.sendAndRecord(caller, { type: "assistant_message", text: "filler " + i });
    assert.ok(!caller.history.some(function (e) { return e.source === "external-trigger"; }), "the injected entry is outside the window");

    var pushed = [];
    var peer = { localId: 3, cliSessionId: "cli-3", agentName: "naomi", vendor: "claude", title: "t", lastActivity: 1, isProcessing: false, queryInstance: {}, history: [] };
    var peerSm = { sessions: new Map([[3, peer]]), defaultVendor: "claude", recordHistoryEntry: function () {}, appendToSessionFile: function () {} };
    var projects = {
      lore: { cwd: "/unused", sm: sm, sdk: {}, onProcessingChanged: function () {}, getLinuxUserForSession: function () { return null; } },
      lane: { cwd: "/unused", sm: peerSm, sdk: { pushMessage: function (s) { pushed.push(s.localId); } }, onProcessingChanged: function () {}, getLinuxUserForSession: function () { return null; } },
    };
    var input = createSessionInput({
      getProject: function (slug) { return projects[slug] || null; },
      listProjects: function () { return Object.keys(projects).map(function (slug) { return { slug: slug, project: projects[slug] }; }); },
      agentCatalog: function () { return []; },
    });
    var heapBefore = caller.history.length;
    var r = input.sendInput({ reply: true, prompt: "done", senderProject: "lore", senderSessionId: String(caller.localId) });
    assert.equal(r.result, "delivered");
    assert.equal(r.project, "lane");
    assert.deepEqual(pushed, [3]);
    assert.equal(caller.history.length, heapBefore, "the heap history did not grow");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("reply: a session manager with no stored-history reader is a logged refusal, not 'no injected message'", function () {
  var errors = [];
  var origError = console.error;
  console.error = function (m) { errors.push(String(m)); };
  try {
    var caller = { localId: 1, cliSessionId: "c", queryInstance: {}, vendor: "claude", history: [] };
    var sm = { sessions: new Map([[1, caller]]), defaultVendor: "claude" };
    var projects = { lore: { cwd: "/unused", sm: sm, sdk: {}, onProcessingChanged: function () {}, getLinuxUserForSession: function () { return null; } } };
    var input = createSessionInput({
      getProject: function (slug) { return projects[slug] || null; },
      listProjects: function () { return [{ slug: "lore", project: projects.lore }]; },
      agentCatalog: function () { return []; },
    });
    var r = input.sendInput({ reply: true, prompt: "done", senderProject: "lore", senderSessionId: "1" });
    assert.equal(r.ok, false);
    assert.ok(/cannot be searched/.test(r.reason), r.reason);
    assert.ok(errors.some(function (e) { return /no stored-history reader/.test(e); }));
  } finally {
    console.error = origError;
  }
});

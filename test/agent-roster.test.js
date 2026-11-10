"use strict";

// The agent roster (lib/agent-roster.js): what is recorded, that it survives a
// restart, how an avatar choice is validated and kept, and that the places that
// see an agent (a session's agent, a sub-agent call, an injected sender) report
// it. Neutral fixtures: no real agent, crew or deployment names.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { pathToFileURL } = require("url");

var roster = require("../lib/agent-roster");
var rosterWs = require("../lib/agent-roster-ws");
var { createSessionInput } = require("../lib/session-input");
var { attachMessageProcessor } = require("../lib/sdk-message-processor");

var tmpDirs = [];
function tmpFile() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-roster-"));
  tmpDirs.push(dir);
  return path.join(dir, "agent-roster.json");
}
test.after(function () {
  tmpDirs.forEach(function (d) { fs.rmSync(d, { recursive: true, force: true }); });
});

function fileWriter(file, value) {
  return fs.promises.writeFile(file, JSON.stringify(value));
}

function makeRoster(file, over) {
  var clockNow = 1000;
  var changes = { n: 0 };
  var r = roster.createAgentRoster(Object.assign({
    file: file,
    writeJson: fileWriter,
    clock: function () { return clockNow; },
    onChange: function () { changes.n++; },
  }, over || {}));
  return { roster: r, changes: changes, setNow: function (t) { clockNow = t; } };
}

test("a session agent, a sub-agent and an injected sender are each recorded with first seen, last seen and where", function () {
  var m = makeRoster(tmpFile());
  m.setNow(1000);
  assert.equal(m.roster.observe({ key: "agent-a", source: "session", project: "proj-1", sessionId: "3" }), true);
  m.setNow(2000);
  assert.equal(m.roster.observe({ key: "helper-x", source: "subagent", project: "proj-1", sessionId: "3" }), true);
  m.setNow(3000);
  assert.equal(m.roster.observe({ key: "sender-z", source: "sender", project: "proj-2", sessionId: "9" }), true);

  var list = m.roster.list();
  assert.deepEqual(list.map(function (a) { return a.key; }), ["sender-z", "helper-x", "agent-a"], "most recently seen first");
  var helper = list.filter(function (a) { return a.key === "helper-x"; })[0];
  assert.equal(helper.firstSeen, 2000);
  assert.equal(helper.lastSeen, 2000);
  assert.deepEqual(helper.places, [{ source: "subagent", project: "proj-1", session: "3", lastSeen: 2000 }]);
  assert.equal(helper.avatar, null);
  assert.equal(m.changes.n, 3);
});

test("a repeated sighting moves last seen and keeps first seen; the same place is not listed twice", function () {
  var m = makeRoster(tmpFile());
  m.setNow(1000);
  m.roster.observe({ key: "agent-a", source: "session", project: "proj-1", sessionId: "3" });
  m.setNow(5000);
  m.roster.observe({ key: "agent-a", source: "session", project: "proj-1", sessionId: "3" });
  m.roster.observe({ key: "agent-a", source: "sender", project: "proj-1", sessionId: "3" });

  var a = m.roster.list()[0];
  assert.equal(a.firstSeen, 1000);
  assert.equal(a.lastSeen, 5000);
  assert.equal(a.places.length, 2, "a new source is a new place");
  assert.equal(a.places.filter(function (p) { return p.source === "session"; })[0].lastSeen, 5000);
});

test("keys are kept exactly as recorded: no trimming, no case folding, no merging", function () {
  var m = makeRoster(tmpFile());
  m.roster.observe({ key: "Agent-A", source: "session" });
  m.roster.observe({ key: "agent-a", source: "session" });
  m.roster.observe({ key: "agent-a ", source: "session" });
  var keys = m.roster.list().map(function (a) { return a.key; }).sort();
  assert.deepEqual(keys, ["Agent-A", "agent-a", "agent-a "]);
});

test("a sighting with no usable key or an unknown source is reported false and records nothing", function () {
  var m = makeRoster(tmpFile());
  [null, {}, { key: "", source: "session" }, { key: "   ", source: "session" }, { key: 5, source: "session" },
    { key: "a\nb", source: "session" }, { key: "x".repeat(roster.MAX_KEY_LENGTH + 1), source: "session" },
    { key: "agent-a", source: "elsewhere" }].forEach(function (s) {
    assert.equal(m.roster.observe(s), false);
  });
  assert.equal(m.roster.list().length, 0);
  assert.equal(m.changes.n, 0);
});

test("a key that is an object property name is an ordinary key", function () {
  var m = makeRoster(tmpFile());
  assert.equal(m.roster.observe({ key: "__proto__", source: "session" }), true);
  assert.equal(m.roster.observe({ key: "constructor", source: "session" }), true);
  assert.deepEqual(m.roster.list().map(function (a) { return a.key; }).sort(), ["__proto__", "constructor"]);
});

test("the roster is capped; further identities are reported false, known ones still update", function () {
  var m = makeRoster(tmpFile());
  var warn = console.warn;
  console.warn = function () {};
  try {
    for (var i = 0; i < roster.MAX_AGENTS; i++) assert.equal(m.roster.observe({ key: "agent-" + i, source: "session" }), true);
    assert.equal(m.roster.observe({ key: "one-too-many", source: "session" }), false);
    m.setNow(9000);
    assert.equal(m.roster.observe({ key: "agent-0", source: "session" }), true);
  } finally {
    console.warn = warn;
  }
  assert.equal(m.roster.list().length, roster.MAX_AGENTS);
});

test("the places kept per agent are bounded, keeping the most recent", function () {
  var m = makeRoster(tmpFile());
  for (var i = 0; i < roster.MAX_PLACES + 5; i++) {
    m.setNow(1000 + i);
    m.roster.observe({ key: "agent-a", source: "session", project: "proj-1", sessionId: String(i) });
  }
  var a = m.roster.list()[0];
  assert.equal(a.places.length, roster.MAX_PLACES);
  assert.ok(a.places.some(function (p) { return p.session === String(roster.MAX_PLACES + 4); }), "the newest place is kept");
  assert.ok(!a.places.some(function (p) { return p.session === "0"; }), "the oldest place is dropped");
});

test("the roster and each avatar choice are restored unchanged after a restart", async function () {
  var file = tmpFile();
  var first = makeRoster(file);
  first.setNow(1000);
  first.roster.observe({ key: "agent-a", source: "session", project: "proj-1", sessionId: "3" });
  first.setNow(2000);
  first.roster.observe({ key: "helper-x", source: "subagent", project: "proj-1", sessionId: "3" });
  assert.equal(first.roster.setAvatar("agent-a", { style: "pixel-art", seed: "seed-1" }).ok, true);
  assert.equal(first.roster.setAvatar("helper-x", { custom: "team-icon" }).ok, true);
  await first.roster.flush();

  var second = makeRoster(file);
  assert.deepEqual(second.roster.list(), first.roster.list());
  var byKey = {};
  second.roster.list().forEach(function (a) { byKey[a.key] = a; });
  assert.deepEqual(byKey["agent-a"].avatar, { style: "pixel-art", seed: "seed-1" });
  assert.deepEqual(byKey["helper-x"].avatar, { custom: "team-icon" });
});

test("sightings are written once per burst, and flush writes what is pending", async function () {
  var file = tmpFile();
  var writes = 0;
  var m = makeRoster(file, { writeJson: function (f, v) { writes++; return fileWriter(f, v); } });
  m.roster.observe({ key: "agent-a", source: "session" });
  m.roster.observe({ key: "agent-b", source: "session" });
  m.roster.observe({ key: "agent-a", source: "subagent" });
  assert.equal(writes, 0, "not written per sighting");
  await m.roster.flush();
  assert.equal(writes, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).agents.length, 2);
});

test("a missing, corrupt or partly invalid file starts clean without throwing", function () {
  var file = tmpFile();
  assert.equal(makeRoster(file).roster.list().length, 0, "missing");

  var err = console.error;
  console.error = function () {};
  try {
    fs.writeFileSync(file, "{not json");
    assert.equal(makeRoster(file).roster.list().length, 0, "corrupt");
  } finally {
    console.error = err;
  }

  fs.writeFileSync(file, JSON.stringify({ version: 1, agents: [
    { key: "agent-a", firstSeen: 1, lastSeen: 2, places: [{ source: "session", project: "p", session: "1", lastSeen: 2 }, { source: "nope" }], avatar: { style: "bottts", seed: "s" } },
    { key: "", firstSeen: 1, lastSeen: 2 },
    { key: "agent-b", firstSeen: "x", lastSeen: 2 },
    { key: "agent-c", firstSeen: 1, lastSeen: 2, avatar: { custom: "Not A Slug" } },
  ] }));
  var list = makeRoster(file).roster.list();
  assert.deepEqual(list.map(function (a) { return a.key; }).sort(), ["agent-a", "agent-c"]);
  var a = list.filter(function (x) { return x.key === "agent-a"; })[0];
  assert.equal(a.places.length, 1);
  assert.deepEqual(a.avatar, { style: "bottts", seed: "s" });
  assert.equal(list.filter(function (x) { return x.key === "agent-c"; })[0].avatar, null, "an invalid stored choice is dropped");
});

test("a write that fails is logged and does not throw into the caller", async function () {
  var err = console.error;
  var logged = [];
  console.error = function (m) { logged.push(String(m)); };
  try {
    var m = makeRoster(tmpFile(), { writeJson: function () { return Promise.reject(new Error("disk full")); } });
    m.roster.observe({ key: "agent-a", source: "session" });
    await m.roster.flush();
  } finally {
    console.error = err;
  }
  assert.ok(logged.some(function (l) { return /could not write/.test(l); }));
});

test("setAvatar validates the reference, reports an unseen agent, and null clears the choice", function () {
  var m = makeRoster(tmpFile());
  m.roster.observe({ key: "agent-a", source: "session" });

  assert.equal(m.roster.setAvatar("never-seen", { style: "bottts", seed: "s" }).ok, false);
  assert.equal(m.roster.list().length, 1, "an unseen agent is not created");

  [{ style: "Bad Style", seed: "s" }, { style: "bottts" }, { style: "bottts", seed: "" }, { style: "bottts", seed: "a\nb" },
    { custom: "Has Space" }, { custom: 5 }, "robot", [], { custom: "x".repeat(65) }].forEach(function (bad) {
    var out = m.roster.setAvatar("agent-a", bad);
    assert.equal(out.ok, false, JSON.stringify(bad));
    assert.equal(typeof out.error, "string");
  });
  assert.equal(m.roster.list()[0].avatar, null, "a refused choice changes nothing");

  assert.deepEqual(m.roster.setAvatar("agent-a", { style: "bottts", seed: "s" }).agent.avatar, { style: "bottts", seed: "s" });
  assert.deepEqual(m.roster.setAvatar("agent-a", { custom: "team-icon", extra: "ignored" }).agent.avatar, { custom: "team-icon" });
  assert.equal(m.roster.setAvatar("agent-a", null).agent.avatar, null);
});

test("renaming a custom icon moves the choices that named it, and only those", async function () {
  var file = tmpFile();
  var m = makeRoster(file);
  m.roster.observe({ key: "agent-a", source: "session" });
  m.roster.observe({ key: "agent-b", source: "session" });
  m.roster.observe({ key: "agent-c", source: "session" });
  m.roster.setAvatar("agent-a", { custom: "old-icon" });
  m.roster.setAvatar("agent-b", { custom: "other-icon" });
  m.roster.setAvatar("agent-c", { style: "bottts", seed: "s" });

  assert.equal(m.roster.renameCustomIcon("old-icon", "new-icon"), 1);
  await m.roster.flush();
  var byKey = {};
  makeRoster(file).roster.list().forEach(function (a) { byKey[a.key] = a.avatar; });
  assert.deepEqual(byKey, { "agent-a": { custom: "new-icon" }, "agent-b": { custom: "other-icon" }, "agent-c": { style: "bottts", seed: "s" } });
  assert.equal(m.roster.renameCustomIcon("absent", "whatever"), 0);
});

test("the roster's sender key matches the browser's for every sender kind", async function () {
  var avatar = await import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "agent-avatar.js")).href);
  [
    { senderKind: "extracted", senderAgent: "worker-a", fromName: "worker-a@side" },
    { senderKind: "extracted", fromName: "vendor@side" },
    { senderKind: "extracted" },
    { senderKind: "declared", fromName: "declared-a" },
    { senderKind: "declared" },
    { senderKind: "undeclared" },
    { senderKind: "automation", fromName: "Scheduled message" },
    { senderKind: "unrecorded", fromName: "x" },
  ].forEach(function (s) {
    assert.equal(roster.senderKey(s), avatar.senderAgentKey(s), JSON.stringify(s));
  });
  assert.equal(roster.senderKey({ senderKind: "extracted", senderAgent: "worker-a", fromName: "worker-a@side" }), "worker-a");
  assert.equal(roster.senderKey({ senderKind: "undeclared" }), null);
  assert.equal(roster.senderKey({ senderKind: "automation", fromName: "Scheduled message" }), null);
});

// --- WebSocket handlers ---

test("the ws handlers answer a request, set an avatar, and report a refusal to the asker", function () {
  var m = makeRoster(tmpFile());
  m.roster.observe({ key: "agent-a", source: "session" });
  var sent = [];
  var h = rosterWs.createWsHandlers({ service: m.roster, sendTo: function (ws, obj) { sent.push(obj); } });

  assert.equal(h.handle({}, { type: "something_else" }), false);
  assert.equal(h.handle({}, { type: "agent_roster_request" }), true);
  assert.equal(sent[0].type, "agent_roster");
  assert.deepEqual(sent[0].agents.map(function (a) { return a.key; }), ["agent-a"]);

  assert.equal(h.handle({}, { type: "agent_avatar_set", key: "agent-a", avatar: { style: "bottts", seed: "s" } }), true);
  assert.deepEqual(sent[1], { type: "agent_avatar_set_result", key: "agent-a", ok: true });
  assert.deepEqual(m.roster.list()[0].avatar, { style: "bottts", seed: "s" });

  h.handle({}, { type: "agent_avatar_set", key: "agent-a", avatar: { style: "no way" } });
  assert.equal(sent[2].ok, false);
  assert.equal(typeof sent[2].error, "string");
  h.handle({}, { type: "agent_avatar_set", key: "never-seen", avatar: null });
  assert.equal(sent[3].ok, false);
  assert.deepEqual(m.roster.list()[0].avatar, { style: "bottts", seed: "s" }, "refusals change nothing");
});

test("with no roster the ws handlers say so instead of failing", function () {
  var sent = [];
  var h = rosterWs.createWsHandlers({ service: null, sendTo: function (ws, obj) { sent.push(obj); } });
  h.handle({}, { type: "agent_roster_request" });
  assert.deepEqual(sent[0], { type: "agent_roster", agents: [] });
  h.handle({}, { type: "agent_avatar_set", key: "agent-a", avatar: null });
  assert.equal(sent[1].ok, false);
});

// --- Where agents are seen ---

function makeSessionInputWorld() {
  var session = { localId: 4, cliSessionId: "cli-1", history: [], isProcessing: false, queryInstance: {} };
  var sm = {
    sessions: new Map([[4, session]]),
    recordHistoryEntry: function (s, e) { s.history.push(e); },
    appendToSessionFile: function () {},
    sendToSession: function () {},
  };
  return {
    sm: sm,
    project: {
      cwd: "/unused", sm: sm,
      sdk: { pushMessage: function () {}, startQuery: function () {} },
      onProcessingChanged: function () {},
      getLinuxUserForSession: function () { return null; },
    },
  };
}

test("an injected sender that names itself is reported where the input landed; one that names nobody is not", function () {
  var w = makeSessionInputWorld();
  var seen = [];
  var input = createSessionInput({
    getProject: function () { return w.project; },
    agentCatalog: function () { return []; },
    onAgentSeen: function (s) { seen.push(s); },
  });
  var base = { projectSlug: "proj-1", sessionId: "cli-1", prompt: "hello", initiator: "trigger" };

  assert.equal(input.sendInput(Object.assign({ from: "sender-z" }, base)).result, "delivered");
  assert.deepEqual(seen, [{ key: "sender-z", source: "sender", project: "proj-1", sessionId: "4" }]);

  input.sendInput(base);
  assert.equal(seen.length, 1, "an undeclared sender names no agent");
});

function makeProcessor(onAgentSeen) {
  var sm = {
    skillMeta: [], workflowMeta: [], skillNames: [], slashCommands: null,
    currentModel: null, _savedDefaultModel: null,
    sendAndRecord: function (session, obj) { (session.history = session.history || []).push(obj); },
    sendToSession: function () {}, saveSessionFile: function () {}, broadcastSessionList: function () {},
    modelsByVendor: {}, availableModels: [], availableVendors: [], installedVendors: [],
  };
  return attachMessageProcessor({
    sm: sm, send: function () {}, slug: "proj-1", cwd: "/tmp", pushModule: null,
    getNotificationsModule: function () { return null; },
    adapter: { vendor: "claude" },
    onProcessingChanged: function () {}, onTurnDone: null, onAutoTitle: null, opts: {},
    onAgentSeen: onAgentSeen,
    discoverSkillDirs: function () { return []; }, mergeSkills: function () { return []; },
    discoverWorkflows: function () { return []; },
    discoverSkillsWithMeta: function () { return []; }, mergeSkillsWithMeta: function () { return []; },
    getSDK: null,
  });
}

function makeSession() {
  return {
    localId: 7, cliSessionId: null, vendor: "claude", history: [], messageUUIDs: [],
    blocks: {}, sentToolResults: {}, pendingPermissions: {}, pendingElicitations: {},
    pendingAskUser: {}, activeTaskToolIds: {}, taskIdMap: {}, streamedText: false,
    responsePreview: "", isProcessing: true, loop: null,
  };
}

function runTool(processor, session, name, input, blockId) {
  processor.processSDKMessage(session, { yokeType: "tool_start", blockId: blockId, toolId: "tool-" + blockId, toolName: name });
  processor.processSDKMessage(session, { yokeType: "tool_input_delta", blockId: blockId, partialJson: JSON.stringify(input) });
  processor.processSDKMessage(session, { yokeType: "block_stop", blockId: blockId });
}

test("a Task or Agent call that names a subagent_type is reported as a sub-agent; other calls are not", function () {
  var seen = [];
  var processor = makeProcessor(function (s) { seen.push(s); });
  var session = makeSession();

  runTool(processor, session, "Agent", { description: "d", subagent_type: "helper-x", prompt: "p" }, 0);
  runTool(processor, session, "Task", { description: "d", subagent_type: "helper-y", prompt: "p" }, 1);
  runTool(processor, session, "Agent", { description: "no type", prompt: "p" }, 2);
  runTool(processor, session, "Read", { file_path: "/x", subagent_type: "not-a-dispatch" }, 3);

  assert.deepEqual(seen.map(function (s) { return s.key; }), ["helper-x", "helper-y"]);
  assert.deepEqual(seen[0], { key: "helper-x", source: "subagent", project: "proj-1", sessionId: "7" });
});

test("without an observer the processor handles a dispatch as before", function () {
  var processor = makeProcessor(undefined);
  var session = makeSession();
  runTool(processor, session, "Agent", { description: "d", subagent_type: "helper-x", prompt: "p" }, 0);
  assert.ok(session.history.some(function (e) { return e.type === "tool_executing" && e.name === "Agent"; }));
});

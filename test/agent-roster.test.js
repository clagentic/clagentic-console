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

// Writes one at a time, in call order, as lib/store.js writeJsonAt does: bare
// concurrent writeFile calls to one path can interleave and leave a torn file.
var writeChain = Promise.resolve();
function fileWriter(file, value) {
  var body = JSON.stringify(value);
  var next = writeChain.then(function () { return fs.promises.writeFile(file, body); });
  writeChain = next.catch(function () {});
  return next;
}

var CALLER = { user: null, authenticated: true };

function makeRoster(file, over) {
  var clockNow = 1000;
  var changes = { n: 0 };
  var r = roster.createAgentRoster(Object.assign({
    file: file,
    writeJson: fileWriter,
    clock: function () { return clockNow; },
    onChange: function () { changes.n++; },
    mayReadProject: function () { return true; },
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
  assert.deepEqual(helper.places, [{ source: "subagent", project: "proj-1", lastSeen: 2000 }]);
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
    m.roster.observe({ key: "agent-a", source: "session", project: "proj-" + i });
  }
  var a = m.roster.list()[0];
  assert.equal(a.places.length, roster.MAX_PLACES);
  assert.ok(a.places.some(function (p) { return p.project === "proj-" + (roster.MAX_PLACES + 4); }), "the newest place is kept");
  assert.ok(!a.places.some(function (p) { return p.project === "proj-0"; }), "the oldest place is dropped");
});

test("the roster and each avatar choice are restored unchanged after a restart", async function () {
  var file = tmpFile();
  var first = makeRoster(file);
  first.setNow(1000);
  first.roster.observe({ key: "agent-a", source: "session", project: "proj-1", sessionId: "3" });
  first.setNow(2000);
  first.roster.observe({ key: "helper-x", source: "subagent", project: "proj-1", sessionId: "3" });
  assert.equal(first.roster.setAvatar(CALLER, "agent-a", { style: "pixel-art", seed: "seed-1" }).ok, true);
  assert.equal(first.roster.setAvatar(CALLER, "helper-x", { custom: "team-icon" }).ok, true);
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

  assert.equal(m.roster.setAvatar(CALLER, "never-seen", { style: "bottts", seed: "s" }).ok, false);
  assert.equal(m.roster.list().length, 1, "an unseen agent is not created");

  [{ style: "Bad Style", seed: "s" }, { style: "bottts" }, { style: "bottts", seed: "" }, { style: "bottts", seed: "a\nb" },
    { custom: "Has Space" }, { custom: 5 }, "robot", [], { custom: "x".repeat(65) }].forEach(function (bad) {
    var out = m.roster.setAvatar(CALLER, "agent-a", bad);
    assert.equal(out.ok, false, JSON.stringify(bad));
    assert.equal(typeof out.error, "string");
  });
  assert.equal(m.roster.list()[0].avatar, null, "a refused choice changes nothing");

  assert.deepEqual(m.roster.setAvatar(CALLER, "agent-a", { style: "bottts", seed: "s" }).agent.avatar, { style: "bottts", seed: "s" });
  assert.deepEqual(m.roster.setAvatar(CALLER, "agent-a", { custom: "team-icon", extra: "ignored" }).agent.avatar, { custom: "team-icon" });
  assert.equal(m.roster.setAvatar(CALLER, "agent-a", null).agent.avatar, null);
});

test("renaming a custom icon moves the choices that named it, and only those", async function () {
  var file = tmpFile();
  var m = makeRoster(file);
  m.roster.observe({ key: "agent-a", source: "session" });
  m.roster.observe({ key: "agent-b", source: "session" });
  m.roster.observe({ key: "agent-c", source: "session" });
  m.roster.setAvatar(CALLER, "agent-a", { custom: "old-icon" });
  m.roster.setAvatar(CALLER, "agent-b", { custom: "other-icon" });
  m.roster.setAvatar(CALLER, "agent-c", { style: "bottts", seed: "s" });

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

// --- Team view groups from the vendor catalog ---

var { createVendorCatalog } = require("../lib/vendor-catalog");
var modelFamilies = require("../lib/model-families");
var fakeDom = require("./fake-dom-prompt-cards");

var PUBLIC_MODULES = path.join(__dirname, "..", "lib", "public", "modules");
async function loadGroups() {
  fakeDom.setupGlobals();
  return import(pathToFileURL(path.join(PUBLIC_MODULES, "agent-roster-groups.js")).href);
}

// A fake vendor that reports one model and one helper. Neutral names only.
function fakeVendorCatalog() {
  var catalog = createVendorCatalog();
  catalog.report("vendor-one", { models: [{ value: "model-a" }, { value: "alias-b", resolvedModel: "alias-b-1" }], helpers: [{ name: "helper-a" }] });
  return catalog;
}

function groupsOf(catalog, sightings) {
  var m = makeRoster(tmpFile(), { catalog: catalog });
  sightings.forEach(function (s) { m.roster.observe(s); });
  var out = {};
  m.roster.listFor(CALLER).forEach(function (a) { out[a.key] = a.group + ":" + a.vendor; });
  return out;
}

// key, how it was seen, expected group and the vendor whose list held it
[
  ["agent-a", "session", "agent:null"],
  ["helper-a", "subagent", "helper:vendor-one"],
  ["helper-a", "session", "agent:null"],
  ["model-a", "session", "model:vendor-one"],
  ["model-a", "subagent", "model:vendor-one"],
  ["alias-b-1", "sender", "model:vendor-one"],
  ["unlisted-helper", "subagent", "agent:null"],
].forEach(function (row) {
  test("classified by the vendor catalog: " + row[0] + " seen as " + row[1] + " is " + row[2], function () {
    var got = groupsOf(fakeVendorCatalog(), [{ key: row[0], source: row[1], project: "proj-1" }]);
    assert.equal(got[row[0]], row[2]);
  });
});

test("a vendor that newly reports a model and a helper changes the grouping with no code change", function () {
  var catalog = createVendorCatalog();
  var m = makeRoster(tmpFile(), { catalog: catalog });
  m.roster.observe({ key: "new-model", source: "session", project: "proj-1" });
  m.roster.observe({ key: "new-helper", source: "subagent", project: "proj-1" });
  var before = m.roster.listFor(CALLER).map(function (a) { return a.group; });
  assert.deepEqual(before, ["agent", "agent"], "a vendor that reported nothing groups nothing");

  var nudges = 0;
  catalog.subscribe(function () { nudges++; });
  assert.equal(catalog.report("fake-vendor", { models: [{ value: "new-model" }], helpers: [{ name: "new-helper" }] }), true);
  assert.equal(nudges, 1);
  assert.equal(catalog.report("fake-vendor", { models: [{ value: "new-model" }] }), false, "an unchanged report is not a change");
  var byKey = {};
  m.roster.listFor(CALLER).forEach(function (a) { byKey[a.key] = a.group + ":" + a.vendor; });
  assert.deepEqual(byKey, { "new-model": "model:fake-vendor", "new-helper": "helper:fake-vendor" });
  assert.equal(m.roster.catalogSnapshot()[0].vendor, "fake-vendor");
});

test("a vendor call that failed reports nothing and keeps what it last reported; no table is merged in", function () {
  var catalog = fakeVendorCatalog();
  assert.equal(catalog.report("vendor-one", { models: "not a list" }), false);
  assert.equal(catalog.report("", { models: [{ value: "x" }] }), false);
  assert.deepEqual(catalog.modelsOf("vendor-one").map(function (e) { return e.value; }), ["model-a", "alias-b"]);
  assert.deepEqual(catalog.modelsOf("never-reported"), []);
  var bare = groupsOf(createVendorCatalog(), [{ key: "model-a", source: "session" }]);
  assert.equal(bare["model-a"], "agent:null");
});

test("the group is read at answer time and never written to the roster file", function () {
  var m = makeRoster(tmpFile(), { catalog: fakeVendorCatalog() });
  m.roster.observe({ key: "model-a", source: "session", project: "proj-1" });
  assert.equal("group" in m.roster.list()[0], false);
  assert.equal(m.roster.listFor(CALLER)[0].group, "model");
  var msg = rosterWs.rosterMessage(m.roster, CALLER);
  assert.equal(msg.catalog[0].vendor, "vendor-one");
});

test("per-project visibility holds for every group", function () {
  var m = makeRoster(tmpFile(), { catalog: fakeVendorCatalog(), mayReadProject: function (slug) { return slug === "open"; } });
  m.roster.observe({ key: "model-a", source: "session", project: "closed" });
  m.roster.observe({ key: "helper-a", source: "subagent", project: "closed" });
  m.roster.observe({ key: "agent-a", source: "session", project: "closed" });
  m.roster.observe({ key: "model-a", source: "session", project: "open" });
  assert.deepEqual(m.roster.listFor(CALLER).map(function (a) { return a.key; }), ["model-a"]);
  assert.deepEqual(m.roster.listFor(CALLER)[0].places.map(function (p) { return p.project; }), ["open"]);
});

test("a sub-agent sighting in an unreadable project does not group the agent as a helper for a caller who cannot read it", function () {
  var m = makeRoster(tmpFile(), { catalog: fakeVendorCatalog(), mayReadProject: function (slug) { return slug !== "closed"; } });
  m.roster.observe({ key: "helper-a", source: "subagent", project: "closed" });
  m.roster.observe({ key: "helper-a", source: "session", project: "open" });
  var seen = m.roster.listFor(CALLER);
  assert.equal(seen[0].group, "agent");
  assert.equal(seen[0].vendor, null);
  var all = makeRoster(tmpFile(), { catalog: fakeVendorCatalog() });
  all.roster.observe({ key: "helper-a", source: "subagent", project: "closed" });
  all.roster.observe({ key: "helper-a", source: "session", project: "open" });
  assert.equal(all.roster.listFor(CALLER)[0].group, "helper", "a caller who can read both sees the helper");
});

test("Claude families come from the vendor's alias entries; the literal serves only until a list arrives", function () {
  try {
    modelFamilies.resetClaudeModelFamilies();
    assert.deepEqual(modelFamilies.CLAUDE_MODEL_FAMILIES, ["opus", "sonnet", "haiku", "fable"], "the fallback");
    assert.equal(modelFamilies.setClaudeModelFamilies([]), false, "a failed or empty listing keeps the fallback");
    assert.equal(modelFamilies.setClaudeModelFamilies([{ value: "default" }, { value: "claude-opus-4-5" }]), false, "no alias entry, no change");
    assert.deepEqual(modelFamilies.CLAUDE_MODEL_FAMILIES, ["opus", "sonnet", "haiku", "fable"]);

    assert.equal(modelFamilies.setClaudeModelFamilies([{ value: "default" }, { value: "newfam" }, { value: "sonnet" }, { value: "claude-opus-4-5" }]), true);
    assert.deepEqual(modelFamilies.CLAUDE_MODEL_FAMILIES, ["newfam", "sonnet"], "derived, not merged with the fallback");
    assert.equal(modelFamilies.parseClaudeModelVersion("claude-newfam-2-1").family, "newfam");
  } finally {
    modelFamilies.resetClaudeModelFamilies();
  }
});

test("the Team view draws three groups: named agents open, helpers and models collapsed", async function () {
  var G = await loadGroups();
  var agents = [
    { key: "agent-a", group: "agent" }, { key: "helper-a", group: "helper", vendor: "vendor-one" },
    { key: "model-a", group: "model", vendor: "vendor-one" }, { key: "legacy" }, { key: "odd", group: "unknown" },
  ];
  var parts = G.partitionRoster(agents);
  assert.deepEqual(parts.agent.map(function (a) { return a.key; }), ["agent-a", "legacy", "odd"], "nothing is dropped");
  assert.equal(parts.helper.length, 1);
  assert.equal(parts.model.length, 1);

  var sections = G.GROUPS.map(function (g) {
    var rows = parts[g.id].map(function (a) { var r = new fakeDom.FakeElement("div"); r.dataset.agentKey = a.key; return r; });
    return G.buildGroupSection(g, g.collapsible ? [] : rows, { count: parts[g.id].length, expanded: false, onToggle: function () {} });
  });
  assert.deepEqual(sections.map(function (s) { return s.dataset.arGroup; }), ["agent", "helper", "model"]);
  assert.equal(sections[0].querySelectorAll("[data-agent-key]").length, 3, "named agents are listed");
  assert.equal(sections[1].querySelector("button").getAttribute("aria-expanded"), "false");
  assert.equal(sections[1].querySelector(".ar-list"), null, "helpers start collapsed");
  assert.match(sections[2].querySelector("button").textContent, /^Models \(1\)$/);
  var open = G.buildGroupSection(G.GROUPS[2], [new fakeDom.FakeElement("div")], { count: 1, expanded: true, onToggle: function () {} });
  assert.ok(open.querySelector(".ar-list"));
});

// row: agent, whether the operator chose an avatar, what mark shows
[
  [{ key: "model-a", group: "model", vendor: "vendor-one" }, false, "logo"],
  [{ key: "model-a", group: "model", vendor: "no-logo" }, false, "neutral"],
  [{ key: "model-a", group: "model" }, false, "neutral"],
  [{ key: "helper-a", group: "helper", vendor: "vendor-one" }, false, "tool"],
  [{ key: "model-a", group: "model", vendor: "vendor-one" }, true, "chosen"],
  [{ key: "helper-a", group: "helper", vendor: "vendor-one" }, true, "chosen"],
  [{ key: "agent-a", group: "agent" }, false, "chosen"],
].forEach(function (row) {
  test("the mark of " + row[0].key + " (" + row[0].group + ", " + (row[0].vendor || "no vendor") + ", chosen " + row[1] + ") is " + row[2], async function () {
    var G = await loadGroups();
    var node = G.buildRowAvatar(row[0], 40, {
      chosen: function () { return row[1]; },
      plain: function () { var n = new fakeDom.FakeElement("img"); n.dataset.arMark = "chosen"; return n; },
      logoFor: function (v) { return v === "vendor-one" ? "/logo.png" : null; },
    });
    assert.equal(node.dataset.arMark, row[2]);
    if (row[2] === "logo") assert.equal(node.src, "/logo.png");
  });
});

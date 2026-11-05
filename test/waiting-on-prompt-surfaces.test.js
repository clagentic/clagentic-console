"use strict";

// A session blocked on an operator prompt (permission, ask_user) with no turn
// otherwise progressing used to read idle: the turn flag is only written by the
// input paths, so a CLI-initiated turn that stops on a prompt leaves it false.
// Every surface now reads one derivation, and a prompt-blocked session shows as
// "waiting on a prompt" on the confirm card, the picker and the sidebar, while
// list-sessions keeps its three states (the session is live) and its
// pendingPrompts.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { pathToFileURL } = require("url");

var { createSessionInput } = require("../lib/session-input");
var promptRegistry = require("../lib/prompt-registry");
var offer = require("../lib/build-update-offer");

function makeSession(localId, over) {
  return Object.assign({
    localId: localId,
    cliSessionId: "cli-" + localId,
    agentName: null,
    vendor: "claude",
    title: "t" + localId,
    lastActivity: 1700000000000,
    isProcessing: false,
    queryInstance: {},
    history: [],
    unread: 0,
    ownerId: null,
    pendingPermissions: Object.create(null),
  }, over || {});
}

function world(sessions) {
  var sm = { sessions: new Map(), defaultVendor: "claude" };
  sessions.forEach(function (s) { sm.sessions.set(s.localId, s); });
  var project = { sm: sm };
  var input = createSessionInput({
    getProject: function (slug) { return slug === "lore" ? project : null; },
    listProjects: function () { return [{ slug: "lore", project: project }]; },
    agentCatalog: function () { return []; },
  });
  var registry = promptRegistry.createPromptRegistry({
    index: Object.create(null),
    getSession: function (id) { return sm.sessions.get(id); },
    sendAndRecord: function () {},
    saveSessionFile: function () {},
  });
  return { sm: sm, input: input, registry: registry, project: project };
}

function block(registry, session, kind) {
  if (kind === "ask_user") return registry.open(session, "ask_user", { input: { questions: [] } }, {});
  return registry.open(session, "permission", { toolName: "Bash", toolInput: { command: "loadout-spec --help" }, vendor: "claude" });
}

function byId(r, id) {
  return r.sessions.filter(function (s) { return s.consoleSessionId === String(id); })[0];
}

function cardLine(world, localId) {
  var found = offer.collectInterruptions([{ slug: "lore", sm: world.sm }]);
  var text = offer.describeInterruptions(found);
  return text.split("\n").filter(function (l) { return l.indexOf("t" + localId + " (") !== -1; })[0];
}

async function activityModule() {
  return import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "activity-state.js")).href);
}

function sessionManager() {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-console-test-waiting-"));
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) {
    delete require.cache[require.resolve(m)];
  });
  var prior = process.env.CLAGENTIC_CONSOLE_HOME;
  process.env.CLAGENTIC_CONSOLE_HOME = tmpHome;
  var sessions;
  try {
    sessions = require("../lib/sessions");
  } finally {
    if (prior === undefined) delete process.env.CLAGENTIC_CONSOLE_HOME;
    else process.env.CLAGENTIC_CONSOLE_HOME = prior;
  }
  var sm = sessions.createSessionManager({ cwd: tmpHome, send: function () {}, sendTo: function () {}, sendEach: function () {} });
  return { sm: sm, cleanup: function () { fs.rmSync(tmpHome, { recursive: true, force: true }); } };
}

["permission", "ask_user"].forEach(function (kind) {
  test("list-sessions serves a " + kind + "-blocked session as live with pendingPrompts, in both calls", async function () {
    var blocked = makeSession(1);
    var idle = makeSession(2);
    var w = world([blocked, idle]);
    await promptRegistry.ready();
    block(w.registry, blocked, kind);

    var all = w.input.listSessions({});
    assert.equal(byId(all, 1).state, "live");
    assert.equal(byId(all, 1).pendingPrompts.length, 1);
    assert.equal(byId(all, 2).state, "idle");

    var live = w.input.listSessions({ state: "live" });
    assert.deepEqual(live.sessions.map(function (s) { return s.consoleSessionId; }), ["1"]);
    assert.equal(live.sessions[0].pendingPrompts.length, 1);
    assert.deepEqual(w.input.listSessions({ state: "idle" }).sessions.map(function (s) { return s.consoleSessionId; }), ["2"]);
  });
});

test("a running turn with no prompt stays live, an idle one idle, a reaped one reaped", function () {
  var running = makeSession(1, { isProcessing: true });
  var idle = makeSession(2);
  var reaped = makeSession(3, { queryInstance: null });
  var w = world([running, idle, reaped]);
  var all = w.input.listSessions({});
  assert.equal(byId(all, 1).state, "live");
  assert.equal(byId(all, 2).state, "idle");
  assert.equal(byId(all, 3).state, "reaped");
});

test("confirm card: three labels", async function () {
  var running = makeSession(1, { isProcessing: true });
  var idle = makeSession(2);
  var blocked = makeSession(3);
  var runningAndBlocked = makeSession(4, { isProcessing: true });
  var w = world([running, idle, blocked, runningAndBlocked]);
  await promptRegistry.ready();
  block(w.registry, blocked, "permission");
  block(w.registry, runningAndBlocked, "ask_user");

  assert.match(cardLine(w, 1), /\(running a turn\)/);
  assert.match(cardLine(w, 2), /\(idle\)/);
  assert.match(cardLine(w, 3), /\(waiting on a prompt\)/);
  assert.match(cardLine(w, 4), /\(waiting on a prompt\)/);
});

test("confirm card: the confirmation key covers a waiting session", async function () {
  var idle = makeSession(1);
  var w = world([idle]);
  await promptRegistry.ready();
  var before = offer.collectInterruptions([{ slug: "lore", sm: w.sm }]).keys.join("|");
  block(w.registry, idle, "permission");
  var after = offer.collectInterruptions([{ slug: "lore", sm: w.sm }]).keys.join("|");
  assert.notEqual(after, before, "a session offered as idle that then blocks on a prompt is not covered");
});

test("picker and sidebar: the session list entry for a prompt-blocked session is waiting; running and idle are unchanged", async function () {
  var h = sessionManager();
  try {
    var blocked = h.sm.createSessionRaw({});
    blocked.queryInstance = {};
    var running = h.sm.createSessionRaw({});
    running.queryInstance = {};
    running.isProcessing = true;
    var idle = h.sm.createSessionRaw({});
    idle.queryInstance = {};
    blocked.pendingPermissions = Object.create(null);
    blocked.pendingPermissions["req-1"] = { toolName: "Bash", toolInput: { command: "ls" }, createdAt: Date.now(), resolve: function () {} };

    var mod = await activityModule();
    var stateOf = function (s) { return mod.sessionActivity(h.sm.mapSessionForClient(s), null); };
    var cls = function (s) { return mod.indicatorClass(stateOf(s)); };

    assert.equal(stateOf(blocked).label, "Waiting on a prompt");
    assert.equal(stateOf(blocked).tone, "waiting");
    assert.equal(cls(blocked), "waiting");
    assert.equal(stateOf(running).label, "Active");
    assert.equal(cls(running), "processing");
    assert.equal(stateOf(idle).label, "Idle");
    assert.equal(cls(idle), "");
  } finally {
    h.cleanup();
  }
});

test("the project dot rolls a waiting session up as waiting; the transcript footer projection is untouched", async function () {
  var mod = await activityModule();
  var waiting = { isProcessing: false, waiting: true, unread: 0 };
  var running = { isProcessing: true, waiting: false, unread: 0 };
  assert.equal(mod.indicatorClass(mod.rollupActivity([running, waiting], null)), "waiting");
  assert.equal(mod.indicatorClass(mod.rollupActivity([running, { isProcessing: false, waiting: false }], null)), "processing");
  // The footer is a "a turn is running" indicator; a waiting session with no
  // turn flag must not pin it on.
  assert.equal(mod.deriveSessionListProcessing([{ id: 5, isProcessing: false, waiting: true, unread: 0 }], 5).active, false);
  assert.equal(mod.deriveSessionListProcessing([{ id: 5, isProcessing: true, waiting: true, unread: 0 }], 5).active, true);
});

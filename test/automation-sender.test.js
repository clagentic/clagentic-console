"use strict";
// Turns the console composes itself (scheduled, run-now, loop, rate-limit resume)
// are recorded with their initiator and shown as the automation, never as the
// operator. Only the browser composer's entry, stamped human, is the operator's.
// No browser: the real handlers, loop engine and renderer run over fakes.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var execFileSync = require("child_process").execFileSync;

var { removeTempHome } = require("./helpers/remove-temp-home");
var turnInitiator = require("../lib/turn-initiator");
var sender = require("../lib/injected-sender");
var { RATE_LIMIT_RESUME_NOTE } = require("../lib/scheduled-input/rate-limit-resume");
var { createScheduledInputService } = require("../lib/scheduled-input/service");
var { createSessionInput } = require("../lib/session-input");
var { attachUserMessage } = require("../lib/project-user-message");
var dom = require("./fake-dom-prompt-cards");
var { INITIATORS } = turnInitiator;

function clientModule() {
  return import("../lib/public/modules/injected-label.js");
}

// What a client shows for an entry once the server has prepared it.
async function shownFor(entry) {
  var label = await clientModule();
  var inj = label.injectedFromMessage(sender.forClient(entry));
  if (!inj) return { operator: true };
  return { operator: false, name: label.injectedSenderName(inj), label: label.injectedLabel(inj), kind: inj.senderKind };
}

// --- the entry and the vendor origin stamp come from one initiator ---

[INITIATORS.SCHEDULED, INITIATORS.SCHEDULED_NOW, INITIATORS.LOOP].forEach(function (initiator) {
  test("the recorded initiator and the SDK origin stamp agree for " + initiator, function () {
    var entry = sender.consoleTurnEntry(initiator, "text", "note");
    assert.equal(entry.initiator, initiator);
    var stamped = turnInitiator.stampClaudeUserMessage({}, entry.initiator);
    assert.deepEqual(stamped.origin, turnInitiator.claudeOrigin(initiator));
    assert.equal(stamped.origin.kind, "task-notification");
    assert.equal(stamped.origin.subkind, "scheduled-trigger");
    assert.equal(stamped.client_composed, true);
  });
});

test("a loop turn is stamped as a scheduled trigger with the loop fire reason, not an auto-continuation", function () {
  var origin = turnInitiator.claudeOrigin(sender.consoleTurnEntry(INITIATORS.LOOP, "t").initiator);
  assert.deepEqual(origin, { kind: "task-notification", subkind: "scheduled-trigger", fireReason: "loop" });
});

test("only a console automation initiator makes a console turn entry", function () {
  [INITIATORS.HUMAN, INITIATORS.TRIGGER, "robot", undefined, "constructor"].forEach(function (value) {
    assert.throws(function () { sender.consoleTurnEntry(value, "t"); }, /not a console automation initiator/);
  });
});

test("an automation entry reaches a client attributed to the automation and unchanged", function () {
  var entry = sender.consoleTurnEntry(INITIATORS.SCHEDULED, "go", "daily");
  var out = sender.forClient(entry);
  assert.equal(out.senderKind, "automation");
  assert.equal(out.fromName, "Scheduled message");
  assert.equal(out.from, "injected:scheduled");
  assert.equal(out.contextNote, "daily");
});

test("a forged automation entry naming no known automation is attributed as unrecorded", function () {
  var out = sender.forClient({ type: "user_message", text: "x", initiator: "robot", senderKind: "automation", fromName: "Admin" });
  assert.equal(out.senderKind, "unrecorded");
  assert.equal("fromName" in out, false);
});

// --- scheduled message and run-now ---

// The scheduled firing over the real session-input, with a fake session
// manager and sdk: what the chat records and what the query is told.
function makeFire() {
  var calls = [];
  var session = { localId: 3, cliSessionId: "vendor-3", history: [], isProcessing: false };
  var live = [];
  var project = {
    cwd: os.tmpdir(),
    sm: {
      sessions: new Map([[3, session]]),
      recordHistoryEntry: function (s, e) { s.history.push(e); },
      appendToSessionFile: function () {},
      sendToSession: function (s, obj) { live.push(obj); },
      broadcastSessionList: function () {},
    },
    sdk: { startQuery: function (s, text, images, user, initiator) { calls.push({ text: text, initiator: initiator }); } },
    onProcessingChanged: function () {},
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: function () { return null; },
  };
  var input = createSessionInput({ getProject: function (slug) { return slug === "p" ? project : null; } });
  var fire = function (s, scheduled, initiator) {
    return input.fireScheduled({ projectSlug: "p", sessionId: s.cliSessionId, prompt: scheduled.text, note: scheduled.note, initiator: initiator });
  };
  return { fire: fire, session: session, calls: calls, live: live };
}

[INITIATORS.SCHEDULED, INITIATORS.SCHEDULED_NOW].forEach(function (initiator) {
  test("a " + initiator + " turn is recorded and shown as the automation, with the initiator the query got", async function () {
    var w = makeFire();
    w.fire(w.session, { text: "run the job", note: "job-hunter daily" }, initiator);
    var entry = w.session.history[0];
    assert.equal(entry.initiator, initiator);
    assert.equal(w.calls[0].initiator, entry.initiator, "history and vendor origin name one initiator");
    assert.equal(w.calls[0].text, "run the job");
    // Live: the first message a client viewing the session gets.
    assert.equal(w.live[0].type, "user_message");
    assert.equal(w.live[0].senderKind, "automation");
    var shown = await shownFor(entry);
    assert.equal(shown.operator, false);
    assert.equal(shown.name, "Scheduled message");
    assert.equal(shown.label, (initiator === INITIATORS.SCHEDULED ? "scheduled" : "scheduled · sent now") + " · job-hunter daily");
  });
});

test("a rate limit resume carries its own note and is not the operator", async function () {
  var w = makeFire();
  w.fire(w.session, { text: "continue", note: RATE_LIMIT_RESUME_NOTE }, INITIATORS.SCHEDULED);
  var shown = await shownFor(w.session.history[0]);
  assert.equal(shown.operator, false);
  assert.equal(shown.label, "scheduled · " + RATE_LIMIT_RESUME_NOTE);
});

function makeMessageHandler() {
  var calls = [];
  var noop = function () {};
  var session = { localId: 7, cliSessionId: "vendor-7", vendor: "claude", history: [], title: "t", isProcessing: false, sentToolResults: {} };
  var sm = {
    sessions: new Map([[7, session]]),
    saveSessionFile: noop, broadcastSessionList: noop, appendToSessionFile: noop, sendAndRecord: noop, sendToSession: noop,
    recordHistoryEntry: function (s, entry) { s.history.push(entry); },
  };
  var sdk = {
    startQuery: function (s, text, images, user, initiator) { calls.push({ text: text, initiator: initiator }); },
    // A turn is already running after the run-now, so the typed message joins it.
    pushMessage: function (s, text, images, initiator) { calls.push({ text: text, initiator: initiator }); },
  };
  var project = {
    cwd: os.tmpdir(), sm: sm, sdk: sdk, onProcessingChanged: noop,
    getLinuxUserForSession: function () { return null; },
  };
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-automation-sender-"));
  var service = createScheduledInputService({
    dir: dir,
    getProject: function (slug) { return slug === "p" ? project : null; },
    sessionInput: createSessionInput({ getProject: function (slug) { return slug === "p" ? project : null; } }),
  });
  service.attachProject("p");
  var handler = attachUserMessage({
    cwd: os.tmpdir(), slug: "p", osUsers: false, sm: sm, sdk: sdk, nm: {}, tm: {},
    send: noop, sendTo: noop, sendToSession: noop, sendToSessionOthers: noop, clients: new Set(),
    opts: {}, usersModule: {},
    getSessionForWs: function () { return session; },
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: function () { return null; },
    getOsUserInfoForWs: noop, hydrateImageRefs: function (m) { return m; }, saveImageFile: noop, imagesDir: os.tmpdir(),
    onProcessingChanged: noop,
    _loop: { handleLoopMessage: function () { return false; } },
    browserState: { _browserTabList: {} },
    scheduledInput: service,
    loadContextSources: function () { return []; }, saveContextSources: noop,
    adapter: { renameSession: function () { return Promise.resolve(); } },
  });
  return {
    handler: handler, session: session, calls: calls, service: service,
    cleanup: function () { service.stop(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test("run-now records the scheduled-now initiator and the schedule's own label, then a typed message is the operator", async function () {
  var h = makeMessageHandler();
  h.handler.handleUserMessage({}, { type: "schedule_message", text: "scheduled text", resetsAt: Date.now() + 3600000 });
  h.handler.handleUserMessage({}, { type: "send_scheduled_now" });
  h.handler.handleUserMessage({}, { type: "message", text: "typed after" });
  h.cleanup();
  var runNow = h.session.history[0];
  var typed = h.session.history[1];
  assert.equal(runNow.initiator, INITIATORS.SCHEDULED_NOW);
  assert.equal(runNow.contextNote, "scheduled message");
  assert.equal(h.calls[0].initiator, runNow.initiator);
  assert.equal((await shownFor(runNow)).operator, false);
  assert.equal(typed.text, "typed after");
  assert.equal(typed.initiator, INITIATORS.HUMAN);
  assert.equal(h.calls[1].initiator, typed.initiator);
  assert.equal((await shownFor(typed)).operator, true, "operator typing in the same session stays the operator");
});

// --- legacy and fail closed ---

test("a legacy entry (no marker, no initiator) renders as the operator, as it always did", async function () {
  assert.equal((await shownFor({ type: "user_message", text: "old" })).operator, true);
});

test("a legacy multi-user entry keeps its from and fromName path", async function () {
  var entry = { type: "user_message", text: "old", from: "u1", fromName: "Andy" };
  assert.equal(sender.forClient(entry), entry);
  assert.equal((await shownFor(entry)).operator, true);
});

test("a legacy injected entry (external-trigger source) still takes the injected path", async function () {
  var shown = await shownFor({ type: "user_message", text: "old", source: "external-trigger", initiator: "trigger" });
  assert.equal(shown.operator, false);
  assert.equal(shown.name, "injected (sender not recorded)");
});

test("a new entry written by the browser composer is marked, names the human initiator and is the operator", async function () {
  var h = makeMessageHandler();
  h.handler.handleUserMessage({}, { type: "message", text: "typed" });
  var typed = h.session.history[0];
  assert.equal(typed[sender.RECORD_FORMAT_FIELD], 1);
  assert.equal(typed.initiator, INITIATORS.HUMAN);
  assert.equal((await shownFor(typed)).operator, true);
});

test("a new (marked) entry missing its initiator fails closed: not the operator", async function () {
  var shown = await shownFor(sender.stampRecord({ type: "user_message", text: "lost initiator" }));
  assert.equal(shown.operator, false);
  assert.equal(shown.kind, "unrecorded");
  assert.equal(shown.name, "injected (sender not recorded)");
});

test("a marked entry cannot claim a user id to escape attribution", async function () {
  var shown = await shownFor(sender.stampRecord({ type: "user_message", text: "x", from: "u1", fromName: "Andy" }));
  assert.equal(shown.operator, false);
});

test("an entry cannot claim a user id to escape attribution once it names an initiator", async function () {
  var shown = await shownFor({ type: "user_message", text: "x", from: "u1", fromName: "Andy", initiator: "loop", senderKind: "automation" });
  assert.equal(shown.operator, false);
});

test("every new automation entry is marked", function () {
  [INITIATORS.SCHEDULED, INITIATORS.SCHEDULED_NOW, INITIATORS.LOOP].forEach(function (i) {
    assert.equal(sender.consoleTurnEntry(i, "t")[sender.RECORD_FORMAT_FIELD], 1);
  });
});

// --- loop iteration ---

test("a loop iteration is recorded as the loop, with its name and iteration, and the same initiator reaches the query", async function () {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "console-loop-sender-"));
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "console-loop-sender-home-"));
  var gitEnv = Object.assign({}, process.env, {
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com",
  });
  execFileSync("git", ["init", "-q"], { cwd: cwd, env: gitEnv });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: cwd, env: gitEnv });
  var dir = path.join(cwd, ".claude", "loops", "loop_sender1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "PROMPT.md"), "Do the task.");
  fs.writeFileSync(path.join(dir, "LOOP.json"), JSON.stringify({ loopMode: "simple", maxIterations: 1 }));

  ["../lib/config", "../lib/utils", "../lib/store", "../lib/scheduler", "../lib/project-loop", "../lib/loop-handoff"]
    .forEach(function (m) { delete require.cache[require.resolve(m)]; });
  var origHome = process.env.CLAGENTIC_CONSOLE_HOME;
  process.env.CLAGENTIC_CONSOLE_HOME = home;
  var started = [];
  var sessions = new Map();
  var origSetTimeout = global.setTimeout;
  var armed = [];
  global.setTimeout = function (fn, delay) {
    var timer = origSetTimeout(fn, delay);
    armed.push(timer);
    return timer;
  };
  try {
    var noop = function () {};
    var nextId = 1;
    var engine = require("../lib/project-loop").attachLoop({
      cwd: cwd, slug: "p",
      sm: {
        sessions: sessions, setResolveLoopInfo: noop,
        createSession: function () {
          var s = { localId: nextId++, history: [], loop: {}, isProcessing: false };
          sessions.set(s.localId, s);
          return s;
        },
        saveSessionFile: noop, appendToSessionFile: noop, broadcastSessionList: noop,
        recordHistoryEntry: function (s, entry) { s.history.push(entry); },
      },
      sdk: { startQuery: function (s, text, images, user, initiator) { started.push(initiator); } },
      send: noop, sendTo: noop, sendToSession: noop, pushModule: null, notificationsModule: null,
      getHubSchedules: function () { return []; }, getAllProjectSessions: function () { return []; },
      getStatus: noop, getLinuxUserForSession: function () { return null; }, onProcessingChanged: noop, hydrateImageRefs: noop,
    });
    engine.stopTimer();
    engine.loopState.loopId = "loop_sender1";
    engine.loopState.loopFilesId = "loop_sender1";
    engine.loopState.wizardData = { loopMode: "simple", name: "job-hunter daily" };
    engine.startLoop({ maxIterations: 1 });
    var entry = sessions.get(engine.loopState.currentSessionId).history.filter(function (h) { return h.type === "user_message"; })[0];
    assert.equal(entry.initiator, INITIATORS.LOOP);
    assert.deepEqual(started, [entry.initiator]);
    var shown = await shownFor(entry);
    assert.equal(shown.operator, false);
    assert.equal(shown.name, "Loop");
    assert.equal(shown.label, "loop · job-hunter daily · iteration 1");
    assert.deepEqual(turnInitiator.claudeOrigin(entry.initiator), { kind: "task-notification", subkind: "scheduled-trigger", fireReason: "loop" });
  } finally {
    global.setTimeout = origSetTimeout;
    if (origHome === undefined) delete process.env.CLAGENTIC_CONSOLE_HOME;
    else process.env.CLAGENTIC_CONSOLE_HOME = origHome;
    // The loop persists through lib/store in several async steps, which the
    // helper lets finish. Its retry and watchdog timers (lib/project-loop) can
    // still start a save later, so every timer it armed is cancelled first.
    var cancelLoopTimers = function () { armed.forEach(function (t) { clearTimeout(t); }); };
    await removeTempHome(cwd, { quiesce: cancelLoopTimers });
    await removeTempHome(home, { quiesce: cancelLoopTimers });
  }
});

// --- rendering, both layouts ---

var sharedMessages = new dom.FakeElement("div");

async function render(t, wide) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var messages = sharedMessages;
  messages._children = [];
  document.getElementById = function (id) { return id === "messages" ? messages : null; };
  if (wide) document.body.classList.add("wide-view");
  var realQuery = dom.FakeElement.prototype.querySelector;
  dom.FakeElement.prototype.querySelector = function (sel) {
    return realQuery.call(this, sel) || (/^\.msg-action-/.test(sel) ? new dom.FakeElement("button") : null);
  };
  t.after(function () { dom.FakeElement.prototype.querySelector = realQuery; });
  var storeMod = await import(dom.moduleUrl("store.js"));
  storeMod.createStore({ connected: true, myUserId: "me", cachedAllUsers: [] });
  var rendering = await import(dom.moduleUrl("app-rendering.js") + "?automation=" + (wide ? "wide" : "bubble"));
  var label = await clientModule();
  var typed = sender.stampRecord({ type: "user_message", text: "typed by me", initiator: "human" });
  var loop = sender.forClient(sender.consoleTurnEntry(INITIATORS.LOOP, "iteration prompt", "job-hunter daily · iteration 3"));
  [typed, loop].forEach(function (e) {
    rendering.addUserMessage(e.text, null, null, e.from, e.fromName, label.injectedFromMessage(e));
  });
  return messages.querySelectorAll(".msg-user");
}

["bubble", "channel"].forEach(function (layout) {
  test("DOM, " + layout + " layout: a loop turn renders as the Loop automation beside the operator's message", async function (t) {
    var rows = await render(t, layout === "channel");
    var own = rows[0];
    var loop = rows[1];
    assert.equal(own.classList.contains("msg-user-other"), false);
    assert.equal(own.classList.contains("msg-user-injected"), false);
    assert.equal(loop.classList.contains("msg-user-other"), true);
    assert.equal(loop.classList.contains("msg-user-injected"), true);
    assert.ok(loop.querySelector(".dm-bubble-avatar-other"));
    assert.equal(loop.querySelector(".dm-bubble-name").textContent, "Loop");
    assert.equal(loop.querySelector(".injected-label").textContent, "loop · job-hunter daily · iteration 3");
  });
});

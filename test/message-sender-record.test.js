"use strict";
// The per-message sender record: for every user message the console sends into a
// vendor session, one caller shape each, on both vendors, the record an outside
// tool reads says who sent it. The real session manager, session-input, the
// scheduled-input firing and loop writers, the browser message handler, the file-drop
// watcher and the message processor run over a fake sdk; the reader below uses
// only the documented format (docs/guides/architecture.md, "Integrating other
// tools") and none of the console's code.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var execFileSync = require("child_process").execFileSync;

var { INITIATORS } = require("../lib/turn-initiator");
var { RATE_LIMIT_RESUME_NOTE } = require("../lib/scheduled-input/rate-limit-resume");
var { createScheduledInputService } = require("../lib/scheduled-input/service");
var claudeAdapter = require("../lib/yoke/adapters/claude");
var codexAdapter = require("../lib/yoke/adapters/codex");

var VENDORS = ["claude", "codex"];
var FIXTURE = path.join(__dirname, "fixtures", "external-trigger-dispatch-question.json");

// --- the standalone reader: the documented format and nothing else ---

function readLines(baseDir, vendor, vendorSessionId) {
  var file = path.join(baseDir, "message-senders", vendor, vendorSessionId + ".jsonl");
  if (!fs.existsSync(file)) return [];
  var out = [];
  fs.readFileSync(file, "utf8").split("\n").forEach(function (line) {
    if (!line) return;
    // A reader ignores a line it cannot parse (a torn final line).
    try { out.push(JSON.parse(line)); } catch (e) { return; }
  });
  return out;
}

// Messages in file order, each with the turnId a later `turn` line gave it.
function readMessages(baseDir, vendor, vendorSessionId) {
  var byId = {};
  var order = [];
  readLines(baseDir, vendor, vendorSessionId).forEach(function (rec) {
    if (rec.formatVersion !== 1) return;
    if (rec.kind === "message") { byId[rec.messageId] = Object.assign({}, rec); order.push(rec.messageId); }
    else if (rec.kind === "turn" && byId[rec.messageId]) byId[rec.messageId].turnId = rec.turnId;
  });
  return order.map(function (id) { return byId[id]; });
}

// --- the world: a real session manager over a throwaway data directory ---

function makeWorld(vendor, opts) {
  opts = opts || {};
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "console-sender-record-"));
  var origHome = process.env.CLAGENTIC_CONSOLE_HOME;
  var origLegacyHome = process.env.CLAGENTIC_HOME;
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) { delete require.cache[require.resolve(m)]; });
  process.env.CLAGENTIC_CONSOLE_HOME = home;
  delete process.env.CLAGENTIC_HOME;
  var sessionsModule = require("../lib/sessions");
  var { attachMessageProcessor } = require("../lib/sdk-message-processor");
  var recordsDir = opts.recordsDir || home;
  var noop = function () {};
  var sm = sessionsModule.createSessionManager({
    cwd: home, send: noop, sendTo: noop, sendEach: noop, senderRecordDir: recordsDir,
  });
  sm.defaultVendor = vendor;

  var calls = [];
  var sdk = {
    startQuery: function (s, text, images, user, initiator, messageId, leadMessages) {
      calls.push({ kind: "start", localId: s.localId, text: text, initiator: initiator, messageId: messageId, leadMessages: leadMessages });
    },
    pushMessage: function (s, text, images, initiator, messageId) {
      calls.push({ kind: "push", localId: s.localId, text: text, initiator: initiator, messageId: messageId });
    },
  };
  var project = {
    cwd: home, sm: sm, sdk: sdk,
    onProcessingChanged: noop,
    getLinuxUserForSession: function () { return null; },
    send: noop,
  };
  var processor = attachMessageProcessor({
    sm: sm, send: noop, slug: "p", cwd: home,
    pushModule: null, getNotificationsModule: function () { return null; },
    adapter: { vendor: vendor }, onProcessingChanged: noop,
    onTurnDone: null, onAutoTitle: null, opts: {},
    discoverSkillDirs: function () { return []; }, mergeSkills: function () { return []; },
    discoverWorkflows: function () { return []; },
    discoverSkillsWithMeta: function () { return []; },
    mergeSkillsWithMeta: function () { return []; },
    getSDK: null,
  });
  var world = {
    vendor: vendor, home: home, recordsDir: recordsDir, sm: sm, sdk: sdk, calls: calls, project: project, processor: processor,
    newSession: function (extra) {
      var s = sm.createSessionRaw({ vendor: vendor });
      return Object.assign(s, extra || {});
    },
    // The vendor names the session once its first turn answers.
    assign: function (session, id) { processor.processSDKMessage(session, { sessionId: id }); },
    messages: function (id) { return readMessages(recordsDir, vendor, id); },
    sessionInput: function (extra) {
      var { createSessionInput } = require("../lib/session-input");
      return createSessionInput(Object.assign({
        getProject: function (slug) { return slug === "p" ? project : null; },
        agentCatalog: function () { return []; },
      }, extra || {}));
    },
    cleanup: function () {
      if (origHome === undefined) delete process.env.CLAGENTIC_CONSOLE_HOME; else process.env.CLAGENTIC_CONSOLE_HOME = origHome;
      if (origLegacyHome === undefined) delete process.env.CLAGENTIC_HOME; else process.env.CLAGENTIC_HOME = origLegacyHome;
      ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) { delete require.cache[require.resolve(m)]; });
      // A loop saves its state asynchronously into this directory, so removal
      // can meet a file written meanwhile: retry.
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
  return world;
}

async function inWorld(vendor, fn, opts) {
  var w = makeWorld(vendor, opts);
  try { await fn(w); } finally { w.cleanup(); }
}

// The browser composer's message handler over the real session manager.
function makeTypedHandler(w, session, scheduledInput) {
  var { attachUserMessage } = require("../lib/project-user-message");
  var noop = function () {};
  return attachUserMessage({
    cwd: w.home, slug: "p", osUsers: false, sm: w.sm, sdk: w.sdk, nm: {}, tm: {},
    send: noop, sendTo: noop, sendToSession: noop, sendToSessionOthers: noop, clients: new Set(),
    opts: {}, usersModule: {},
    getSessionForWs: function () { return session; },
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: function () { return null; },
    getOsUserInfoForWs: noop, hydrateImageRefs: function (m) { return m; }, saveImageFile: noop, imagesDir: w.home,
    onProcessingChanged: noop,
    _loop: { handleLoopMessage: function () { return false; } },
    browserState: { _browserTabList: {} },
    scheduledInput: scheduledInput || null,
    loadContextSources: function () { return []; }, saveContextSources: noop,
    adapter: { renameSession: function () { return Promise.resolve(); } },
  });
}

// A scheduled firing over the real session-input and session manager.
function makeFire(w) {
  var input = w.sessionInput();
  return function (session, scheduled, initiator) {
    return input.fireScheduled({
      projectSlug: "p", sessionId: session.cliSessionId, prompt: scheduled.text, note: scheduled.note, initiator: initiator,
    });
  };
}

function makeScheduledInputService(w) {
  var service = createScheduledInputService({
    dir: path.join(w.home, "scheduled-input"),
    getProject: function (slug) { return slug === "p" ? w.project : null; },
    sessionInput: w.sessionInput(),
  });
  service.attachProject("p");
  return service;
}

function only(list) {
  assert.equal(list.length, 1, "exactly one record: " + JSON.stringify(list));
  return list[0];
}

// --- typed turns ---

VENDORS.forEach(function (vendor) {
  test(vendor + ": a message typed in the browser composer is recorded as human, with the id the vendor got", function () {
    return inWorld(vendor, function (w) {
      var session = w.newSession();
      makeTypedHandler(w, session).handleUserMessage({}, { type: "message", text: "typed by the operator" });
      var sent = w.calls[0];
      assert.equal(sent.kind, "start");
      assert.equal(sent.initiator, INITIATORS.HUMAN);
      w.assign(session, "sess-typed");
      var rec = only(w.messages("sess-typed"));
      assert.equal(rec.formatVersion, 1);
      assert.equal(rec.vendor, vendor);
      assert.equal(rec.vendorSessionId, "sess-typed");
      assert.equal(rec.messageId, sent.messageId);
      assert.equal(rec.initiator, "human");
      assert.equal(rec.senderKind, null);
      assert.equal(rec.fromSession, null);
      assert.ok(!isNaN(Date.parse(rec.timestamp)));
    });
  });

  test(vendor + ": a typed message in a session the vendor already named is written at once", function () {
    return inWorld(vendor, function (w) {
      var session = w.newSession({ cliSessionId: "sess-known" });
      makeTypedHandler(w, session).handleUserMessage({}, { type: "message", text: "hello again" });
      var rec = only(w.messages("sess-known"));
      assert.equal(rec.initiator, "human");
      assert.equal(rec.messageId, w.calls[0].messageId);
    });
  });

  test(vendor + ": a typed turn then send-input in one session: each message keeps its own record", function () {
    return inWorld(vendor, async function (w) {
      var session = w.newSession({ cliSessionId: "sess-mixed" });
      makeTypedHandler(w, session).handleUserMessage({}, { type: "message", text: "typed" });
      session.queryInstance = {};
      var r = await w.sessionInput().sendInput({ projectSlug: "p", sessionId: "sess-mixed", prompt: "injected", from: "ops-bot" });
      assert.equal(r.ok, true);
      var recs = w.messages("sess-mixed");
      assert.equal(recs.length, 2);
      assert.deepEqual(recs.map(function (x) { return x.initiator; }), ["human", "trigger"]);
      assert.equal(recs[0].senderName, null);
      assert.equal(recs[1].senderName, "ops-bot");
      assert.equal(recs[1].senderKind, "declared");
      assert.notEqual(recs[0].messageId, recs[1].messageId);
      assert.deepEqual(w.calls.map(function (c) { return c.messageId; }), recs.map(function (x) { return x.messageId; }));
    });
  });
});

// --- injected turns ---

VENDORS.forEach(function (vendor) {
  test(vendor + ": send-input into a live process records declared sender, sending session and the id the vendor got", function () {
    return inWorld(vendor, async function (w) {
      var session = w.newSession({ cliSessionId: "sess-live", isProcessing: true, queryInstance: {} });
      var r = await w.sessionInput().sendInput({
        projectSlug: "p", sessionId: "sess-live", prompt: "ping", from: "ops-bot", fromSession: "ses_abc123",
      });
      assert.equal(r.result, "delivered");
      assert.equal(w.calls[0].kind, "push");
      var rec = only(w.messages("sess-live"));
      assert.equal(rec.messageId, w.calls[0].messageId);
      assert.equal(rec.initiator, "trigger");
      assert.equal(rec.senderName, "ops-bot");
      assert.equal(rec.senderKind, "declared");
      assert.equal(rec.fromSession, "ses_abc123");
    });
  });

  test(vendor + ": send-input without a sending session records none", function () {
    return inWorld(vendor, async function (w) {
      w.newSession({ cliSessionId: "sess-nofrom", isProcessing: true, queryInstance: {} });
      await w.sessionInput().sendInput({ projectSlug: "p", sessionId: "sess-nofrom", prompt: "ping", from: "ops-bot" });
      var rec = only(w.messages("sess-nofrom"));
      assert.equal(rec.fromSession, null);
      assert.equal(rec.senderKind, "declared");
    });
  });

  test(vendor + ": send-input with no sender at all is undeclared and still recorded", function () {
    return inWorld(vendor, async function (w) {
      w.newSession({ cliSessionId: "sess-anon", isProcessing: true, queryInstance: {} });
      await w.sessionInput().sendInput({ projectSlug: "p", sessionId: "sess-anon", prompt: "ping" });
      var rec = only(w.messages("sess-anon"));
      assert.equal(rec.senderKind, "undeclared");
      assert.equal(rec.senderName, null);
      assert.equal(rec.initiator, "trigger");
    });
  });

  test(vendor + ": send-input that starts a query records the id the query started with", function () {
    return inWorld(vendor, async function (w) {
      w.newSession({ cliSessionId: "sess-idle" });
      var r = await w.sessionInput().sendInput({ projectSlug: "p", sessionId: "sess-idle", prompt: "wake", initiator: "scheduled", fromSession: "ses_x" });
      assert.equal(r.result, "resumed-and-delivered");
      assert.equal(w.calls[0].kind, "start");
      var rec = only(w.messages("sess-idle"));
      assert.equal(rec.messageId, w.calls[0].messageId);
      assert.equal(rec.initiator, "scheduled");
      assert.equal(rec.fromSession, "ses_x");
    });
  });

  test(vendor + ": the open-session prompt is recorded once the vendor names the new session", function () {
    return inWorld(vendor, async function (w) {
      var r = await w.sessionInput().openSession({ projectSlug: "p", prompt: "start here", vendor: vendor, from: "planner", fromSession: "ses_parent" });
      assert.equal(r.result, "opened");
      var opened = w.sm.sessions.get(r.localId);
      w.assign(opened, "sess-opened");
      var rec = only(w.messages("sess-opened"));
      assert.equal(rec.messageId, w.calls[0].messageId);
      assert.equal(rec.initiator, "trigger");
      assert.equal(rec.senderName, "planner");
      assert.equal(rec.fromSession, "ses_parent");
    });
  });

  test(vendor + ": a bad fromSession is refused and nothing is sent or recorded", function () {
    return inWorld(vendor, async function (w) {
      w.newSession({ cliSessionId: "sess-bad", isProcessing: true, queryInstance: {} });
      var input = w.sessionInput();
      var control = await input.sendInput({ projectSlug: "p", sessionId: "sess-bad", prompt: "x", fromSession: "bad\u0007id" });
      var long = await input.sendInput({ projectSlug: "p", sessionId: "sess-bad", prompt: "x", fromSession: "a".repeat(129) });
      var notString = await input.openSession({ projectSlug: "p", prompt: "x", fromSession: 7 });
      [control, long, notString].forEach(function (res) {
        assert.equal(res.result, "refused");
        assert.match(res.reason, /fromSession/);
      });
      assert.equal(w.calls.length, 0);
      assert.equal(w.messages("sess-bad").length, 0);
    });
  });

  [1, 2].forEach(function (version) {
    test(vendor + ": a version " + version + " file-drop trigger is recorded with its sender and sending session", function () {
      return inWorld(vendor, async function (w) {
        var { attachExternalTrigger } = require("../lib/project-external-trigger");
        var trigger = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
        trigger.version = version;
        trigger.from = "dispatcher";
        trigger.fromSession = "ses_dispatch";
        var session = w.newSession({ cliSessionId: trigger.sessionId, queryInstance: {}, isProcessing: true });
        if (version === 1) delete trigger.sessionId;
        var dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-sender-trigger-"));
        var et = attachExternalTrigger({
          triggersDir: dir,
          getProject: function (slug) { return slug === trigger.projectSlug ? w.project : null; },
        });
        try {
          fs.writeFileSync(path.join(dir, "trigger.json"), JSON.stringify(trigger));
          et.startWatcher();
          var deadline = Date.now() + 5000;
          while (!fs.existsSync(path.join(dir, "processed", trigger.id + ".json")) && Date.now() < deadline) {
            await new Promise(function (r) { setTimeout(r, 50); });
          }
          assert.ok(fs.existsSync(path.join(dir, "processed", trigger.id + ".json")), "the trigger was handled");
        } finally {
          et.stopWatcher();
          fs.rmSync(dir, { recursive: true, force: true });
        }
        var id = session.cliSessionId;
        if (version === 1) {
          // No session named: the drop opened a new one, which the vendor then names.
          var opened = Array.from(w.sm.sessions.values()).pop();
          assert.notEqual(opened, session);
          w.assign(opened, "sess-dropped");
          id = "sess-dropped";
        }
        var rec = only(w.messages(id));
        assert.equal(rec.messageId, w.calls[0].messageId);
        assert.equal(rec.initiator, "trigger");
        assert.equal(rec.senderName, "dispatcher");
        assert.equal(rec.senderKind, "declared");
        assert.equal(rec.fromSession, "ses_dispatch");
      });
    });
  });
});

// --- console-composed turns ---

VENDORS.forEach(function (vendor) {
  [INITIATORS.SCHEDULED, INITIATORS.SCHEDULED_NOW].forEach(function (initiator) {
    test(vendor + ": a " + initiator + " turn is recorded as automation, never the operator", function () {
      return inWorld(vendor, function (w) {
        var session = w.newSession({ cliSessionId: "sess-sched-" + initiator });
        makeFire(w)(session, { text: "run the job", note: "daily" }, initiator);
        var rec = only(w.messages("sess-sched-" + initiator));
        assert.equal(rec.initiator, initiator);
        assert.equal(rec.senderKind, "automation");
        assert.equal(rec.senderName, "Scheduled message");
        assert.equal(rec.messageId, w.calls[0].messageId);
        assert.notEqual(rec.initiator, "human");
      });
    });
  });

  test(vendor + ": a rate limit auto-resume is recorded as a scheduled automation", function () {
    return inWorld(vendor, function (w) {
      var session = w.newSession({ cliSessionId: "sess-resume" });
      makeFire(w)(session, { text: "continue", note: RATE_LIMIT_RESUME_NOTE }, INITIATORS.SCHEDULED);
      var rec = only(w.messages("sess-resume"));
      assert.equal(rec.initiator, "scheduled");
      assert.equal(rec.senderKind, "automation");
    });
  });

  test(vendor + ": run-now from the browser is automation, and a typed message after it is human", function () {
    return inWorld(vendor, function (w) {
      var session = w.newSession({ cliSessionId: "sess-runnow" });
      var service = makeScheduledInputService(w);
      var handler = makeTypedHandler(w, session, service);
      handler.handleUserMessage({}, { type: "schedule_message", text: "scheduled text", resetsAt: Date.now() + 3600000 });
      handler.handleUserMessage({}, { type: "send_scheduled_now" });
      handler.handleUserMessage({}, { type: "message", text: "typed after" });
      service.stop();
      var recs = w.messages("sess-runnow");
      assert.deepEqual(recs.map(function (x) { return x.initiator; }), ["scheduled-now", "human"]);
      assert.equal(recs[0].senderKind, "automation");
      assert.equal(recs[1].senderKind, null);
    });
  });

  test(vendor + ": a loop iteration is recorded as the loop", function () {
    return inWorld(vendor, function (w) {
      var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "console-sender-loop-"));
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
      ["../lib/store", "../lib/scheduler", "../lib/project-loop", "../lib/loop-handoff"]
        .forEach(function (m) { delete require.cache[require.resolve(m)]; });
      var origSetTimeout = global.setTimeout;
      var armed = [];
      global.setTimeout = function (fn, delay) {
        var timer = origSetTimeout(fn, delay);
        armed.push(timer);
        return timer;
      };
      try {
        var noop = function () {};
        var loopSm = Object.create(w.sm);
        loopSm.setResolveLoopInfo = noop;
        loopSm.createSession = function () {
          var s = w.sm.createSessionRaw({ vendor: vendor });
          s.loop = {};
          s.cliSessionId = "sess-loop";
          return s;
        };
        var engine = require("../lib/project-loop").attachLoop({
          cwd: cwd, slug: "p", sm: loopSm, sdk: w.sdk,
          send: noop, sendTo: noop, sendToSession: noop, pushModule: null, notificationsModule: null,
          getHubSchedules: function () { return []; }, getAllProjectSessions: function () { return []; },
          getStatus: noop, getLinuxUserForSession: function () { return null; }, onProcessingChanged: noop, hydrateImageRefs: noop,
        });
        engine.stopTimer();
        engine.loopState.loopId = "loop_sender1";
        engine.loopState.loopFilesId = "loop_sender1";
        engine.loopState.wizardData = { loopMode: "simple", name: "daily" };
        engine.startLoop({ maxIterations: 1 });
        var rec = only(w.messages("sess-loop"));
        assert.equal(rec.initiator, "loop");
        assert.equal(rec.senderKind, "automation");
        assert.equal(rec.senderName, "Loop");
        assert.equal(rec.messageId, w.calls[0].messageId);
      } finally {
        global.setTimeout = origSetTimeout;
        armed.forEach(function (t) { clearTimeout(t); });
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});

// --- the vendor side of the join ---

test("claude: the message id is sent as the SDK message uuid, and is absent when none is given", function () {
  var queue = [];
  var handle = claudeAdapter._test_createQueryHandle({}, queue, null);
  handle.pushMessage("with id", null, "trigger", "00000000-0000-4000-8000-000000000001");
  handle.pushMessage("without id", null, "trigger");
  assert.equal(queue[0].uuid, "00000000-0000-4000-8000-000000000001");
  assert.equal(queue[0].origin.kind, "task-notification");
  assert.equal("uuid" in queue[1], false);
});

function fakeCodexServer(turnIds) {
  var handlers = [];
  var next = 0;
  function dispatch(msg) { handlers.forEach(function (h) { if (h.threadId === null || h.threadId === "thread-1") h.fn(msg); }); }
  return {
    started: true,
    addEventHandler: function (fn, threadId) { var e = { fn: fn, threadId: threadId || null }; handlers.push(e); return e; },
    removeEventHandler: function (entry) { handlers = handlers.filter(function (h) { return h !== entry; }); },
    updateHandlerThreadId: function (entry, threadId) { entry.threadId = threadId || null; },
    respond: function () {},
    send: function (method) {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      if (method === "turn/start") {
        var turnId = turnIds[next++];
        setImmediate(function () {
          dispatch({ method: "turn/started", params: { turn: { id: turnId } } });
          dispatch({ method: "turn/completed", params: { usage: null } });
        });
        return Promise.resolve({ turn: { id: turnId } });
      }
      return Promise.resolve({});
    },
  };
}

test("codex: each turn_start names the turn id and the message that started it", async function () {
  var handle = codexAdapter._test_createCodexQueryHandle(fakeCodexServer(["turn-A", "turn-B"]), { model: "gpt-5.4" });
  var seen = [];
  var iterator = handle[Symbol.asyncIterator]();
  handle.pushMessage("first", null, "human", "msg-1");
  handle.pushMessage("second", null, "loop", "msg-2");
  while (seen.length < 2) {
    var ev = await iterator.next();
    if (ev.value && ev.value.yokeType === "turn_start") seen.push(ev.value);
  }
  handle.close();
  assert.deepEqual(seen.map(function (e) { return [e.messageId, e.turnId]; }), [["msg-1", "turn-A"], ["msg-2", "turn-B"]]);
});

test("codex: a turn_start with no message id carries no join fields", async function () {
  var handle = codexAdapter._test_createCodexQueryHandle(fakeCodexServer(["turn-Z"]), { model: "gpt-5.4" });
  var iterator = handle[Symbol.asyncIterator]();
  handle.pushMessage("legacy caller");
  var ev;
  do { ev = await iterator.next(); } while (!(ev.value && ev.value.yokeType === "turn_start"));
  handle.close();
  assert.equal("turnId" in ev.value, false);
  assert.equal("messageId" in ev.value, false);
});

VENDORS.forEach(function (vendor) {
  test(vendor + ": a turn reported after the vendor named the session is appended at once", function () {
    return inWorld(vendor, function (w) {
      var session = w.newSession({ cliSessionId: "sess-late-turn" });
      makeTypedHandler(w, session).handleUserMessage({}, { type: "message", text: "typed" });
      var messageId = w.calls[0].messageId;
      w.processor.processSDKMessage(session, { yokeType: "turn_start", uuid: "u1", messageType: "user", messageId: messageId, turnId: "turn-3" });
      assert.deepEqual(readLines(w.recordsDir, vendor, "sess-late-turn").map(function (l) { return l.kind; }), ["message", "turn"]);
      assert.equal(only(w.messages("sess-late-turn")).turnId, "turn-3");
    });
  });

  test(vendor + ": the processor joins a turn to its message when the turn starts before the vendor names the session", function () {
    return inWorld(vendor, function (w) {
      var session = w.newSession();
      makeTypedHandler(w, session).handleUserMessage({}, { type: "message", text: "typed" });
      var messageId = w.calls[0].messageId;
      w.processor.processSDKMessage(session, { yokeType: "turn_start", uuid: "u1", messageType: "user", messageId: messageId, turnId: "turn-9" });
      w.assign(session, "sess-turn");
      var lines = readLines(w.recordsDir, vendor, "sess-turn");
      assert.deepEqual(lines.map(function (l) { return l.kind; }), ["message", "turn"]);
      var rec = only(w.messages("sess-turn"));
      assert.equal(rec.turnId, "turn-9");
      assert.equal(rec.messageId, messageId);
    });
  });
});

// --- failure, absence and the reader's contract ---

VENDORS.forEach(function (vendor) {
  test(vendor + ": a record that cannot be written is logged and never breaks or delays the turn", function () {
    var blocker = path.join(os.tmpdir(), "console-sender-blocker-" + process.pid + "-" + vendor);
    fs.writeFileSync(blocker, "not a directory");
    var errors = [];
    var origError = console.error;
    console.error = function () { errors.push(Array.prototype.join.call(arguments, " ")); };
    return inWorld(vendor, async function (w) {
      w.newSession({ cliSessionId: "sess-unwritable", isProcessing: true, queryInstance: {} });
      var r = await w.sessionInput().sendInput({ projectSlug: "p", sessionId: "sess-unwritable", prompt: "still delivered" });
      assert.equal(r.result, "delivered");
      assert.equal(w.calls.length, 1);
      assert.ok(errors.some(function (line) { return /could not write the record/.test(line); }), errors.join("|"));
    }, { recordsDir: blocker }).finally(function () {
      console.error = origError;
      fs.rmSync(blocker, { force: true });
    });
  });

  test(vendor + ": nothing is written for a session that never gets a vendor session id", function () {
    return inWorld(vendor, function (w) {
      var session = w.newSession();
      makeTypedHandler(w, session).handleUserMessage({}, { type: "message", text: "never answered" });
      assert.equal(fs.existsSync(path.join(w.recordsDir, "message-senders")), false);
    });
  });
});

test("the reader ignores an unparsable final line and unknown kinds and fields", function () {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "console-sender-reader-"));
  try {
    var dir = path.join(home, "message-senders", "claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "s1.jsonl"), [
      JSON.stringify({ formatVersion: 1, kind: "message", vendor: "claude", vendorSessionId: "s1", messageId: "m1", initiator: "human", future: "ignored" }),
      JSON.stringify({ formatVersion: 1, kind: "something-new", messageId: "m1" }),
      '{"formatVersion":1,"kind":"mess',
    ].join("\n"));
    var msgs = readMessages(home, "claude", "s1");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].messageId, "m1");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the record path refuses a vendor or session id that could leave its directory", function () {
  var rec = require("../lib/message-sender-record");
  assert.throws(function () { rec.recordPath("/base", "claude", "../x"); }, /unsafe/);
  assert.throws(function () { rec.recordPath("/base", "../claude", "x"); }, /unsafe/);
  assert.equal(rec.recordPath("/base", "codex", "abc-1"), path.join("/base", "message-senders", "codex", "abc-1.jsonl"));
});

test("no console code names a consumer of the record", function () {
  var files = ["lib/message-sender-record.js", "lib/injected-sender.js", "lib/session-input.js", "lib/sessions.js"];
  files.forEach(function (rel) {
    var text = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    assert.equal(/\blore\b/i.test(text), false, rel + " must not name a consumer");
  });
});

// --- no record is dropped while the vendor session id is unknown ---

VENDORS.forEach(function (vendor) {
  test(vendor + ": more than 100 messages sent before the vendor names the session are all published, in order", function () {
    return inWorld(vendor, function (w) {
      var { stampRecord } = require("../lib/injected-sender");
      var session = w.newSession();
      var ids = [];
      for (var i = 0; i < 250; i++) {
        var entry = stampRecord({ type: "user_message", text: "m" + i, initiator: INITIATORS.HUMAN });
        ids.push(entry.messageId);
        w.sm.recordHistoryEntry(session, entry, true);
      }
      assert.equal(fs.existsSync(path.join(w.recordsDir, "message-senders")), false);
      w.assign(session, "sess-many");
      var recs = w.messages("sess-many");
      assert.deepEqual(recs.map(function (r) { return r.messageId; }), ids);
    });
  });
});

// --- operator words typed into a running loop ---

// An attached loop engine over the real session manager. Timers the loop arms
// are held, not run: `fireDelay(ms)` runs the ones armed with that delay.
async function withLoopEngine(w, vendor, maxIterations, fn) {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "console-sender-loopq-"));
  var gitEnv = Object.assign({}, process.env, {
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com",
  });
  execFileSync("git", ["init", "-q"], { cwd: cwd, env: gitEnv });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: cwd, env: gitEnv });
  var dir = path.join(cwd, ".claude", "loops", "loop_queued1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "PROMPT.md"), "Do the task.");
  fs.writeFileSync(path.join(dir, "LOOP.json"), JSON.stringify({ loopMode: "simple", maxIterations: maxIterations }));
  ["../lib/store", "../lib/scheduler", "../lib/project-loop", "../lib/loop-handoff"]
    .forEach(function (m) { delete require.cache[require.resolve(m)]; });
  var origSetTimeout = global.setTimeout;
  var held = [];
  global.setTimeout = function (fn, delay) {
    var timer = origSetTimeout(fn, 1e9);
    clearTimeout(timer);
    held.push({ fn: fn, delay: delay });
    return timer;
  };
  var noop = function () {};
  var sessions = [];
  try {
    var loopSm = Object.create(w.sm);
    loopSm.setResolveLoopInfo = noop;
    loopSm.createSession = function () {
      var s = w.sm.createSessionRaw({ vendor: vendor });
      s.loop = {};
      s.cliSessionId = "sess-loop-" + (sessions.length + 1);
      sessions.push(s);
      return s;
    };
    var sent = [];
    var engine = require("../lib/project-loop").attachLoop({
      cwd: cwd, slug: "p", sm: loopSm, sdk: w.sdk,
      send: function (m) { sent.push(m); }, sendTo: noop, sendToSession: noop, pushModule: null, notificationsModule: null,
      getHubSchedules: function () { return []; }, getAllProjectSessions: function () { return []; },
      getStatus: noop, getLinuxUserForSession: function () { return null; }, onProcessingChanged: noop, hydrateImageRefs: noop,
    });
    engine.stopTimer();
    engine.loopState.loopId = "loop_queued1";
    engine.loopState.loopFilesId = "loop_queued1";
    engine.loopState.wizardData = { loopMode: "simple", name: "daily" };
    fn({
      engine: engine, sessions: sessions, sent: sent,
      fireDelay: function (ms) {
        var due = held.filter(function (h) { return h.delay === ms; });
        held = held.filter(function (h) { return h.delay !== ms; });
        due.forEach(function (h) { h.fn(); });
      },
    });
  } finally {
    global.setTimeout = origSetTimeout;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  // The loop saves its state asynchronously into the data directory, which the
  // world removes when the test ends.
  await new Promise(function (resolve) { setTimeout(resolve, 250); });
}

// What the vendor adapters do with the messages the bridge pushed for one
// startQuery: the lead messages, then the first.
function pushedMessages(call) {
  return (call.leadMessages || []).map(function (m) {
    return { text: m.text, initiator: m.initiator, messageId: m.messageId };
  }).concat([{ text: call.text, initiator: call.initiator, messageId: call.messageId }]);
}

VENDORS.forEach(function (vendor) {
  test(vendor + ": a message the operator queued into a running loop is its own human message and record, and the iteration stays the loop", function () {
    return inWorld(vendor, function (w) {
      return withLoopEngine(w, vendor, 2, function (loop) {
        loop.engine.startLoop({ maxIterations: 2 });
        assert.equal(w.calls.length, 1);
        assert.deepEqual(w.calls[0].leadMessages, []);
        var ws = { _clagenticUser: { id: "user-1", displayName: "Operator One" } };
        loop.engine.handleLoopMessage(ws, { type: "loop_message", text: "also check the docs" });
        loop.engine.handleLoopMessage(ws, { type: "loop_message", text: "and the tests" });
        // The first iteration ends; the next one starts at the boundary.
        loop.sessions[0].onQueryComplete(loop.sessions[0]);
        loop.fireDelay(1000);
        assert.equal(w.calls.length, 2);

        var call = w.calls[1];
        assert.equal(call.initiator, INITIATORS.LOOP, "the iteration keeps the loop initiator");
        assert.equal(call.text, "Do the task.", "the operator words are not merged into the iteration message");
        assert.deepEqual(call.leadMessages.map(function (m) { return [m.text, m.initiator]; }),
          [["also check the docs", INITIATORS.HUMAN], ["and the tests", INITIATORS.HUMAN]]);

        var recs = w.messages("sess-loop-2");
        assert.equal(recs.length, 3, "a record for each of the two operator messages and one for the iteration");
        assert.deepEqual(recs.map(function (r) { return r.initiator; }), ["human", "human", "loop"]);
        assert.equal(recs[0].senderName, "Operator One");
        assert.equal(recs[0].senderKind, null);
        assert.equal(recs[2].senderKind, "automation");
        assert.equal(recs[2].senderName, "Loop");
        var sentIds = pushedMessages(call).map(function (m) { return m.messageId; });
        assert.deepEqual(recs.map(function (r) { return r.messageId; }), sentIds, "each record joins the message the vendor got");
        assert.equal(new Set(sentIds).size, 3, "every message has its own id");

        var history = loop.sessions[1].history;
        assert.deepEqual(history.map(function (h) { return h.initiator; }), ["human", "human", "loop"]);
        assert.equal(history[0].messageId, sentIds[0]);
        assert.equal(history[2].text.indexOf("also check the docs"), -1, "the iteration entry holds only the loop's own text");

        // Delivered once: the queue is empty for the iteration after.
        assert.deepEqual(loop.engine.loopState.pendingUserMessages, []);
      });
    });
  });
});

test("claude: the queued operator message reaches the vendor with origin human and its own uuid, ahead of the loop iteration", function () {
  return inWorld("claude", function (w) {
    return withLoopEngine(w, "claude", 2, function (loop) {
      loop.engine.startLoop({ maxIterations: 2 });
      loop.engine.handleLoopMessage({}, { type: "loop_message", text: "typed while it ran" });
      loop.sessions[0].onQueryComplete(loop.sessions[0]);
      loop.fireDelay(1000);
      var queue = [];
      var handle = claudeAdapter._test_createQueryHandle({}, queue, null);
      pushedMessages(w.calls[1]).forEach(function (m) { handle.pushMessage(m.text, undefined, m.initiator, m.messageId); });
      assert.equal(queue.length, 2);
      assert.deepEqual(queue[0].origin, { kind: "human" });
      assert.equal("client_composed" in queue[0], false);
      assert.equal(queue[0].message.content[0].text, "typed while it ran");
      assert.equal(queue[0].uuid, w.messages("sess-loop-2")[0].messageId);
      assert.equal(queue[1].origin.fireReason, "loop");
      assert.equal(queue[1].uuid, w.messages("sess-loop-2")[1].messageId);
    });
  });
});

test("codex: the queued operator message starts its own turn, joined to its own message id, ahead of the loop iteration", async function () {
  var calls;
  await inWorld("codex", function (w) {
    return withLoopEngine(w, "codex", 2, function (loop) {
      loop.engine.startLoop({ maxIterations: 2 });
      loop.engine.handleLoopMessage({}, { type: "loop_message", text: "typed while it ran" });
      loop.sessions[0].onQueryComplete(loop.sessions[0]);
      loop.fireDelay(1000);
      calls = pushedMessages(w.calls[1]);
    });
  });
  var handle = codexAdapter._test_createCodexQueryHandle(fakeCodexServer(["turn-op", "turn-loop"]), { model: "gpt-5.4" });
  var seen = [];
  var iterator = handle[Symbol.asyncIterator]();
  calls.forEach(function (m) { handle.pushMessage(m.text, null, m.initiator, m.messageId); });
  while (seen.length < 2) {
    var ev = await iterator.next();
    if (ev.value && ev.value.yokeType === "turn_start") seen.push(ev.value);
  }
  handle.close();
  assert.deepEqual(seen.map(function (e) { return [e.messageId, e.turnId]; }),
    [[calls[0].messageId, "turn-op"], [calls[1].messageId, "turn-loop"]]);
  assert.deepEqual(calls.map(function (m) { return m.initiator; }), ["human", "loop"]);
});

// --- plan approval and prompt-response entries in a loop session ---

VENDORS.forEach(function (vendor) {
  test(vendor + ": feedback and a cleared-context plan the operator answers in a loop session are recorded as human", function () {
    return inWorld(vendor, async function (w) {
      var { attachPromptResponses } = require("../lib/project-prompt-responses");
      var { promptsFor } = require("../lib/prompt-registry");
      var noop = function () {};
      var session = w.newSession({ cliSessionId: "sess-loop-plan" });
      session.loop = { active: true, iteration: 1, role: "coder", loopId: "loop_x", name: "daily" };
      w.sm.sessions.set(session.localId, session);
      var responses = attachPromptResponses({
        sm: w.sm, sdk: w.sdk, send: noop, sendTo: noop, sendToSession: noop,
        getSessionForWs: function () { return session; },
        ensureProjectAccessForSession: function () { return null; },
      });
      var feedback = promptsFor(w.sm).open(session, "plan", { toolName: "ExitPlanMode", toolInput: { plan: "p" } }, { toolUseId: "tu-fb" });
      responses.handlePromptMessage({}, { type: "prompt_response", kind: "plan", requestId: feedback.requestId, decision: "deny_with_feedback", feedback: "use make test" });
      await new Promise(function (r) { setTimeout(r, 300); });
      var fresh = promptsFor(w.sm).open(session, "plan", { toolName: "ExitPlanMode", toolInput: { plan: "p" } }, { toolUseId: "tu-clear" });
      responses.handlePromptMessage({}, { type: "prompt_response", kind: "plan", requestId: fresh.requestId, decision: "allow_clear_context", planContent: "step one" });
      var deadline = Date.now() + 5000;
      while (w.calls.length < 2 && Date.now() < deadline) await new Promise(function (r) { setTimeout(r, 50); });

      assert.equal(w.calls.length, 2);
      w.calls.forEach(function (c) { assert.equal(c.initiator, INITIATORS.HUMAN); assert.ok(c.messageId); });
      var feedbackRec = only(w.messages("sess-loop-plan"));
      assert.equal(feedbackRec.initiator, "human");
      assert.equal(feedbackRec.senderKind, null);
      assert.equal(feedbackRec.messageId, w.calls[0].messageId);
      // The cleared-context plan runs in a fresh session once the vendor names it.
      var started = Array.from(w.sm.sessions.values()).filter(function (s) { return s !== session && s.history && s.history.length; });
      assert.equal(started.length, 1);
      assert.equal(started[0].history[0].initiator, INITIATORS.HUMAN);
      assert.equal(started[0].history[0].messageId, w.calls[1].messageId);
      w.assign(started[0], "sess-plan-fresh");
      assert.equal(only(w.messages("sess-plan-fresh")).initiator, "human");
    });
  });
});

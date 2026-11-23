"use strict";
// The outbound ledger records what the console composed itself: a delivered
// scheduled-input firing, each loop turn, and a schedule-input create made over
// the daemon IPC. Every case goes through the real entry point (the scheduled-input
// service, the loop engine, the schedule_input_create handler, the server's nudge
// wrapper) over a real ledger on a temporary directory.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var execFileSync = require("child_process").execFileSync;

var { createOutboundLedger } = require("../lib/outbound-ledger");
var { createSessionInput } = require("../lib/session-input");
var { createScheduledInputService } = require("../lib/scheduled-input/service");
var { handleScheduledInputCommand } = require("../lib/scheduled-input/ipc");
var { createOutboundQuery } = require("../lib/outbound-query");
var { createAnnouncingLedger } = require("../lib/team-traffic-ws");
var fakes = require("./scheduled-input-fakes");
var { removeTempHome } = require("./helpers/remove-temp-home");

var NOW = Date.parse("2026-03-01T18:00:00Z");
var MIN = 60000;

function quiet() {
  return { error: function () {}, warn: function () {}, log: function () {} };
}

function ledgerIn(dir, clock, retentionDays) {
  return createOutboundLedger({
    getBaseDir: function () { return dir; },
    now: clock,
    getRetentionDays: function () { return retentionDays; },
    log: quiet(),
  });
}

// --- A scheduled firing, through the service into the real session-input ---

function scheduledWorld(opts) {
  opts = opts || {};
  var dir = fakes.tmpDir("automation-ledger-");
  var clock = fakes.makeClock(NOW);
  var map = new Map();
  var session = Object.assign({
    localId: 1, cliSessionId: "vendor-1", isProcessing: false, queryInstance: {}, history: [], sentToolResults: {},
    agentName: "worker", sessionName: "night-shift", vendor: "claude",
  }, opts.session);
  map.set(1, session);
  var pushed = [];
  var project = {
    cwd: "/work/p",
    sm: {
      sessions: map,
      defaultVendor: "claude",
      recordHistoryEntry: function (s, e) { s.history.push(e); },
      appendToSessionFile: function () {},
      sendToSession: function () {},
      broadcastSessionList: function () {},
    },
    sdk: {
      startQuery: function () {},
      pushMessage: function (s, text) {
        if (opts.pushThrows) throw new Error("no runtime");
        pushed.push(text);
      },
    },
    onProcessingChanged: function () {},
    getLinuxUserForSession: function () { return opts.linuxUser || null; },
    ensureProjectAccessForSession: function () { return opts.linuxUser || null; },
  };
  var getProject = function (slug) { return slug === "p" ? project : null; };
  var ledger = ledgerIn(path.join(dir, "data"), clock.now, opts.retentionDays);
  var input = createSessionInput({ getProject: getProject, outboundLedger: ledger, now: clock.now });
  var service = createScheduledInputService({
    dir: path.join(dir, "sched"), getProject: getProject, sessionInput: input,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  service.attachProject("p");
  var records = require("../lib/scheduled-input/records");
  function arm(extra) {
    return service.create("p", Object.assign({
      target: records.targetOf(session), session: session, kind: "once", text: "check the queue", note: "scheduled message",
      createdBy: "planner@alpha", at: clock.now() + 10 * MIN,
    }, extra));
  }
  return {
    dir: dir, clock: clock, session: session, service: service, ledger: ledger, input: input, arm: arm, pushed: pushed,
    cleanup: function () { service.stop(); fakes.removeDir(dir); },
  };
}

test("a delivered scheduled firing leaves one automation entry in the existing shape, and the history entry is as before", async function () {
  var w = scheduledWorld();
  try {
    var made = w.arm();
    await w.clock.advance(10 * MIN);
    var entries = w.ledger.readAutomation();
    assert.equal(entries.length, 1);
    var e = entries[0];
    var h = w.session.history[0];
    assert.equal(e.verb, "send_input");
    assert.equal(e.result, "delivered");
    assert.equal(e.initiator, "scheduled");
    assert.equal(e.prompt, "check the queue");
    assert.equal(e.contextNote, "scheduled message");
    assert.equal(e.messageId, h.messageId);
    assert.ok(e.messageId);
    assert.deepEqual({ kind: e.sender.kind, attribution: e.sender.attribution, name: e.sender.name }, { kind: "automation", attribution: "console", name: "Scheduled message" });
    assert.deepEqual(e.target, { project: "p", sessionId: "1", cliSessionId: "vendor-1", agent: "worker", vendor: "claude", name: "night-shift", runsAs: "daemon" });
    assert.equal(e.scheduledInput.id, made.record.id);
    assert.equal(e.scheduledInput.createdBy, "planner@alpha");
    // The history entry is the one fireScheduled always recorded.
    assert.equal(h.initiator, "scheduled");
    assert.equal(h.senderKind, "automation");
    assert.equal(h.fromName, "Scheduled message");
    assert.equal(h.contextNote, "scheduled message");
    assert.equal("scheduledInput" in h, false);
  } finally { w.cleanup(); }
});

test("a send-now firing is recorded with initiator scheduled-now", async function () {
  var w = scheduledWorld();
  try {
    var made = w.arm();
    var out = await w.service.sendNow("p", made.record.id, w.session);
    assert.equal(out.ok, true);
    var entries = w.ledger.readAutomation();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].initiator, "scheduled-now");
    assert.equal(entries[0].sender.name, "Scheduled message");
    assert.equal(entries[0].scheduledInput.id, made.record.id);
  } finally { w.cleanup(); }
});

// One row per answer a firing can get that is not a delivery.
var NOT_DELIVERED_ROWS = [
  { name: "busy: the session is mid-turn", session: { isProcessing: true } },
  { name: "error: the turn cannot be pushed", pushThrows: true },
];

NOT_DELIVERED_ROWS.forEach(function (row) {
  test("a firing answered " + row.name + " writes no ledger entry; the record keeps its own state", async function () {
    var w = scheduledWorld({ session: row.session, pushThrows: row.pushThrows });
    try {
      var made = w.arm();
      await w.clock.advance(10 * MIN);
      assert.deepEqual(w.ledger.readAutomation(), []);
      var listed = w.service.list("p", { state: "any" });
      assert.equal(listed.inputs[0].id, made.record.id);
      assert.notEqual(listed.inputs[0].lastOutcome, "delivered");
    } finally { w.cleanup(); }
  });
});

test("a refused firing writes no ledger entry", function () {
  var w = scheduledWorld();
  try {
    var out = w.input.fireScheduled({ projectSlug: "p", sessionId: "../escape", prompt: "x" });
    assert.equal(out.result, "refused");
    assert.deepEqual(w.ledger.readAutomation(), []);
  } finally { w.cleanup(); }
});

test("a target running as another OS user has its prompt withheld in the automation entry", async function () {
  var w = scheduledWorld({ linuxUser: "svc-user" });
  try {
    w.arm();
    await w.clock.advance(10 * MIN);
    var e = w.ledger.readAutomation()[0];
    assert.equal(e.target.runsAs, "svc-user");
    assert.equal("prompt" in e, false);
    assert.equal("contextNote" in e, false);
    assert.equal(e.promptWithheld, true);
    assert.equal(e.contextNoteWithheld, true);
    assert.match(e.promptWithheldReason, /another OS user/);
  } finally { w.cleanup(); }
});

test("with outboundRetentionDays 0 a firing writes nothing and is still delivered", async function () {
  var w = scheduledWorld({ retentionDays: 0 });
  try {
    w.arm();
    await w.clock.advance(10 * MIN);
    assert.equal(w.pushed.length, 1);
    assert.equal(fs.existsSync(path.join(w.dir, "data", "outbound")), false);
  } finally { w.cleanup(); }
});

// --- Loop turns, through the loop engine ---

function gitInit(dir) {
  var env = Object.assign({}, process.env, {
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com",
  });
  execFileSync("git", ["init", "-q"], { cwd: dir, env: env });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir, env: env });
}

function loopHarness(opts) {
  opts = opts || {};
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "automation-loop-home-"));
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "automation-loop-cwd-"));
  var dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "automation-loop-data-"));
  gitInit(cwd);
  var sessions = new Map();
  var nextId = 1;
  var noop = function () {};
  var ledger = ledgerIn(dataDir, Date.now);
  var ctx = {
    cwd: cwd,
    slug: "test-project",
    sm: {
      sessions: sessions,
      setResolveLoopInfo: noop,
      createSession: function () {
        var s = { localId: nextId++, history: [], loop: {}, isProcessing: false };
        sessions.set(s.localId, s);
        return s;
      },
      saveSessionFile: noop, appendToSessionFile: noop, broadcastSessionList: noop,
      recordHistoryEntry: function (s, e) { s.history.push(e); },
    },
    sdk: { startQuery: noop },
    send: noop, sendTo: noop, sendToSession: noop, pushModule: null, notificationsModule: null,
    getHubSchedules: function () { return []; }, getAllProjectSessions: function () { return []; },
    getStatus: noop,
    getLinuxUserForSession: function () { return opts.linuxUser || null; },
    onProcessingChanged: noop, hydrateImageRefs: noop,
    outboundLedger: opts.outboundLedger || ledger,
  };
  ["../lib/config", "../lib/utils", "../lib/store", "../lib/scheduler", "../lib/project-loop", "../lib/loop-handoff"]
    .forEach(function (m) { delete require.cache[require.resolve(m)]; });
  var orig = process.env.CLAGENTIC_CONSOLE_HOME;
  process.env.CLAGENTIC_CONSOLE_HOME = home;
  var engine;
  try {
    engine = require("../lib/project-loop").attachLoop(ctx);
  } finally {
    if (orig === undefined) delete process.env.CLAGENTIC_CONSOLE_HOME;
    else process.env.CLAGENTIC_CONSOLE_HOME = orig;
  }
  engine.stopTimer();
  var dir = path.join(cwd, ".claude", "loops", "loop_ledger");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "PROMPT.md"), "Do the task.");
  fs.writeFileSync(path.join(dir, "JUDGE.md"), "Judge it.");
  fs.writeFileSync(path.join(dir, "LOOP.json"), JSON.stringify({ maxIterations: 3 }));
  engine.loopState.loopId = "loop_ledger";
  engine.loopState.loopFilesId = "loop_ledger";
  engine.loopState.wizardData = { name: "nightly", loopMode: opts.loopMode || "judge" };
  return {
    engine: engine, ctx: ctx, ledger: ledger, sessions: sessions, dirs: [home, cwd, dataDir],
    // Async: saveLoopState starts a fire-and-forget store write chain that a
    // synchronous handler call leaves in flight; removeTempHome drains it first.
    cleanup: async function () {
      engine.stopClaudeDirWatch();
      for (var d of [home, cwd, dataDir]) await removeTempHome(d);
    },
  };
}

// The loop arms real watchdog timers: clear them all; short retries run at once.
async function withLoop(opts, fn) {
  var origSetTimeout = global.setTimeout;
  var armed = [];
  global.setTimeout = function (f, d) {
    var t = origSetTimeout(f, d > 0 && d <= 2000 ? 1 : d);
    armed.push(t);
    return t;
  };
  var h;
  try {
    h = loopHarness(opts);
    await fn(h);
  } finally {
    global.setTimeout = origSetTimeout;
    armed.forEach(function (t) { clearTimeout(t); });
    if (h) await h.cleanup();
  }
}

function completeIteration(h) {
  var iter = h.sessions.get(h.engine.loopState.currentSessionId);
  iter.history.push({ type: "done", code: 0 });
  iter.onQueryComplete(iter);
}

function turnOf(h, entry) {
  var found = null;
  h.sessions.forEach(function (s) {
    s.history.forEach(function (x) { if (x.messageId === entry.messageId) found = { session: s, history: x }; });
  });
  return found;
}

function checkLoopEntry(h, e, note, prompt) {
  assert.equal(e.verb, "send_input");
  assert.equal(e.result, "delivered");
  assert.equal(e.initiator, "loop");
  assert.deepEqual({ kind: e.sender.kind, attribution: e.sender.attribution, name: e.sender.name }, { kind: "automation", attribution: "console", name: "Loop" });
  assert.equal(e.contextNote, note);
  if (prompt) assert.equal(e.prompt, prompt);
  var turn = turnOf(h, e);
  assert.ok(turn, "the entry names the history entry's message id");
  assert.equal(turn.history.initiator, "loop");
  assert.equal(e.target.project, "test-project");
  assert.equal(e.target.sessionId, String(turn.session.localId));
  assert.equal(e.target.runsAs, "daemon");
}

test("an iteration turn and a judge turn each write one automation entry", async function () {
  await withLoop({}, function (h) {
    h.engine.startLoop({ maxIterations: 3, name: "nightly" });
    var one = h.ledger.readAutomation();
    assert.equal(one.length, 1);
    checkLoopEntry(h, one[0], "nightly · iteration 1", "Do the task.");
    completeIteration(h);
    var two = h.ledger.readAutomation();
    assert.equal(two.length, 2);
    checkLoopEntry(h, two[1], "nightly · judge, iteration 1");
    assert.match(two[1].prompt, /You are a judge/);
  });
});

test("a judge-writing turn and a loop-file crafting turn each write one automation entry", async function () {
  await withLoop({}, function (h) {
    h.engine.handleLoopMessage({}, { type: "ralph_wizard_complete", data: { name: "n", task: "t", loopMode: "judge", mode: "own", promptText: "p", source: "ralph" } });
    h.engine.handleLoopMessage({}, { type: "ralph_wizard_complete", data: { name: "n", task: "t", loopMode: "simple", mode: "draft" } });
    var entries = h.ledger.readAutomation();
    assert.equal(entries.length, 2);
    checkLoopEntry(h, entries[0], "n · writing the judge");
    checkLoopEntry(h, entries[1], "n · crafting the loop files");
  });
});

test("a human message queued into the loop writes no entry; the iteration that delivers it writes its own", async function () {
  await withLoop({ loopMode: "simple" }, async function (h) {
    h.engine.startLoop({ maxIterations: 2, name: "nightly" });
    h.engine.handleLoopMessage({}, { type: "loop_message", text: "check the staging logs" });
    completeIteration(h);
    await new Promise(function (r) { setTimeout(r, 40); });
    var entries = h.ledger.readAutomation();
    assert.deepEqual(entries.map(function (e) { return e.contextNote; }), ["nightly · iteration 1", "nightly · iteration 2"]);
    entries.forEach(function (e) { assert.equal(e.initiator, "loop"); });
    var delivered = [];
    h.sessions.forEach(function (s) { s.history.forEach(function (x) { if (x.initiator === "human") delivered.push(x.text); }); });
    assert.deepEqual(delivered, ["check the staging logs"], "the message reached the next iteration as a human turn");
  });
});

test("a loop turn on a target running as another OS user has its prompt withheld", async function () {
  await withLoop({ linuxUser: "svc-user" }, function (h) {
    h.engine.startLoop({ maxIterations: 3, name: "nightly" });
    var e = h.ledger.readAutomation()[0];
    assert.equal(e.target.runsAs, "svc-user");
    assert.equal(e.promptWithheld, true);
    assert.equal("prompt" in e, false);
  });
});

// A synchronous handler call starts saveLoopState's fire-and-forget store write
// chain; the harness teardown must outlast it, leaving every directory gone.
test("the loop harness teardown after a synchronous handler that saves loop state leaves no directory behind", async function () {
  var dirs;
  await withLoop({}, function (h) {
    dirs = h.dirs;
    h.engine.handleLoopMessage({}, { type: "ralph_wizard_complete", data: { name: "n", task: "t", loopMode: "simple", mode: "draft" } });
  });
  dirs.forEach(function (d) { assert.equal(fs.existsSync(d), false, d + " was removed"); });
});

// --- schedule-input create, through the daemon's IPC handler ---

function createWorld() {
  var dir = fakes.tmpDir("automation-create-");
  var clock = fakes.makeClock(NOW);
  var caller = fakes.makeSession(3, "vendor-caller", { isProcessing: true, agentName: "planner", vendor: "claude" });
  var target = fakes.makeSession(1, "vendor-target", { agentName: "reviewer", vendor: "claude" });
  var project = fakes.makeProject("/work/alpha", [target, caller]);
  project.getLinuxUserForSession = function () { return null; };
  var getProject = function (slug) { return slug === "alpha" ? project : null; };
  var service = createScheduledInputService({
    dir: path.join(dir, "sched"), getProject: getProject, sessionInput: fakes.makeSessionInput(project),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  service.attachProject("alpha");
  var ledger = ledgerIn(path.join(dir, "data"), clock.now);
  var deps = { service: service, getProject: getProject, ledger: ledger, now: clock.now };
  return {
    dir: dir, ledger: ledger, service: service, target: target,
    create: function (extra) {
      return handleScheduledInputCommand(deps, Object.assign({ cmd: "schedule_input_create", projectSlug: "alpha", sessionId: "vendor-target", prompt: "ping", at: NOW + 10 * MIN }, extra));
    },
    cleanup: function () { service.stop(); fakes.removeDir(dir); },
  };
}

function everything(ledger) {
  return ledger.readAttributed().concat(ledger.readUnattributed());
}

test("a create from a console session is one entry under that session: sender, target, record id, kind and timing", async function () {
  var w = createWorld();
  try {
    var out = await w.create({ senderProject: "alpha", senderSessionId: "3" });
    assert.equal(out.result, "scheduled");
    var entries = everything(w.ledger);
    assert.equal(entries.length, 1);
    var e = entries[0];
    assert.equal(e.verb, "schedule_input_create");
    assert.equal(e.result, "scheduled");
    assert.equal(e.sender.kind, "extracted");
    assert.equal(e.sender.attribution, "extracted");
    assert.equal(e.sender.cliSessionId, "vendor-caller");
    assert.equal(e.sender.name, "planner@alpha");
    assert.equal(e.target.project, "alpha");
    assert.equal(e.target.cliSessionId, "vendor-target");
    assert.equal(e.target.sessionId, "1");
    assert.equal(e.scheduledInput.id, out.record.id);
    assert.equal(e.scheduledInput.kind, "once");
    assert.equal(e.scheduledInput.at, NOW + 10 * MIN);
    assert.equal(e.prompt, "ping");

    var query = createOutboundQuery({ ledger: w.ledger, access: { canReadPrompt: function () { return { allowed: true }; } }, caller: { user: null, authenticated: true } });
    var listed = query.list({ sessionId: "vendor-caller" });
    assert.equal(listed.count, 1);
    assert.equal(listed.messages[0].kind, "schedules");
    assert.equal(listed.messages[0].verb, "schedule_input_create");
    assert.equal(query.list({ sessionId: "vendor-caller", kind: "schedules" }).count, 1);
    assert.equal(query.list({ sessionId: "vendor-caller", kind: "sent" }).count, 0);
  } finally { w.cleanup(); }
});

test("a recurring create records the repeat and its end", async function () {
  var w = createWorld();
  try {
    var out = await w.create({ at: undefined, every: 10 * MIN, count: 3, senderProject: "alpha", senderSessionId: "3" });
    assert.equal(out.result, "scheduled");
    var e = everything(w.ledger)[0];
    assert.equal(e.scheduledInput.kind, "recurring");
    assert.equal(e.scheduledInput.every, 10 * MIN);
    assert.equal(e.scheduledInput.count, 3);
  } finally { w.cleanup(); }
});

test("a create from the plain CLI is filed as an unnamed sender, as send-input files one", async function () {
  var w = createWorld();
  try {
    await w.create({});
    assert.equal(w.ledger.readAttributed().length, 0);
    var entries = w.ledger.readUnattributed();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].sender.kind, "undeclared");
    assert.equal(entries[0].sender.attribution, "unverified");
    assert.equal(entries[0].scheduledInput.id !== undefined, true);
    assert.ok(fs.existsSync(path.join(w.dir, "data", "outbound", "unattributed", "undeclared", "undeclared.jsonl")));
  } finally { w.cleanup(); }
});

// One row per way a create is refused: each is one entry with the reason.
var REFUSED_CREATE_ROWS = [
  { name: "no project", extra: { projectSlug: undefined }, reason: /project is required/ },
  { name: "no prompt", extra: { prompt: "" }, reason: /prompt/ },
  { name: "no time", extra: { at: undefined }, reason: /time to send at/ },
  { name: "an unknown session", extra: { sessionId: "vendor-nobody" }, reason: /no session/ },
  { name: "an unknown project", extra: { projectSlug: "gamma" }, reason: /unknown project/ },
  { name: "a time more than a year ahead", extra: { at: NOW + 400 * 24 * 60 * MIN }, reason: /366 days/ },
];

REFUSED_CREATE_ROWS.forEach(function (row) {
  test("a create refused for " + row.name + " is one entry with the reason, under the caller", async function () {
    var w = createWorld();
    try {
      var out = await w.create(Object.assign({ senderProject: "alpha", senderSessionId: "3" }, row.extra));
      assert.equal(out.ok, false);
      var entries = everything(w.ledger);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].verb, "schedule_input_create");
      assert.notEqual(entries[0].result, "scheduled");
      assert.match(entries[0].reason, row.reason);
      assert.equal(entries[0].sender.cliSessionId, "vendor-caller");
      assert.equal(entries[0].scheduledInput, undefined);
    } finally { w.cleanup(); }
  });
});

test("a create with the ledger off still answers, and writes nothing", async function () {
  var w = createWorld();
  try {
    var off = ledgerIn(path.join(w.dir, "off"), function () { return NOW; }, 0);
    var out = await handleScheduledInputCommand({ service: w.service, getProject: function () { return null; }, ledger: off, now: function () { return NOW; } },
      { cmd: "schedule_input_create", projectSlug: "alpha", sessionId: "vendor-target", prompt: "ping", at: NOW + 10 * MIN });
    assert.equal(out.result, "scheduled");
    assert.equal(fs.existsSync(path.join(w.dir, "off")), false);
  } finally { w.cleanup(); }
});

// --- list-outbound never shows automation entries (AC6) ---

test("automation entries are neither a session's calls nor in the unattributed list", async function () {
  var w = scheduledWorld();
  try {
    w.arm();
    await w.clock.advance(10 * MIN);
    assert.equal(w.ledger.readAutomation().length, 1);
    var query = createOutboundQuery({ ledger: w.ledger, access: { canReadPrompt: function () { return { allowed: true }; } }, caller: { user: null, authenticated: true } });
    var listed = query.list({ sessionId: "vendor-1" });
    assert.equal(listed.count, 0);
    assert.equal(listed.unattributedCount, 0);
    assert.deepEqual(w.ledger.readAttributed(), []);
    assert.deepEqual(w.ledger.readUnattributed(), []);
  } finally { w.cleanup(); }
});

// --- The server's nudge wrapper: one nudge per turn, through outboundEntry.VERB ---

test("the live view is nudged once for a scheduled firing, a loop turn, a send-input and an open-session and a schedule-input create",async function () {
  var dir = fakes.tmpDir("automation-nudge-");
  try {
    var nudges = 0;
    var clock = function () { return NOW; };
    var ledger = ledgerIn(dir, clock);
    var announcing = createAnnouncingLedger({ ledger: ledger, notifier: { notify: function () { nudges++; } } });

    // A scheduled firing and a send-input and an open-session, through one session-input.
    var map = new Map();
    var target = { localId: 1, cliSessionId: "vendor-1", isProcessing: false, queryInstance: {}, history: [], sentToolResults: {}, agentName: "worker" };
    map.set(1, target);
    var nextId = 40;
    var project = {
      cwd: "/work/p",
      sm: {
        sessions: map, defaultVendor: "claude",
        createSession: function (o) { var s = { localId: nextId++, history: [], vendor: o.vendor || null, cliSessionId: null }; map.set(s.localId, s); return s; },
        saveSessionFile: function () {}, deleteSession: function () {},
        recordHistoryEntry: function (s, e) { s.history.push(e); }, appendToSessionFile: function () {},
        sendToSession: function () {}, broadcastSessionList: function () {},
      },
      sdk: { startQuery: function () {}, pushMessage: function () {} },
      onProcessingChanged: function () {},
      getLinuxUserForSession: function () { return null; },
      ensureProjectAccessForSession: function () { return null; },
    };
    var input = createSessionInput({ getProject: function (slug) { return slug === "p" ? project : null; }, outboundLedger: announcing, now: clock });

    assert.equal(input.fireScheduled({ projectSlug: "p", sessionId: "vendor-1", prompt: "tick", note: "scheduled message" }).ok, true);
    assert.equal(nudges, 1, "one nudge for the firing");
    target.isProcessing = false;
    assert.equal(input.sendInput({ projectSlug: "p", sessionId: "vendor-1", prompt: "hello" }).result, "delivered");
    assert.equal(nudges, 2, "one nudge for the send-input");
    assert.equal(input.openSession({ projectSlug: "p", prompt: "start" }).result, "opened");
    assert.equal(nudges, 3, "one nudge for the open-session");
    // A busy firing writes nothing and so nudges nothing.
    target.isProcessing = true;
    assert.equal(input.fireScheduled({ projectSlug: "p", sessionId: "vendor-1", prompt: "tick" }).result, "busy");
    assert.equal(nudges, 3);

    // A loop turn, through the loop engine given the same wrapper.
    await withLoop({ outboundLedger: announcing }, function (h) {
      var before = nudges;
      h.engine.startLoop({ maxIterations: 3, name: "nightly" });
      assert.equal(nudges - before, 1, "one nudge for the loop turn");
    });

    // A schedule-input create arms a schedule the view lists as pending: one nudge.
    var before = nudges;
    var cw = createWorld();
    try {
      await handleScheduledInputCommand({ service: cw.service, getProject: function () { return null; }, ledger: announcing, now: clock },
        { cmd: "schedule_input_create", projectSlug: "alpha", sessionId: "vendor-target", prompt: "ping", at: NOW + 10 * MIN });
    } finally { cw.cleanup(); }
    assert.equal(nudges - before, 1, "one nudge for the create");
  } finally { fakes.removeDir(dir); }
});

test("the server filter names verbs only through outboundEntry.VERB", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "lib", "team-traffic-ws.js"), "utf8");
  assert.doesNotMatch(src, /["'](send_input|open_session)["']/);
  var server = fs.readFileSync(path.join(__dirname, "..", "lib", "server.js"), "utf8");
  assert.doesNotMatch(server, /entry\.verb === ["']/);
  assert.doesNotMatch(server, /onAutomationInjected/);
});

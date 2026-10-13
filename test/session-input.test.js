var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { createSessionInput, resolveInitiator, ACCEPTED_INITIATORS } = require("../lib/session-input");
var { attachExternalTrigger } = require("../lib/project-external-trigger");
var { parseSessionArgs } = require("../lib/cli/session-subcommands");

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// A project context with just what session-input.js touches. `existing` are
// sessions already in memory; `stored` maps a session id to what the store
// would resume it as.
function makeProject(opts) {
  opts = opts || {};
  var calls = { created: [], start: [], push: [], resumed: [], recorded: [] };
  var nextId = 1;
  var sm = {
    sessions: new Map(),
    sessionsDir: opts.sessionsDir,
    defaultVendor: "claude",
    createSession: function (o) {
      calls.created.push(o);
      var s = { localId: nextId++, history: [], vendor: o.vendor || null, agentName: o.agentName || null, cliSessionId: opts.assignId ? "cli-new" : null };
      sm.sessions.set(s.localId, s);
      return s;
    },
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    recordHistoryEntry: function (s, e) { s.history.push(e); calls.recorded.push(e); },
    appendToSessionFile: function () {},
    resumeSession: function (id, o) {
      calls.resumed.push({ id: id, opts: o });
      var s = { localId: nextId++, cliSessionId: id, history: [], vendor: o.vendor || null, agentName: o.agentName || null };
      sm.sessions.set(s.localId, s);
      return s;
    },
  };
  (opts.existing || []).forEach(function (s) { sm.sessions.set(s.localId, s); });
  return {
    calls: calls,
    cwd: "/unused",
    sm: sm,
    adapter: {
      getSessionInfo: function (id) { return Promise.resolve(opts.vendorStore && opts.vendorStore[id] ? { summary: "from vendor" } : undefined); },
    },
    sdk: {
      startQuery: function (s, text, images, user, initiator) { calls.start.push({ localId: s.localId, text: text, initiator: initiator }); },
      pushMessage: function (s, text, images, initiator) { calls.push.push({ localId: s.localId, text: text, initiator: initiator }); },
    },
    onProcessingChanged: function () {},
    getLinuxUserForSession: function () { return null; },
  };
}

function makeInput(project, extra) {
  return createSessionInput(Object.assign({
    getProject: function (slug) { return slug === "p" ? project : null; },
    agentCatalog: function () { return [{ name: "holden" }]; },
  }, extra || {}));
}

function liveSession() {
  return { localId: 100, cliSessionId: "cli-live", history: [], isProcessing: false, queryInstance: {} };
}

// ---- initiator ruling ----

test("initiator: absent is trigger; the four automated kinds are accepted", function () {
  assert.equal(resolveInitiator(undefined).initiator, "trigger");
  assert.equal(resolveInitiator(null).initiator, "trigger");
  assert.deepEqual(ACCEPTED_INITIATORS.slice().sort(), ["loop", "scheduled", "scheduled-now", "trigger"]);
  ACCEPTED_INITIATORS.forEach(function (k) { assert.equal(resolveInitiator(k).initiator, k); });
});

test("initiator: human and unknown values are refused and named", function () {
  var human = resolveInitiator("human").refusal;
  assert.equal(human.result, "refused");
  assert.match(human.reason, /"human"/);
  var unknown = resolveInitiator("operator").refusal;
  assert.match(unknown.reason, /"operator"/);
  assert.match(resolveInitiator(7).refusal.reason, /"7"/);
});

// ---- send-input ----

test("send: a live session gets the input as its next turn with the stated initiator", function () {
  var project = makeProject({ existing: [liveSession()] });
  var r = makeInput(project).sendInput({ projectSlug: "p", sessionId: "cli-live", prompt: "hi", initiator: "loop" });
  assert.equal(r.result, "delivered");
  assert.equal(r.sessionId, "cli-live");
  assert.deepEqual(project.calls.push, [{ localId: 100, text: "hi", initiator: "loop" }]);
  assert.equal(project.calls.start.length, 0);
  assert.equal(project.calls.recorded[0].initiator, "loop");
});

test("send: no initiator is recorded as trigger", function () {
  var project = makeProject({ existing: [liveSession()] });
  makeInput(project).sendInput({ projectSlug: "p", sessionId: "cli-live", prompt: "hi" });
  assert.equal(project.calls.push[0].initiator, "trigger");
});

test("send: a session whose runtime ended is resumed in place and gets the turn", function () {
  var s = liveSession();
  s.queryInstance = null;
  s.vendor = "codex";
  s.agentName = "holden";
  var project = makeProject({ existing: [s] });
  var r = makeInput(project).sendInput({ projectSlug: "p", sessionId: "cli-live", prompt: "wake", initiator: "scheduled" });
  assert.equal(r.result, "resumed-and-delivered");
  assert.equal(r.vendor, "codex");
  assert.equal(r.agent, "holden");
  assert.deepEqual(project.calls.start, [{ localId: 100, text: "wake", initiator: "scheduled" }]);
  assert.equal(project.calls.push.length, 0);
  assert.equal(s.isProcessing, true);
});

test("send: human and unknown initiators are refused and nothing is delivered", function () {
  var project = makeProject({ existing: [liveSession()] });
  var input = makeInput(project);
  var human = input.sendInput({ projectSlug: "p", sessionId: "cli-live", prompt: "hi", initiator: "human" });
  var odd = input.sendInput({ projectSlug: "p", sessionId: "cli-live", prompt: "hi", initiator: "nope" });
  assert.equal(human.result, "refused");
  assert.match(human.reason, /human/);
  assert.match(odd.reason, /nope/);
  assert.equal(project.calls.push.length + project.calls.start.length, 0);
});

test("send: bad requests are refused", function () {
  var project = makeProject({});
  var input = makeInput(project);
  assert.equal(input.sendInput({ projectSlug: "p", sessionId: "x", prompt: "" }).result, "refused");
  assert.equal(input.sendInput({ projectSlug: "p", prompt: "hi" }).result, "refused");
  var unknownProject = input.sendInput({ projectSlug: "zzz", sessionId: "x", prompt: "hi" });
  assert.equal(unknownProject.result, "refused");
  assert.match(unknownProject.reason, /zzz/);
});

test("send: an id that exists nowhere is not-found, including ids that could escape the store", async function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-si-"));
  try {
    var project = makeProject({ sessionsDir: dir });
    var input = makeInput(project);
    var r = await input.sendInput({ projectSlug: "p", sessionId: "missing", prompt: "hi" });
    assert.equal(r.result, "not-found");
    assert.match(r.reason, /missing/);
    var traversal = await input.sendInput({ projectSlug: "p", sessionId: "../../etc/passwd", prompt: "hi" });
    assert.equal(traversal.result, "not-found");
    assert.equal(project.calls.resumed.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("send: a stored session not in memory is resumed on its own vendor and agent", async function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-si-"));
  try {
    fs.writeFileSync(path.join(dir, "cli-stored.jsonl"), [
      JSON.stringify({ type: "meta", cliSessionId: "cli-stored", title: "old", vendor: "codex", agentName: "holden", sessionVisibility: "private" }),
      JSON.stringify({ type: "user_message", text: "earlier" }),
    ].join("\n") + "\n");
    var project = makeProject({ sessionsDir: dir });
    var r = await makeInput(project).sendInput({ projectSlug: "p", sessionId: "cli-stored", prompt: "again", initiator: "trigger" });
    assert.equal(r.result, "resumed-and-delivered");
    assert.equal(r.vendor, "codex");
    assert.equal(r.agent, "holden");
    var resume = project.calls.resumed[0];
    assert.equal(resume.opts.vendor, "codex");
    assert.equal(resume.opts.agentName, "holden");
    assert.equal(resume.opts.sessionVisibility, "private");
    assert.equal(resume.opts.activate, false, "injected input does not move the clients' view");
    assert.deepEqual(resume.opts.history, [{ type: "user_message", text: "earlier" }]);
    assert.deepEqual(project.calls.start.map(function (c) { return c.text + ":" + c.initiator; }), ["again:trigger"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("send: a session only the vendor's store knows is resumed too", async function () {
  var project = makeProject({ vendorStore: { "cli-vendor": true } });
  var r = await makeInput(project, { readHistory: function () { return Promise.resolve([]); } }).sendInput({ projectSlug: "p", sessionId: "cli-vendor", prompt: "hi" });
  assert.equal(r.result, "resumed-and-delivered");
  assert.equal(project.calls.resumed[0].id, "cli-vendor");
});

// ---- open-session ----

test("open: default is today's default vendor and no agent; the initiator defaults to trigger", function () {
  var project = makeProject({});
  var r = makeInput(project).openSession({ projectSlug: "p", prompt: "go" });
  assert.equal(r.result, "opened");
  assert.deepEqual(project.calls.created, [{}]);
  assert.equal(r.vendor, "claude");
  assert.equal(r.agent, null);
  assert.deepEqual(project.calls.start.map(function (c) { return c.text + ":" + c.initiator; }), ["go:trigger"]);
});

test("open: vendor, agent and visibility reach createSession as the browser path passes them", function () {
  var project = makeProject({});
  var r = makeInput(project).openSession({ projectSlug: "p", prompt: "go", vendor: "codex", agentName: "holden", sessionVisibility: "private", initiator: "scheduled-now" });
  assert.equal(r.result, "opened");
  assert.deepEqual(project.calls.created, [{ vendor: "codex", agentName: "holden", sessionVisibility: "private" }]);
  assert.equal(r.vendor, "codex");
  assert.equal(r.agent, "holden");
  assert.equal(project.calls.start[0].initiator, "scheduled-now");
});

test("open: unknown vendor, agent, visibility and initiator are refused by name, and no session is made", function () {
  var project = makeProject({});
  var input = makeInput(project);
  var vendor = input.openSession({ projectSlug: "p", prompt: "go", vendor: "gemini-x" });
  var agent = input.openSession({ projectSlug: "p", prompt: "go", agentName: "nobody" });
  var vis = input.openSession({ projectSlug: "p", prompt: "go", sessionVisibility: "world" });
  var init = input.openSession({ projectSlug: "p", prompt: "go", initiator: "human" });
  [[vendor, /gemini-x/], [agent, /nobody/], [vis, /world/], [init, /human/]].forEach(function (pair) {
    assert.equal(pair[0].result, "refused");
    assert.match(pair[0].reason, pair[1]);
  });
  assert.equal(project.calls.created.length, 0);
  assert.equal(project.calls.start.length, 0);
});

test("open: waits for the vendor-assigned session id when asked to", async function () {
  var project = makeProject({});
  var input = makeInput(project, { sessionIdWaitMs: 1000 });
  var pending = input.openSession({ projectSlug: "p", prompt: "go" });
  assert.ok(pending && typeof pending.then === "function");
  await sleep(120);
  project.sm.sessions.forEach(function (s) { s.cliSessionId = "cli-assigned"; });
  var r = await pending;
  assert.equal(r.sessionId, "cli-assigned");
});

test("open: reports a null id when the vendor has not assigned one in time", async function () {
  var project = makeProject({});
  var r = await makeInput(project, { sessionIdWaitMs: 100 }).openSession({ projectSlug: "p", prompt: "go" });
  assert.equal(r.result, "opened");
  assert.equal(r.sessionId, null);
  assert.ok(r.localId);
});

// ---- one code path for the file drop and the IPC verbs ----

async function dropAndRead(project, input, trigger) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-si-drop-"));
  try {
    var et = attachExternalTrigger({ triggersDir: dir, sessionInput: input, getProject: function () { return project; } });
    fs.writeFileSync(path.join(dir, trigger.id + ".json"), JSON.stringify(trigger));
    et.startWatcher();
    await sleep(500);
    et.stopWatcher();
    return JSON.parse(fs.readFileSync(path.join(dir, "processed", trigger.id + ".json"), "utf8")).result;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function pick(r) { return { result: r.result, vendor: r.vendor, agent: r.agent, reason: r.reason }; }

test("file drop and IPC verb give matching results for open, send, not-found and refused", async function () {
  var base = { projectSlug: "p", initialPrompt: "go", createdAt: new Date().toISOString() };
  var cases = [
    { drop: { version: 1, id: "open-1", vendor: "codex", agentName: "holden" }, call: function (i) { return i.openSession({ projectSlug: "p", prompt: "go", vendor: "codex", agentName: "holden" }); } },
    { drop: { version: 2, id: "send-1", sessionId: "cli-live", initiator: "loop" }, call: function (i) { return i.sendInput({ projectSlug: "p", sessionId: "cli-live", prompt: "go", initiator: "loop" }); } },
    { drop: { version: 2, id: "gone-1", sessionId: "cli-gone" }, call: function (i) { return i.sendInput({ projectSlug: "p", sessionId: "cli-gone", prompt: "go" }); } },
    { drop: { version: 1, id: "refuse-1", initiator: "human" }, call: function (i) { return i.openSession({ projectSlug: "p", prompt: "go", initiator: "human" }); } },
    { drop: { version: 1, id: "refuse-2", vendor: "gemini-x" }, call: function (i) { return i.openSession({ projectSlug: "p", prompt: "go", vendor: "gemini-x" }); } },
  ];
  for (var c of cases) {
    var dropProject = makeProject({ existing: [liveSession()] });
    var viaDrop = await dropAndRead(dropProject, makeInput(dropProject), Object.assign({}, base, c.drop));
    var ipcProject = makeProject({ existing: [liveSession()] });
    var viaIpc = await c.call(makeInput(ipcProject));
    assert.deepEqual(pick(viaDrop), pick(viaIpc), c.drop.id);
    assert.deepEqual(dropProject.calls.start, ipcProject.calls.start, c.drop.id);
    assert.deepEqual(dropProject.calls.push, ipcProject.calls.push, c.drop.id);
  }
});

test("file drop: a reaped session is resumed, not left waiting", async function () {
  var s = liveSession();
  s.queryInstance = null;
  var project = makeProject({ existing: [s] });
  var result = await dropAndRead(project, makeInput(project), {
    version: 2, id: "reaped-1", projectSlug: "p", initialPrompt: "wake", sessionId: "cli-live", createdAt: new Date().toISOString(),
  });
  assert.equal(result.result, "resumed-and-delivered");
  assert.equal(project.calls.start[0].initiator, "trigger");
});

// ---- CLI argument parsing ----

test("cli: open-session and send-input parse their flags", function () {
  var open = parseSessionArgs("open-session", ["--project", "p", "--prompt", "go", "--vendor", "codex", "--agent", "holden", "--visibility", "private", "--initiator", "loop", "--context-note", "n"]);
  assert.deepEqual(open.request, { projectSlug: "p", prompt: "go", vendor: "codex", agentName: "holden", sessionVisibility: "private", initiator: "loop", contextNote: "n" });
  var send = parseSessionArgs("send-input", ["--project", "p", "--session", "abc", "--prompt", "-"]);
  assert.deepEqual(send.request, { projectSlug: "p", sessionId: "abc", prompt: "-" });
});

test("cli: missing, unknown and misplaced flags are errors", function () {
  assert.match(parseSessionArgs("open-session", ["--project", "p"]).error, /--prompt/);
  assert.match(parseSessionArgs("send-input", ["--project", "p", "--prompt", "x"]).error, /--session/);
  assert.match(parseSessionArgs("send-input", ["--project", "p", "--session", "a", "--prompt", "x", "--vendor", "codex"]).error, /--vendor/);
  assert.match(parseSessionArgs("open-session", ["--bogus", "1"]).error, /--bogus/);
  assert.match(parseSessionArgs("open-session", ["--project"]).error, /Missing value/);
  assert.match(parseSessionArgs("open-session", ["constructor"]).error, /constructor/);
});

// ---- real session manager: resume keeps vendor and agent ----

test("resume through a real session manager restores vendor and agent and does not switch clients", async function () {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-si-real-"));
  var origHome = process.env.CLAGENTIC_HOME;
  var origConsoleHome = process.env.CLAGENTIC_CONSOLE_HOME;
  try {
    ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) { delete require.cache[require.resolve(m)]; });
    process.env.CLAGENTIC_CONSOLE_HOME = home;
    delete process.env.CLAGENTIC_HOME;
    var sessionsModule = require("../lib/sessions");
    function newManager() {
      return sessionsModule.createSessionManager({ cwd: home, send: function () {}, sendTo: function () {}, sendEach: function () {} });
    }
    var sm1 = newManager();
    var made = sm1.createSessionRaw({ vendor: "codex", agentName: "holden", sessionVisibility: "private" });
    made.cliSessionId = "cli-real-1";
    made.title = "stored";
    sm1.saveSessionFile(made);

    var sm = newManager();
    sm.sessions.clear();
    sm.createSession({});
    var activeBefore = sm.getActiveSession();
    assert.ok(activeBefore);
    var started = [];
    var project = {
      cwd: home, sm: sm, adapter: null,
      sdk: { startQuery: function (s, t, i, u, initiator) { started.push({ session: s, initiator: initiator }); }, pushMessage: function () { throw new Error("no runtime to push into"); } },
      onProcessingChanged: function () {}, getLinuxUserForSession: function () { return null; },
    };
    var r = await createSessionInput({ getProject: function () { return project; } }).sendInput({ projectSlug: "p", sessionId: "cli-real-1", prompt: "hi", initiator: "scheduled" });
    assert.equal(r.result, "resumed-and-delivered");
    assert.equal(r.vendor, "codex");
    assert.equal(r.agent, "holden");
    assert.equal(started.length, 1);
    assert.equal(started[0].initiator, "scheduled");
    assert.equal(started[0].session.sessionVisibility, "private");
    assert.equal(sm.getActiveSession(), activeBefore, "the clients' active session did not move");
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME; else process.env.CLAGENTIC_HOME = origHome;
    if (origConsoleHome === undefined) delete process.env.CLAGENTIC_CONSOLE_HOME; else process.env.CLAGENTIC_CONSOLE_HOME = origConsoleHome;
    ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) { delete require.cache[require.resolve(m)]; });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// A failure is reported as a failure: never as success, never as not-found.
// Covers lib/session-input.js and
// lib/session-resume.js.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { createSessionInput } = require("../lib/session-input");
var sessionResume = require("../lib/session-resume");

function makeProject(opts) {
  opts = opts || {};
  var calls = { start: [], push: [], resumed: [], recorded: [], processing: [] };
  var nextId = 1;
  var sm = {
    sessions: new Map(),
    sessionsDir: opts.sessionsDir,
    defaultVendor: "claude",
    createSession: function (o) {
      var s = { localId: nextId++, history: [], vendor: o.vendor || null, agentName: o.agentName || null, cliSessionId: null };
      sm.sessions.set(s.localId, s);
      return s;
    },
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    recordHistoryEntry: function (s, e) { s.history.push(e); calls.recorded.push(e); },
    appendToSessionFile: function () {},
    resumeSession: function (id, o) {
      calls.resumed.push({ id: id, opts: o });
      if (opts.managerDeclines) return null;
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
    adapter: { getSessionInfo: opts.getSessionInfo || function () { return Promise.resolve(null); } },
    sdk: {
      startQuery: function (s, text, images, user, initiator) {
        calls.start.push({ localId: s.localId, text: text, initiator: initiator });
        return opts.startQuery ? opts.startQuery(s) : undefined;
      },
      pushMessage: function (s, text, images, initiator) { calls.push.push({ text: text, initiator: initiator }); },
    },
    onProcessingChanged: function () { calls.processing.push(true); },
    getLinuxUserForSession: function () { return null; },
  };
}

function makeInput(project, extra) {
  return createSessionInput(Object.assign({
    getProject: function (slug) { return slug === "p" ? project : null; },
    agentCatalog: function () { return []; },
  }, extra || {}));
}

function idleSession() {
  return { localId: 100, cliSessionId: "cli-idle", history: [], isProcessing: false, queryInstance: null };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-si-fail-"));
}

function metaLine(id) {
  return JSON.stringify({ type: "meta", cliSessionId: id, title: "t", vendor: "codex" });
}

// ---- 2: success only after the query start succeeded ----

test("send: a rejected query start is an error, clears isProcessing and records nothing", async function () {
  var s = idleSession();
  var project = makeProject({ existing: [s], startQuery: function () { return Promise.reject(new Error("no worker")); } });
  var r = await makeInput(project).sendInput({ projectSlug: "p", sessionId: "cli-idle", prompt: "hi" });
  assert.equal(r.result, "error");
  assert.equal(r.ok, false);
  assert.equal(r.retryable, true);
  assert.match(r.reason, /no worker/);
  assert.equal(s.isProcessing, false);
  assert.equal(project.calls.recorded.length, 0, "a failed delivery is not recorded as delivered");
  assert.equal(project.calls.processing.length, 2, "processing was announced, then cleared");
});

test("send: a throwing query start is the same error", async function () {
  var s = idleSession();
  var project = makeProject({ existing: [s], startQuery: function () { throw new Error("sync boom"); } });
  var r = await makeInput(project).sendInput({ projectSlug: "p", sessionId: "cli-idle", prompt: "hi" });
  assert.equal(r.result, "error");
  assert.equal(r.retryable, true);
  assert.equal(s.isProcessing, false);
});

test("send: success is reported only once the query start has resolved", async function () {
  var release;
  var gate = new Promise(function (resolve) { release = resolve; });
  var s = idleSession();
  var project = makeProject({ existing: [s], startQuery: function () { return gate; } });
  var pending = makeInput(project).sendInput({ projectSlug: "p", sessionId: "cli-idle", prompt: "hi" });
  assert.ok(pending && typeof pending.then === "function");
  var settled = false;
  pending.then(function () { settled = true; });
  await new Promise(function (r) { setTimeout(r, 30); });
  assert.equal(settled, false);
  assert.equal(project.calls.recorded.length, 0);
  release();
  var r = await pending;
  assert.equal(r.result, "resumed-and-delivered");
  assert.equal(project.calls.recorded.length, 1);
});

test("open: a rejected query start is an error and clears isProcessing", async function () {
  var project = makeProject({ startQuery: function () { return Promise.reject(new Error("no worker")); } });
  var r = await makeInput(project).openSession({ projectSlug: "p", prompt: "go" });
  assert.equal(r.result, "error");
  assert.equal(r.retryable, true);
  assert.match(r.reason, /no worker/);
  project.sm.sessions.forEach(function (s) { assert.equal(s.isProcessing, false); });
});

test("open: a rejected query start leaves no history entry", async function () {
  var project = makeProject({ startQuery: function () { return Promise.reject(new Error("no worker")); } });
  var r = await makeInput(project).openSession({ projectSlug: "p", prompt: "go" });
  assert.equal(r.result, "error");
  assert.equal(project.calls.recorded.length, 0);
});

test("open: a throwing query start leaves no history entry", function () {
  var project = makeProject({ startQuery: function () { throw new Error("sync boom"); } });
  makeInput(project).openSession({ projectSlug: "p", prompt: "go" });
  assert.equal(project.calls.recorded.length, 0);
});

test("open: the prompt is recorded once, through recordInjected, after the start succeeds", async function () {
  var project = makeProject({ startQuery: function () { return Promise.resolve(); } });
  var r = await makeInput(project).openSession({
    projectSlug: "p", prompt: "go", initiator: "scheduled", triggerId: "trg-1", contextNote: "nightly",
  });
  assert.equal(r.result, "opened");
  assert.equal(project.calls.recorded.length, 1);
  var entry = project.calls.recorded[0];
  assert.equal(entry.text, "go");
  assert.equal(entry.source, "external-trigger");
  assert.equal(entry.initiator, "scheduled");
  assert.equal(entry.triggerId, "trg-1");
  assert.equal(entry.contextNote, "nightly");
});

test("open: a throwing query start is the same error", function () {
  var project = makeProject({ startQuery: function () { throw new Error("sync boom"); } });
  var r = makeInput(project).openSession({ projectSlug: "p", prompt: "go" });
  assert.equal(r.result, "error");
  assert.equal(r.retryable, true);
  project.sm.sessions.forEach(function (s) { assert.equal(s.isProcessing, false); });
});

test("open: opened is reported only after the query start has resolved", async function () {
  var release;
  var gate = new Promise(function (resolve) { release = resolve; });
  var project = makeProject({ startQuery: function () { return gate; } });
  var pending = makeInput(project).openSession({ projectSlug: "p", prompt: "go" });
  var settled = false;
  pending.then(function () { settled = true; });
  await new Promise(function (r) { setTimeout(r, 30); });
  assert.equal(settled, false);
  release();
  assert.equal((await pending).result, "opened");
});

// ---- 3: an adapter lookup failure is not "not found" ----

test("send: an adapter lookup failure is a retryable error, not not-found", async function () {
  var project = makeProject({ getSessionInfo: function () { return Promise.reject(new Error("sdk unavailable")); } });
  var r = await makeInput(project).sendInput({ projectSlug: "p", sessionId: "cli-gone", prompt: "hi" });
  assert.equal(r.result, "error");
  assert.equal(r.retryable, true);
  assert.match(r.reason, /sdk unavailable/);
  assert.equal(project.calls.resumed.length, 0);
  assert.equal(project.calls.start.length, 0);
});

test("send: not-found needs the adapter to report absence positively", async function () {
  var project = makeProject({ getSessionInfo: function () { return Promise.resolve(null); } });
  var r = await makeInput(project).sendInput({ projectSlug: "p", sessionId: "cli-gone", prompt: "hi" });
  assert.equal(r.result, "not-found");
});

test("send: a store file that cannot be read is an error, not not-found", async function () {
  var dir = tempDir();
  try {
    // A directory where the record should be: the read fails with something other than "absent".
    fs.mkdirSync(path.join(dir, "cli-odd.jsonl"));
    var project = makeProject({ sessionsDir: dir });
    var r = await makeInput(project).sendInput({ projectSlug: "p", sessionId: "cli-odd", prompt: "hi" });
    assert.equal(r.result, "error");
    assert.equal(r.retryable, true);
    assert.match(r.reason, /cli-odd/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("send: a session manager that declines to resume a stored session is an error, not not-found", async function () {
  var dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "cli-stored.jsonl"), metaLine("cli-stored") + "\n");
    var project = makeProject({ sessionsDir: dir, managerDeclines: true });
    var r = await makeInput(project).sendInput({ projectSlug: "p", sessionId: "cli-stored", prompt: "hi" });
    assert.equal(r.result, "error");
    assert.match(r.reason, /cli-stored/);
    assert.equal(project.calls.start.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 4: a history-load failure refuses the resume ----

test("send: a failed history load refuses the resume with a retryable error", async function () {
  var project = makeProject({ getSessionInfo: function () { return Promise.resolve({ summary: "from vendor" }); } });
  var input = makeInput(project, { readHistory: function () { return Promise.reject(new Error("disk gone")); } });
  var r = await input.sendInput({ projectSlug: "p", sessionId: "cli-vendor", prompt: "hi" });
  assert.equal(r.result, "error");
  assert.equal(r.retryable, true);
  assert.match(r.reason, /cli-vendor/);
  assert.match(r.reason, /disk gone/);
  assert.equal(project.calls.resumed.length, 0, "no session is resumed on an empty history");
  assert.equal(project.calls.start.length, 0);
});

test("resume: a vendor session resumes with the history that loaded", async function () {
  var project = makeProject({ getSessionInfo: function () { return Promise.resolve({ summary: "vendor title" }); } });
  var history = [{ type: "user_message", text: "earlier" }];
  var session = await sessionResume.resumeStoredSession(
    { sm: project.sm, adapter: project.adapter, cwd: "/unused", readHistory: function () { return Promise.resolve(history); } },
    "cli-vendor", { activate: false });
  assert.ok(session);
  assert.deepEqual(project.calls.resumed[0].opts.history, history);
  assert.equal(project.calls.resumed[0].opts.title, "vendor title");
});

test("cli-sessions: strict history read rejects on a missing file, the default resolves empty", async function () {
  var cliSessions = require("../lib/cli-sessions");
  var id = "no-such-session-" + process.pid;
  await assert.rejects(cliSessions.readCliSessionHistory(os.tmpdir(), id, { strict: true }));
  assert.deepEqual(await cliSessions.readCliSessionHistory(os.tmpdir(), id), []);
});

// ---- 5: any malformed history line refuses the resume ----

test("resume: a malformed final line refuses the resume naming the session and line", async function () {
  var dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "cli-torn.jsonl"), [
      metaLine("cli-torn"),
      JSON.stringify({ type: "user_message", text: "one" }),
      '{"type":"delta","te',
    ].join("\n") + "\n");
    assert.throws(function () { sessionResume.readStoredSession(dir, "cli-torn"); }, /cli-torn.*line 3/);
    var project = makeProject({ sessionsDir: dir });
    var r = await makeInput(project).sendInput({ projectSlug: "p", sessionId: "cli-torn", prompt: "hi" });
    assert.equal(r.result, "error");
    assert.match(r.reason, /cli-torn/);
    assert.match(r.reason, /line 3/);
    assert.equal(project.calls.resumed.length, 0);
    assert.equal(project.calls.start.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: a malformed record before the last line refuses the resume and names the session", async function () {
  var dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "cli-hole.jsonl"), [
      metaLine("cli-hole"),
      JSON.stringify({ type: "user_message", text: "one" }),
      "not json at all",
      JSON.stringify({ type: "delta", text: "three" }),
    ].join("\n") + "\n");
    assert.throws(function () { sessionResume.readStoredSession(dir, "cli-hole"); }, /cli-hole.*line 3/);
    var project = makeProject({ sessionsDir: dir });
    var r = await makeInput(project).sendInput({ projectSlug: "p", sessionId: "cli-hole", prompt: "hi" });
    assert.equal(r.result, "error");
    assert.match(r.reason, /cli-hole/);
    assert.equal(project.calls.resumed.length, 0);
    assert.equal(project.calls.start.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: a damaged meta record refuses the resume", function () {
  var dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "cli-nometa.jsonl"), "garbage\n" + JSON.stringify({ type: "user_message", text: "x" }) + "\n");
    assert.throws(function () { sessionResume.readStoredSession(dir, "cli-nometa"); }, /cli-nometa/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

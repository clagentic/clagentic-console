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
var { attachExternalTrigger } = require("../lib/project-external-trigger");

function makeProject(opts) {
  opts = opts || {};
  var calls = { start: [], push: [], resumed: [], recorded: [], processing: [], deleted: [] };
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
    deleteSession: function (id) { calls.deleted.push(id); sm.sessions.delete(id); },
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

test("open: a rejected query start removes the session it created and is not retryable", async function () {
  var project = makeProject({ startQuery: function () { return Promise.reject(new Error("no worker")); } });
  var r = await makeInput(project).openSession({ projectSlug: "p", prompt: "go" });
  assert.equal(r.result, "error");
  assert.equal(r.ok, false);
  assert.equal(r.retryable, false);
  assert.match(r.reason, /no worker/);
  assert.equal(project.calls.deleted.length, 1);
  assert.equal(project.sm.sessions.size, 0, "no session is left behind");
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

test("open: a throwing query start is the same error and leaves no session", function () {
  var project = makeProject({ startQuery: function () { throw new Error("sync boom"); } });
  var r = makeInput(project).openSession({ projectSlug: "p", prompt: "go" });
  assert.equal(r.result, "error");
  assert.equal(r.retryable, false);
  assert.equal(project.sm.sessions.size, 0);
});

test("file drop: a failed open is archived with its error result and is not retried", async function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-si-drop-"));
  try {
    var project = makeProject({ startQuery: function () { return Promise.reject(new Error("no worker")); } });
    var et = attachExternalTrigger({ triggersDir: dir, sessionInput: makeInput(project), getProject: function () { return project; } });
    fs.writeFileSync(path.join(dir, "fail-1.json"), JSON.stringify({
      version: 1, id: "fail-1", projectSlug: "p", initialPrompt: "go", createdAt: new Date().toISOString(),
    }));
    et.startWatcher();
    await new Promise(function (r) { setTimeout(r, 500); });
    et.stopWatcher();
    var record = JSON.parse(fs.readFileSync(path.join(dir, "processed", "fail-1.json"), "utf8"));
    assert.equal(record.result.result, "error");
    assert.equal(record.result.retryable, false);
    assert.equal(fs.existsSync(path.join(dir, "fail-1.json")), false);
    assert.equal(project.calls.start.length, 1, "started once, never retried");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

// ---- 3: an unreadable store is not "not found" ----

test("send: not-found is the store's positive absence", async function () {
  var dir = tempDir();
  try {
    var project = makeProject({ sessionsDir: dir });
    var r = await makeInput(project).sendInput({ projectSlug: "p", sessionId: "cli-gone", prompt: "hi" });
    assert.equal(r.result, "not-found");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

// ---- 4: a history-load failure refuses the resume (browser resume path) ----

test("resume: a failed vendor history load refuses the resume with a retryable error", async function () {
  var project = makeProject({});
  var adapter = { getSessionInfo: function () { return Promise.resolve({ summary: "from vendor" }); } };
  await assert.rejects(
    sessionResume.resumeStoredSession(
      { sm: project.sm, adapter: adapter, cwd: "/unused", readHistory: function () { return Promise.reject(new Error("disk gone")); } },
      "cli-vendor", { activate: false }),
    function (err) { return err.retryable === true && /cli-vendor/.test(err.message) && /disk gone/.test(err.message); });
  assert.equal(project.calls.resumed.length, 0, "no session is resumed on an empty history");
});

test("resume: a vendor session resumes with the history that loaded", async function () {
  var project = makeProject({});
  var adapter = { getSessionInfo: function () { return Promise.resolve({ summary: "vendor title" }); } };
  var history = [{ type: "user_message", text: "earlier" }];
  var session = await sessionResume.resumeStoredSession(
    { sm: project.sm, adapter: adapter, cwd: "/unused", readHistory: function () { return Promise.resolve(history); } },
    "cli-vendor", { activate: false });
  assert.ok(session);
  assert.deepEqual(project.calls.resumed[0].opts.history, history);
  assert.equal(project.calls.resumed[0].opts.title, "vendor title");
});

test("cli-sessions: the vendor history read resolves empty for a missing file and for an unsafe id", async function () {
  var cliSessions = require("../lib/cli-sessions");
  var id = "no-such-session-" + process.pid;
  assert.deepEqual(await cliSessions.readCliSessionHistory(os.tmpdir(), id), []);
  assert.deepEqual(await cliSessions.readCliSessionHistory(os.tmpdir(), "../../etc/passwd"), []);
  assert.deepEqual(await cliSessions.readCliSessionHistory(os.tmpdir(), "/etc/passwd"), []);
});

// ---- session ids reach the filesystem only after validation ----

var UNSAFE_IDS = ["../x", "../../etc/passwd", "/etc/passwd", "a/b", "a\\b", ".hidden", "", "a\u0000b"];

test("resume: an unsafe id is refused on the browser path before the adapter or any history is touched", async function () {
  var dir = tempDir();
  try {
    for (var i = 0; i < UNSAFE_IDS.length; i++) {
      var project = makeProject({ sessionsDir: dir });
      var touched = [];
      var deps = {
        sm: project.sm, cwd: "/unused",
        adapter: { getSessionInfo: function () { touched.push("adapter"); return Promise.resolve(null); } },
        readHistory: function () { touched.push("history"); return Promise.resolve([]); },
      };
      await assert.rejects(sessionResume.resumeStoredSession(deps, UNSAFE_IDS[i], {}), function (err) {
        return /unsafe session id/.test(err.message) && err.retryable === false;
      });
      assert.deepEqual(touched, []);
      assert.equal(project.calls.resumed.length, 0);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("send: an unsafe id is refused on the injection path, never looked up, resumed or delivered", async function () {
  var dir = tempDir();
  try {
    var project = makeProject({ sessionsDir: dir });
    var input = makeInput(project);
    for (var i = 1; i < UNSAFE_IDS.length; i++) {
      var r = await input.sendInput({ projectSlug: "p", sessionId: UNSAFE_IDS[i], prompt: "hi" });
      assert.equal(r.result, "refused");
    }
    assert.equal(project.calls.resumed.length, 0);
    assert.equal(project.calls.start.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store: a record outside the sessions directory is not read through a traversal id", function () {
  var dir = tempDir();
  try {
    var inner = path.join(dir, "store");
    fs.mkdirSync(inner);
    fs.writeFileSync(path.join(dir, "outside.jsonl"), metaLine("outside") + "\n");
    assert.throws(function () { sessionResume.readStoredSession(inner, "../outside"); }, /unsafe session id/);
    assert.throws(function () { sessionResume.readStoredSession(inner, path.join(dir, "outside")); }, /unsafe session id/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("session-id: a path built from an id stays inside its directory", function () {
  var guard = require("../lib/session-id");
  var dir = tempDir();
  try {
    assert.equal(guard.sessionPathWithin(dir, "abc-1", ".jsonl"), path.join(dir, "abc-1.jsonl"));
    UNSAFE_IDS.forEach(function (id) {
      assert.throws(function () { guard.sessionPathWithin(dir, id, ".jsonl"); }, /unsafe session id/);
    });
    assert.throws(function () { guard.sessionPathWithin(dir, 42, ".jsonl"); }, /unsafe session id/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("session manager: resumeSession declines an unsafe id and never writes outside its directory", function () {
  var home = tempDir();
  var cwd = tempDir();
  var origHome = process.env.CLAGENTIC_CONSOLE_HOME;
  var origLegacyHome = process.env.CLAGENTIC_HOME;
  delete process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_CONSOLE_HOME = home;
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) { delete require.cache[require.resolve(m)]; });
  try {
    var sm = require("../lib/sessions").createSessionManager({ cwd: cwd, send: function () {}, sendTo: function () {}, sendEach: function () {} });
    assert.equal(sm.resumeSession("../escape", {}), null);
    assert.equal(sm.resumeSession("/abs/escape", {}), null);
    assert.equal(fs.existsSync(path.join(home, "escape.jsonl")), false);
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_CONSOLE_HOME; else process.env.CLAGENTIC_CONSOLE_HOME = origHome;
    if (origLegacyHome !== undefined) process.env.CLAGENTIC_HOME = origLegacyHome;
    ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) { delete require.cache[require.resolve(m)]; });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("resume: a history line that parses to null, a scalar, a string or an array refuses the resume naming session and line", async function () {
  var dir = tempDir();
  try {
    var bad = ["null", "42", '"text"', "[1]", "true"];
    for (var i = 0; i < bad.length; i++) {
      var id = "cli-nonobj" + i;
      fs.writeFileSync(path.join(dir, id + ".jsonl"), [
        metaLine(id), JSON.stringify({ type: "user_message", text: "one" }), bad[i],
      ].join("\n") + "\n");
      assert.throws(function () { sessionResume.readStoredSession(dir, id); }, new RegExp(id + ".*line 3.*not a JSON object"));
      var project = makeProject({ sessionsDir: dir });
      var r = await makeInput(project).sendInput({ projectSlug: "p", sessionId: id, prompt: "hi" });
      assert.equal(r.result, "error");
      assert.equal(r.retryable, false);
      assert.match(r.reason, new RegExp(id + ".*line 3"));
      assert.equal(project.calls.resumed.length, 0);
    }
    fs.writeFileSync(path.join(dir, "cli-nullmeta.jsonl"), "null\n");
    assert.throws(function () { sessionResume.readStoredSession(dir, "cli-nullmeta"); }, /cli-nullmeta/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 5: any blank or malformed history line refuses the resume ----

test("resume: exactly one trailing newline is the only tolerated blank", function () {
  var dir = tempDir();
  try {
    var body = [metaLine("cli-ok"), JSON.stringify({ type: "user_message", text: "one" })].join("\n");
    fs.writeFileSync(path.join(dir, "cli-ok.jsonl"), body + "\n");
    assert.equal(sessionResume.readStoredSession(dir, "cli-ok").history.length, 1);
    fs.writeFileSync(path.join(dir, "cli-nonl.jsonl"), body.replace("cli-ok", "cli-nonl"));
    assert.equal(sessionResume.readStoredSession(dir, "cli-nonl").history.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: a blank line, inside the file or a second trailing newline, refuses the resume naming the line", async function () {
  var dir = tempDir();
  try {
    var one = JSON.stringify({ type: "user_message", text: "one" });
    var two = JSON.stringify({ type: "user_message", text: "two" });
    fs.writeFileSync(path.join(dir, "cli-blank.jsonl"), [metaLine("cli-blank"), one, "", two].join("\n") + "\n");
    fs.writeFileSync(path.join(dir, "cli-twonl.jsonl"), [metaLine("cli-twonl"), one].join("\n") + "\n\n");
    assert.throws(function () { sessionResume.readStoredSession(dir, "cli-blank"); }, /cli-blank.*line 3/);
    assert.throws(function () { sessionResume.readStoredSession(dir, "cli-twonl"); }, /cli-twonl.*line 3/);
    var project = makeProject({ sessionsDir: dir });
    var r = await makeInput(project).sendInput({ projectSlug: "p", sessionId: "cli-blank", prompt: "hi" });
    assert.equal(r.result, "error");
    assert.equal(r.retryable, false);
    assert.match(r.reason, /cli-blank.*line 3/);
    assert.equal(project.calls.resumed.length, 0);
    assert.equal(project.calls.start.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

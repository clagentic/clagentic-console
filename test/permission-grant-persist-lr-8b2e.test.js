"use strict";
// Regression tests for lr-8b2e: an "Allow for session" permission grant did
// not survive leaving and returning to a session.
//
// Root cause (MILLER, confidence 0.9): session.allowedTools was written only
// to the in-memory session object and never serialized to durable session
// storage. When the live object no longer exists (daemon restart, or
// resume-by-cliSessionId of a non-live session), Console rebuilds a fresh
// session with empty allowedTools, the server-side auto-approve check at
// lib/sdk-bridge.js:691 misses, and a brand-new permission_request is
// emitted -> the re-prompt on return.
//
// Three-part fix under test:
//   1. persist  — saveSessionFile (lib/sessions.js) writes allowedTools into
//                 the durable per-session meta record when non-empty.
//   2. restore  — loadSessions() and resumeSession() hydrate allowedTools
//                 from persisted state instead of always defaulting to {}.
//   3. flush    — the "allow_always" grant handler in project-sessions.js
//                 calls saveSessionFile() immediately so the grant survives
//                 rehydration even without a later save trigger.
//
// All tests drive real production code (lib/sessions.js, lib/sdk-bridge.js)
// — no inline reimplementations of the persist/restore/auto-approve logic.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { createSDKBridge } = require("../lib/sdk-bridge");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr-8b2e-"));
}

function makeSessionManager(tmpHome) {
  // Bust require cache so a fresh instance picks up the temp CLAGENTIC_HOME.
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  });
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var sessionsModule;
  try {
    sessionsModule = require("../lib/sessions");
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
  return sessionsModule.createSessionManager({
    cwd: tmpHome,
    send: function () {},
    sendTo: function () {},
    sendEach: function () {},
  });
}

// Minimal adapter — handleCanUseTool never reaches the adapter, but
// createSDKBridge expects one to be present in opts.
function makeAdapter() {
  return {
    vendor: "claude",
    createQuery: function () { throw new Error("not used in this test"); },
    init: function () { return Promise.resolve({ models: [], skills: [] }); },
  };
}

function makeBridge(sm) {
  var adapter = makeAdapter();
  return createSDKBridge({
    cwd: "/tmp/test-lr-8b2e",
    slug: "test-lr-8b2e",
    sessionManager: sm,
    send: function () {},
    adapter: adapter,
    adapters: { claude: adapter },
    onProcessingChanged: function () {},
  });
}

// handleCanUseTool's third positional arg is `opts` — a real permission
// request supplies toolUseID and (optionally) an abort signal. Neither is
// touched by the auto-approve early-return path we are testing, but a
// concrete stub keeps this test honest about the real call shape.
function makeOpts() {
  return { toolUseID: "tool-use-1", signal: null };
}

test("lr-8b2e: grant survives loadSessions() rehydration — auto-approve HITS for the granted tool", function () {
  var tmpHome = makeTempHome();
  try {
    var sm1 = makeSessionManager(tmpHome);
    var session = sm1.createSessionRaw({});
    session.cliSessionId = "sess-lr-8b2e-grant";

    // Simulate the "allow_always" grant path (project-sessions.js): the
    // decision handler sets allowedTools then flushes immediately.
    session.allowedTools = {};
    session.allowedTools["Write"] = true;
    sm1.saveSessionFile(session);

    // Simulate the live session object going away (daemon restart) and being
    // rebuilt from durable state via loadSessions().
    var sm2 = makeSessionManager(tmpHome);
    var rebuilt = null;
    sm2.sessions.forEach(function (s) {
      if (s.cliSessionId === "sess-lr-8b2e-grant") rebuilt = s;
    });
    assert.ok(rebuilt, "rebuilt session should be found after rehydration");
    assert.deepEqual(rebuilt.allowedTools, { Write: true },
      "allowedTools must be hydrated from the persisted meta record");

    // Assert the auto-approve early-return at lib/sdk-bridge.js:691 HITS for
    // the granted tool — no new permission_request should be created.
    var bridge = makeBridge(sm2);
    rebuilt.pendingPermissions = {};
    return bridge.handleCanUseTool(rebuilt, "Write", { file_path: "/tmp/x" }, makeOpts()).then(function (result) {
      assert.equal(result.behavior, "allow", "previously granted tool must auto-approve after rehydration");
      assert.equal(Object.keys(rebuilt.pendingPermissions).length, 0,
        "no new permission_request should be created for an already-granted tool");
    });
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-8b2e: a tool that was NEVER granted still prompts after rehydration", function () {
  var tmpHome = makeTempHome();
  try {
    var sm1 = makeSessionManager(tmpHome);
    var session = sm1.createSessionRaw({});
    session.cliSessionId = "sess-lr-8b2e-nogrant";

    // Grant ONLY "Write" — "Edit" is never granted.
    session.allowedTools = {};
    session.allowedTools["Write"] = true;
    sm1.saveSessionFile(session);

    var sm2 = makeSessionManager(tmpHome);
    var rebuilt = null;
    sm2.sessions.forEach(function (s) {
      if (s.cliSessionId === "sess-lr-8b2e-nogrant") rebuilt = s;
    });
    assert.ok(rebuilt, "rebuilt session should be found after rehydration");

    var bridge = makeBridge(sm2);
    rebuilt.pendingPermissions = {};
    // handleCanUseTool's regular-request path never resolves on its own — it
    // waits for a client decision, so we do NOT await it here. Instead we
    // give the microtask queue one tick (matching the makeCtxStub pattern
    // used elsewhere in this suite for unresolved-promise assertions) and
    // then assert a fresh permission_request was enqueued rather than
    // auto-approved.
    bridge.handleCanUseTool(rebuilt, "Edit", { file_path: "/tmp/y" }, makeOpts());
    return new Promise(function (resolve) { setImmediate(resolve); }).then(function () {
      assert.equal(Object.keys(rebuilt.pendingPermissions).length, 1,
        "an ungranted tool must still create a pending permission_request");
      // Drain the async append buffer now, synchronously, so the pending
      // 50ms flush timer does not fire after tmpHome is removed below.
      sm2.flushSessionBuffer(rebuilt);
    });
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-8b2e: saveSessionFile omits allowedTools entirely when no grant was ever given", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var session = sm.createSessionRaw({});
    session.cliSessionId = "sess-lr-8b2e-empty";
    // allowedTools is {} (never granted) — must not round-trip as a
    // persisted empty object, and must not cause loadSessions() to diverge
    // from the "no grant" default.
    sm.saveSessionFile(session);

    var sessionsBase = path.join(tmpHome, "console", "sessions");
    var dirs = fs.readdirSync(sessionsBase);
    var sessionFile = path.join(sessionsBase, dirs[0], "sess-lr-8b2e-empty.jsonl");
    var firstLine = fs.readFileSync(sessionFile, "utf8").split("\n", 1)[0];
    var meta = JSON.parse(firstLine);
    assert.equal(meta.allowedTools, undefined,
      "meta record must not carry an allowedTools key when nothing was granted");

    var sm2 = makeSessionManager(tmpHome);
    var rebuilt = null;
    sm2.sessions.forEach(function (s) {
      if (s.cliSessionId === "sess-lr-8b2e-empty") rebuilt = s;
    });
    assert.ok(rebuilt);
    assert.deepEqual(rebuilt.allowedTools, {}, "no-grant sessions must rehydrate to an empty allowedTools object");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-8b2e: resumeSession() hydrates allowedTools from opts when rebuilding a non-live session", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    // resumeSession's rebuild branch (no existing in-memory session with this
    // cliSessionId) is exercised directly here — this mirrors the
    // resume_session WS handler in project-sessions.js, which reads the
    // persisted meta's allowedTools and passes it through opts.
    var resumed = sm.resumeSession("sess-lr-8b2e-resume", {
      history: [],
      title: "Resumed",
      allowedTools: { Bash: true },
    }, null);

    assert.deepEqual(resumed.allowedTools, { Bash: true },
      "resumeSession must hydrate allowedTools from opts, not default to {}");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-8b2e: resumeSession() defaults to empty allowedTools when opts carries none", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var resumed = sm.resumeSession("sess-lr-8b2e-resume-nogrant", {
      history: [],
      title: "Resumed",
    }, null);

    assert.deepEqual(resumed.allowedTools, {},
      "resumeSession must default to {} when no persisted grant exists — never invents an approval");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// --- Injection hardening (BOBBIE nit on PR #305, lr-8b2e) ---
//
// metaObj.allowedTools is read straight from the persisted .jsonl meta
// record and hydrated into the live auto-approve table. Without shape/type
// validation, a crafted record could auto-approve a tool with no operator
// click. Sites hardened: lib/sessions.js:298 (loadSessions), lib/sessions.js
// (resumeSession, sanitized defense-in-depth), lib/project-sessions.js
// (persistedAllowedTools assignment feeding resumeSession's opts).

test("lr-8b2e hardening: a legit persisted grant still hydrates and auto-approves (regression)", function () {
  var tmpHome = makeTempHome();
  try {
    var sm1 = makeSessionManager(tmpHome);
    var session = sm1.createSessionRaw({});
    session.cliSessionId = "sess-lr-8b2e-hardening-legit";
    session.allowedTools = {};
    session.allowedTools["Write"] = true;
    sm1.saveSessionFile(session);

    var sm2 = makeSessionManager(tmpHome);
    var rebuilt = null;
    sm2.sessions.forEach(function (s) {
      if (s.cliSessionId === "sess-lr-8b2e-hardening-legit") rebuilt = s;
    });
    assert.ok(rebuilt, "rebuilt session should be found after rehydration");
    assert.deepEqual(rebuilt.allowedTools, { Write: true },
      "a legitimately-granted tool must still round-trip exactly as before hardening");

    var bridge = makeBridge(sm2);
    rebuilt.pendingPermissions = {};
    return bridge.handleCanUseTool(rebuilt, "Write", { file_path: "/tmp/x" }, makeOpts()).then(function (result) {
      assert.equal(result.behavior, "allow", "legit grant must still auto-approve after hardening");
    });
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-8b2e hardening: a persisted allowedTools with a non-boolean value is rejected and does NOT auto-approve", function () {
  var tmpHome = makeTempHome();
  try {
    // sm1 creates the sessions directory (and its encoded-cwd subdir) as a
    // side effect of construction; the crafted meta record is then written
    // directly to disk, bypassing saveSessionFile's own (trusted) writer, to
    // simulate an injected/malformed persisted record matching BOBBIE's
    // threat model: {"allowedTools":{"Bash":true}}-shaped tampering, here
    // with non-boolean values ("yes" and 1).
    var sm1 = makeSessionManager(tmpHome);
    var sessionsBase = path.join(tmpHome, "console", "sessions");
    var encodedDir = fs.readdirSync(sessionsBase)[0];
    var sessDir = path.join(sessionsBase, encodedDir);
    var metaObj = {
      type: "meta",
      cliSessionId: "sess-lr-8b2e-hardening-nonbool",
      title: "Injected",
      createdAt: Date.now(),
      allowedTools: { Bash: "yes", Edit: 1 },
    };
    fs.writeFileSync(path.join(sessDir, "sess-lr-8b2e-hardening-nonbool.jsonl"), JSON.stringify(metaObj) + "\n");

    // A fresh manager instance rehydrates from disk (loadSessions() runs at
    // construction time) — this is what exercises the sanitizer.
    var sm2 = makeSessionManager(tmpHome);
    var rebuilt = null;
    sm2.sessions.forEach(function (s) {
      if (s.cliSessionId === "sess-lr-8b2e-hardening-nonbool") rebuilt = s;
    });
    assert.ok(rebuilt, "rebuilt session should be found after loading the crafted meta record");
    assert.deepEqual(rebuilt.allowedTools, {},
      "non-boolean-value entries must be dropped, not hydrated as truthy grants");

    // Use "Edit" (not "Bash") so the assertion isolates the allowedTools
    // sanitizer under test — Bash additionally runs through a separate
    // safe-command whitelist in handleCanUseTool that is out of scope here.
    var bridge = makeBridge(sm2);
    rebuilt.pendingPermissions = {};
    bridge.handleCanUseTool(rebuilt, "Edit", { file_path: "/tmp/z" }, makeOpts());
    return new Promise(function (resolve) { setImmediate(resolve); }).then(function () {
      assert.equal(Object.keys(rebuilt.pendingPermissions).length, 1,
        "a malformed persisted entry must still prompt — not silently auto-approve");
      sm2.flushSessionBuffer(rebuilt);
    });
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-8b2e hardening: a non-object allowedTools value hydrates as empty and does not throw", function () {
  var tmpHome = makeTempHome();
  try {
    var sm1 = makeSessionManager(tmpHome);

    var sessionsBase = path.join(tmpHome, "console", "sessions");
    var encodedDir = fs.readdirSync(sessionsBase)[0];
    var sessDir = path.join(sessionsBase, encodedDir);
    var metaObj = {
      type: "meta",
      cliSessionId: "sess-lr-8b2e-hardening-nonobject",
      title: "Injected",
      createdAt: Date.now(),
      allowedTools: "Bash",
    };
    fs.writeFileSync(path.join(sessDir, "sess-lr-8b2e-hardening-nonobject.jsonl"), JSON.stringify(metaObj) + "\n");

    assert.doesNotThrow(function () {
      var sm2 = makeSessionManager(tmpHome);
      var rebuilt = null;
      sm2.sessions.forEach(function (s) {
        if (s.cliSessionId === "sess-lr-8b2e-hardening-nonobject") rebuilt = s;
      });
      assert.ok(rebuilt, "rebuilt session should be found after loading the crafted meta record");
      assert.deepEqual(rebuilt.allowedTools, {},
        "a non-object allowedTools value must hydrate as empty, never throw");
    });
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("lr-8b2e hardening: sanitizeAllowedTools utility rejects arrays, null, and mixed-shape entries directly", function () {
  var utils = require("../lib/utils");
  assert.deepEqual(utils.sanitizeAllowedTools(null), {});
  assert.deepEqual(utils.sanitizeAllowedTools(undefined), {});
  assert.deepEqual(utils.sanitizeAllowedTools(["Bash"]), {});
  assert.deepEqual(utils.sanitizeAllowedTools("Bash"), {});
  assert.deepEqual(utils.sanitizeAllowedTools({ Bash: true, Edit: false, Write: "true", Read: 1 }), { Bash: true });
});

test("lr-8b2e hardening: resumeSession() sanitizes a malformed allowedTools passed via opts", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var resumed = sm.resumeSession("sess-lr-8b2e-resume-malformed", {
      history: [],
      title: "Resumed",
      allowedTools: { Bash: true, Edit: "yes" },
    }, null);

    assert.deepEqual(resumed.allowedTools, { Bash: true },
      "resumeSession must sanitize opts.allowedTools defense-in-depth, dropping non-boolean entries");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

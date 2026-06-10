var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { attachExternalTrigger } = require("../lib/project-external-trigger");

// ============================================================
// Helpers
// ============================================================

function makeTrigger(overrides) {
  return Object.assign({
    version: 1,
    id: "trigger-test-" + Date.now(),
    projectSlug: "test-project",
    initialPrompt: "Hello from external trigger",
    contextNote: "Test",
    createdAt: new Date().toISOString(),
  }, overrides || {});
}

function makeFakeProject(spawnLog) {
  var history = [];
  var files = [];
  var sm = {
    sessions: new Map(),
    createSession: function () {
      return {
        localId: "sess-" + Date.now(),
        history: history,
        title: null,
        cwd: null,
        isProcessing: false,
        sentToolResults: {},
        acceptEditsAfterStart: false,
      };
    },
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    appendToSessionFile: function (sess, msg) { files.push(msg); },
  };
  var sdk = {
    startQuery: function (sess, text, images, linuxUser) {
      spawnLog.push({ sessionId: sess.localId, text: text });
    },
    pushMessage: function (sess, text, images) {
      spawnLog.push({ sessionId: sess.localId, text: text, pushed: true });
    },
  };
  return {
    sm: sm,
    sdk: sdk,
    send: function () {},
    onProcessingChanged: function () {},
    getLinuxUserForSession: function () { return null; },
  };
}

// Makes a fake project that already has a live session with the given cliSessionId.
function makeFakeProjectWithSession(spawnLog, cliSessionId) {
  var project = makeFakeProject(spawnLog);
  var liveSession = {
    localId: "live-sess-001",
    cliSessionId: cliSessionId,
    history: [],
    title: "live session",
    cwd: null,
    isProcessing: false,
    sentToolResults: {},
    acceptEditsAfterStart: true,
  };
  project.sm.sessions.set(liveSession.localId, liveSession);
  return project;
}

// ============================================================
// 1. Trigger JSON validation
// ============================================================

test("validateTrigger: valid trigger passes", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-trigger-test-"));
  var spawnLog = [];
  var et = attachExternalTrigger({
    triggersDir: tmpDir,
    getProject: function () { return makeFakeProject(spawnLog); },
  });

  var trigger = makeTrigger();
  var filePath = path.join(tmpDir, trigger.id + ".json");
  fs.writeFileSync(filePath, JSON.stringify(trigger));
  et.startWatcher();

  // Force handleFile by reading and processing synchronously via internal method.
  // Since handleFile is not exported, we drop the file and use the public API
  // but test via side effects (spawnLog).
  // Allow the debounced watcher to fire.
  // We verify via the archive side effect: file should move to processed/.
  var processedDir = path.join(tmpDir, "processed");

  // Give watcher debounce time
  return new Promise(function (resolve) {
    setTimeout(function () {
      et.stopWatcher();
      assert.strictEqual(spawnLog.length, 1, "Session should have been spawned once");
      assert.strictEqual(spawnLog[0].text, trigger.initialPrompt, "Initial prompt should match");
      // File should be archived
      assert.ok(fs.existsSync(path.join(processedDir, trigger.id + ".json")), "Trigger should be archived");
      assert.ok(!fs.existsSync(filePath), "Original trigger file should be removed");
      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    }, 600);
  });
});

test("validateTrigger: missing version rejects trigger", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-trigger-test-"));
  var spawnLog = [];
  var et = attachExternalTrigger({
    triggersDir: tmpDir,
    getProject: function () { return makeFakeProject(spawnLog); },
  });

  var trigger = makeTrigger({ version: undefined });
  var filePath = path.join(tmpDir, trigger.id + ".json");
  fs.writeFileSync(filePath, JSON.stringify(trigger));
  et.startWatcher();

  return new Promise(function (resolve) {
    setTimeout(function () {
      et.stopWatcher();
      assert.strictEqual(spawnLog.length, 0, "No session should spawn for invalid trigger");
      // File should remain (not archived — invalid triggers are dropped silently)
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    }, 600);
  });
});

test("validateTrigger: wrong version rejects trigger", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-trigger-test-"));
  var spawnLog = [];
  var et = attachExternalTrigger({
    triggersDir: tmpDir,
    getProject: function () { return makeFakeProject(spawnLog); },
  });

  var trigger = makeTrigger({ version: 99 });
  var filePath = path.join(tmpDir, trigger.id + ".json");
  fs.writeFileSync(filePath, JSON.stringify(trigger));
  et.startWatcher();

  return new Promise(function (resolve) {
    setTimeout(function () {
      et.stopWatcher();
      assert.strictEqual(spawnLog.length, 0, "No session should spawn for unsupported version");
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    }, 600);
  });
});

test("validateTrigger: missing initialPrompt rejects trigger", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-trigger-test-"));
  var spawnLog = [];
  var et = attachExternalTrigger({
    triggersDir: tmpDir,
    getProject: function () { return makeFakeProject(spawnLog); },
  });

  var trigger = makeTrigger({ initialPrompt: undefined });
  var filePath = path.join(tmpDir, trigger.id + ".json");
  fs.writeFileSync(filePath, JSON.stringify(trigger));
  et.startWatcher();

  return new Promise(function (resolve) {
    setTimeout(function () {
      et.stopWatcher();
      assert.strictEqual(spawnLog.length, 0, "No session should spawn when initialPrompt is missing");
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    }, 600);
  });
});

// ============================================================
// 2. Project routing
// ============================================================

test("handleFile: routes to registered project", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-trigger-test-"));
  var spawnLog = [];
  var et = attachExternalTrigger({
    triggersDir: tmpDir,
    getProject: function (slug) {
      if (slug === "test-project") return makeFakeProject(spawnLog);
      return null;
    },
  });

  var trigger = makeTrigger({ projectSlug: "test-project" });
  fs.writeFileSync(path.join(tmpDir, trigger.id + ".json"), JSON.stringify(trigger));
  et.startWatcher();

  return new Promise(function (resolve) {
    setTimeout(function () {
      et.stopWatcher();
      assert.strictEqual(spawnLog.length, 1, "Session should spawn for registered project");
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    }, 600);
  });
});

test("handleFile: drops trigger for unregistered project", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-trigger-test-"));
  var spawnLog = [];
  var et = attachExternalTrigger({
    triggersDir: tmpDir,
    getProject: function () { return null; }, // nothing registered
  });

  var trigger = makeTrigger({ projectSlug: "nonexistent-project" });
  fs.writeFileSync(path.join(tmpDir, trigger.id + ".json"), JSON.stringify(trigger));
  et.startWatcher();

  return new Promise(function (resolve) {
    setTimeout(function () {
      et.stopWatcher();
      assert.strictEqual(spawnLog.length, 0, "No session should spawn for unregistered project");
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    }, 600);
  });
});

// ============================================================
// 3. De-duplication
// ============================================================

test("duplicate trigger ID is processed only once", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-trigger-test-"));
  var spawnLog = [];
  var et = attachExternalTrigger({
    triggersDir: tmpDir,
    getProject: function () { return makeFakeProject(spawnLog); },
  });

  // Write two files with the same ID (simulates watcher double-fire)
  var trigger = makeTrigger({ id: "trigger-dedup-001" });
  var filePath1 = path.join(tmpDir, "trigger-dedup-001.json");
  // The second file has a different filename but same id in content
  var filePath2 = path.join(tmpDir, "trigger-dedup-001-copy.json");
  fs.writeFileSync(filePath1, JSON.stringify(trigger));
  fs.writeFileSync(filePath2, JSON.stringify(trigger));
  et.startWatcher();

  return new Promise(function (resolve) {
    setTimeout(function () {
      et.stopWatcher();
      assert.strictEqual(spawnLog.length, 1, "Same trigger ID should spawn session at most once");
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    }, 600);
  });
});

// ============================================================
// 4. Malformed JSON is silently dropped
// ============================================================

test("malformed JSON trigger is silently dropped", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-trigger-test-"));
  var spawnLog = [];
  var et = attachExternalTrigger({
    triggersDir: tmpDir,
    getProject: function () { return makeFakeProject(spawnLog); },
  });

  fs.writeFileSync(path.join(tmpDir, "bad-trigger.json"), "{ not valid json <<<");
  et.startWatcher();

  return new Promise(function (resolve) {
    setTimeout(function () {
      et.stopWatcher();
      assert.strictEqual(spawnLog.length, 0, "Malformed JSON should not spawn a session");
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    }, 600);
  });
});

// ============================================================
// 5. Daemon-down recovery (scanExisting)
// ============================================================

test("scanExisting picks up pre-existing trigger files on startWatcher", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-trigger-test-"));
  var spawnLog = [];

  // Drop file BEFORE startWatcher is called (simulates file arriving while daemon was down)
  var trigger = makeTrigger({ id: "trigger-recovery-001" });
  fs.writeFileSync(path.join(tmpDir, trigger.id + ".json"), JSON.stringify(trigger));

  var et = attachExternalTrigger({
    triggersDir: tmpDir,
    getProject: function () { return makeFakeProject(spawnLog); },
  });
  et.startWatcher();

  return new Promise(function (resolve) {
    setTimeout(function () {
      et.stopWatcher();
      assert.strictEqual(spawnLog.length, 1, "Pre-existing trigger should be picked up on start");
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    }, 600);
  });
});

// ============================================================
// 6. Schema v2: mid-session inject
// ============================================================

test("v2 trigger with sessionId calls pushMessage on matching session", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-trigger-test-"));
  var spawnLog = [];
  var CLI_SESSION_ID = "abc-123-cli-session";
  var et = attachExternalTrigger({
    triggersDir: tmpDir,
    getProject: function (slug) {
      if (slug === "test-project") return makeFakeProjectWithSession(spawnLog, CLI_SESSION_ID);
      return null;
    },
  });

  var trigger = makeTrigger({
    version: 2,
    id: "trigger-inject-001",
    sessionId: CLI_SESSION_ID,
    initialPrompt: "Inject this message",
  });
  var filePath = path.join(tmpDir, trigger.id + ".json");
  fs.writeFileSync(filePath, JSON.stringify(trigger));
  et.startWatcher();

  var processedDir = path.join(tmpDir, "processed");
  return new Promise(function (resolve) {
    setTimeout(function () {
      et.stopWatcher();
      // pushMessage was called, not startQuery
      assert.strictEqual(spawnLog.length, 1, "pushMessage should be called once");
      assert.strictEqual(spawnLog[0].pushed, true, "Should use pushMessage path");
      assert.strictEqual(spawnLog[0].text, "Inject this message", "Text should match initialPrompt");
      // Trigger should be archived on success
      assert.ok(fs.existsSync(path.join(processedDir, trigger.id + ".json")), "Trigger should be archived");
      assert.ok(!fs.existsSync(filePath), "Original trigger file should be removed");
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    }, 600);
  });
});

test("v2 trigger with sessionId not found: not archived, dispatched entry cleared", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-trigger-test-"));
  var spawnLog = [];
  var et = attachExternalTrigger({
    triggersDir: tmpDir,
    getProject: function (slug) {
      if (slug === "test-project") return makeFakeProjectWithSession(spawnLog, "different-session-id");
      return null;
    },
  });

  var trigger = makeTrigger({
    version: 2,
    id: "trigger-inject-002",
    sessionId: "nonexistent-session-id",
    initialPrompt: "This should not land",
  });
  var filePath = path.join(tmpDir, trigger.id + ".json");
  fs.writeFileSync(filePath, JSON.stringify(trigger));
  et.startWatcher();

  var processedDir = path.join(tmpDir, "processed");
  return new Promise(function (resolve) {
    setTimeout(function () {
      et.stopWatcher();
      assert.strictEqual(spawnLog.length, 0, "No push should occur if session not found");
      // File should remain — not archived
      assert.ok(fs.existsSync(filePath), "Trigger should not be archived when session is not found");
      assert.ok(!fs.existsSync(path.join(processedDir, trigger.id + ".json")), "Should not appear in processed/");
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    }, 600);
  });
});

test("v2 trigger without sessionId falls back to spawnSession", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-trigger-test-"));
  var spawnLog = [];
  var et = attachExternalTrigger({
    triggersDir: tmpDir,
    getProject: function () { return makeFakeProject(spawnLog); },
  });

  var trigger = makeTrigger({ version: 2, id: "trigger-v2-spawn-001" });
  // No sessionId — should behave like v1
  delete trigger.sessionId;
  fs.writeFileSync(path.join(tmpDir, trigger.id + ".json"), JSON.stringify(trigger));
  et.startWatcher();

  return new Promise(function (resolve) {
    setTimeout(function () {
      et.stopWatcher();
      assert.strictEqual(spawnLog.length, 1, "v2 without sessionId should spawn a session");
      assert.ok(!spawnLog[0].pushed, "Should use startQuery, not pushMessage");
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    }, 600);
  });
});

test("v2 trigger with invalid sessionId (empty string) is rejected by validator", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-trigger-test-"));
  var spawnLog = [];
  var et = attachExternalTrigger({
    triggersDir: tmpDir,
    getProject: function () { return makeFakeProjectWithSession(spawnLog, "any-session"); },
  });

  var trigger = makeTrigger({ version: 2, id: "trigger-inject-bad-sid", sessionId: "" });
  fs.writeFileSync(path.join(tmpDir, trigger.id + ".json"), JSON.stringify(trigger));
  et.startWatcher();

  return new Promise(function (resolve) {
    setTimeout(function () {
      et.stopWatcher();
      assert.strictEqual(spawnLog.length, 0, "Empty sessionId should fail validation");
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    }, 600);
  });
});

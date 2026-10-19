var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { attachExternalTrigger } = require("../lib/project-external-trigger");

// The fixture is a real trigger file captured from a console's
// external-triggers/processed/ directory (message f3c2a19d-...:1, written by
// the dispatch notifier). It is copied byte for byte. The "from" field is the
// only thing the tests add.
var FIXTURE = path.join(__dirname, "fixtures", "external-trigger-dispatch-question.json");
var SESSION_ID = "85fe11a2-2462-46d0-ad7f-48e74cc72dbe";

function loadCaptured() {
  return JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
}

function makeProject(spawnLog) {
  var live = {
    localId: "live-sess-001",
    cliSessionId: SESSION_ID,
    history: [],
    title: "live session",
    cwd: null,
    isProcessing: false,
    queryInstance: {},
    sentToolResults: {},
    acceptEditsAfterStart: true,
  };
  var created = [];
  var sm = {
    sessions: new Map([[live.localId, live]]),
    createSession: function () {
      var s = { localId: "new-sess-001", history: [], title: null, cwd: null, isProcessing: false, sentToolResults: {} };
      created.push(s);
      return s;
    },
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    appendToSessionFile: function () {},
    recordHistoryEntry: function (sess, obj) { sess.history.push(obj); },
  };
  var sdk = {
    startQuery: function (sess, text) { spawnLog.push({ text: text }); },
    pushMessage: function (sess, text) { spawnLog.push({ text: text, pushed: true }); },
  };
  return {
    sm: sm,
    sdk: sdk,
    live: live,
    created: created,
    send: function () {},
    onProcessingChanged: function () {},
    getLinuxUserForSession: function () { return null; },
  };
}

// Drops the trigger into a throwaway triggers dir and returns the recorded
// history entry once the watcher has handled it.
function runTrigger(trigger, pickSession) {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-trigger-from-"));
  var spawnLog = [];
  var project = makeProject(spawnLog);
  var et = attachExternalTrigger({
    triggersDir: tmpDir,
    getProject: function (slug) { return slug === trigger.projectSlug ? project : null; },
  });
  fs.writeFileSync(path.join(tmpDir, "trigger.json"), JSON.stringify(trigger));
  et.startWatcher();
  return new Promise(function (resolve) {
    setTimeout(function () {
      et.stopWatcher();
      var sess = pickSession(project);
      var entry = sess.history[sess.history.length - 1];
      var archived = fs.existsSync(path.join(tmpDir, "processed", trigger.id + ".json"));
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve({ entry: entry, archived: archived, spawnLog: spawnLog });
    }, 600);
  });
}

test("captured file-drop trigger to a live session, no from: undeclared sender", async function () {
  var trigger = loadCaptured();
  var r = await runTrigger(trigger, function (p) { return p.live; });
  assert.strictEqual(r.spawnLog.length, 1);
  assert.strictEqual(r.spawnLog[0].pushed, true);
  assert.strictEqual(r.spawnLog[0].text, trigger.initialPrompt);
  assert.ok(r.archived);
  assert.strictEqual(r.entry.source, "external-trigger");
  assert.strictEqual(r.entry.triggerId, trigger.id);
  assert.strictEqual(r.entry.contextNote, trigger.contextNote);
  assert.strictEqual(r.entry.senderKind, "undeclared");
  assert.strictEqual(r.entry.fromName, undefined);
  assert.strictEqual(r.entry.from, "injected:trigger");
});

test("captured file-drop trigger to a live session, with from: declared sender", async function () {
  var trigger = Object.assign(loadCaptured(), { from: "lore-a3" });
  var r = await runTrigger(trigger, function (p) { return p.live; });
  assert.strictEqual(r.spawnLog.length, 1);
  assert.ok(r.archived);
  assert.strictEqual(r.entry.senderKind, "declared");
  assert.strictEqual(r.entry.fromName, "lore-a3");
  assert.strictEqual(r.entry.from, "injected:trigger");
});

test("captured file-drop trigger opening a session (sessionId dropped), no from", async function () {
  var trigger = loadCaptured();
  delete trigger.sessionId;
  var r = await runTrigger(trigger, function (p) { return p.created[0]; });
  assert.ok(r.archived);
  assert.strictEqual(r.entry.senderKind, "undeclared");
  assert.strictEqual(r.entry.fromName, undefined);
});

test("captured file-drop trigger opening a session (sessionId dropped), with from", async function () {
  var trigger = Object.assign(loadCaptured(), { from: "lore-a3" });
  delete trigger.sessionId;
  var r = await runTrigger(trigger, function (p) { return p.created[0]; });
  assert.ok(r.archived);
  assert.strictEqual(r.entry.senderKind, "declared");
  assert.strictEqual(r.entry.fromName, "lore-a3");
});

test("captured file-drop trigger with an invalid from is refused and nothing is delivered", async function () {
  var trigger = Object.assign(loadCaptured(), { from: "bad\u0007name" });
  var r = await runTrigger(trigger, function (p) { return p.live; });
  assert.strictEqual(r.spawnLog.length, 0);
  assert.strictEqual(r.entry, undefined);
});

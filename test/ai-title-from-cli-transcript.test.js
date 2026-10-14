"use strict";
// A session shows the title the vendor CLI wrote into its transcript, read from
// an isolated Claude directory built per test (never the real one). The records
// have the shape the CLI writes: {type:"ai-title", aiTitle, sessionId}.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { readLatestAiTitle, findTranscript } = require("../lib/cli-transcript-title");
var { createAiTitleRefresher } = require("../lib/session-ai-title");
var { attachMessageProcessor } = require("../lib/sdk-message-processor");
var utils = require("../lib/utils");

var SID = "379d5c40-aaaa-4bbb-8ccc-0123456789ab";
var CWD = "/work/example-project";

function claudeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-title-"));
}

function transcriptFile(dir, cwd, id) {
  var projectDir = path.join(dir, "projects", utils.encodeCwd(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  return path.join(projectDir, id + ".jsonl");
}

function rec(obj) { return JSON.stringify(obj) + "\n"; }
function aiTitle(title, id) { return rec({ type: "ai-title", aiTitle: title, sessionId: id || SID }); }
function userLine(text) {
  return rec({ type: "user", sessionId: SID, message: { role: "user", content: text } });
}

test("the newest ai-title record wins", async function () {
  var dir = claudeDir();
  var file = transcriptFile(dir, CWD, SID);
  fs.writeFileSync(file, userLine("hi") + aiTitle("First title") + userLine("more") + aiTitle("Clagentic-loadout PR 86 sequence") + userLine("tail"));
  assert.equal(await readLatestAiTitle(file, SID), "Clagentic-loadout PR 86 sequence");
});

test("a transcript with no ai-title record has no title", async function () {
  var dir = claudeDir();
  var file = transcriptFile(dir, CWD, SID);
  fs.writeFileSync(file, userLine("hi") + userLine("there"));
  assert.equal(await readLatestAiTitle(file, SID), null);
  assert.equal(await readLatestAiTitle(path.join(dir, "missing.jsonl"), SID), null);
});

test("a record naming another session, or an empty title, is not this session's title", async function () {
  var dir = claudeDir();
  var file = transcriptFile(dir, CWD, SID);
  fs.writeFileSync(file, aiTitle("Real", SID) + aiTitle("Someone else", "other-session") + aiTitle("   ", SID));
  assert.equal(await readLatestAiTitle(file, SID), "Real");
});

test("a title is found past chunk edges, in a large file, with multibyte text around it", async function () {
  var dir = claudeDir();
  var file = transcriptFile(dir, CWD, SID);
  var filler = userLine("é中".repeat(40000));
  fs.writeFileSync(file, aiTitle("Deep title é") + filler + filler + "not json at all\n" + userLine("end"));
  assert.equal(await readLatestAiTitle(file, SID), "Deep title é");
});

test("the title on the first line of a file is found", async function () {
  var dir = claudeDir();
  var file = transcriptFile(dir, CWD, SID);
  fs.writeFileSync(file, aiTitle("Only line").trimEnd());
  assert.equal(await readLatestAiTitle(file, SID), "Only line");
});

test("findTranscript prefers the cwd's directory and falls back to any project directory", async function () {
  var dir = claudeDir();
  var elsewhere = transcriptFile(dir, "/other/place", SID);
  fs.writeFileSync(elsewhere, aiTitle("x"));
  assert.equal(await findTranscript(dir, [CWD], SID), elsewhere);
  var home = transcriptFile(dir, CWD, SID);
  fs.writeFileSync(home, aiTitle("y"));
  assert.equal(await findTranscript(dir, [CWD], SID), home);
  assert.equal(await findTranscript(dir, [CWD], "nope"), null);
  assert.equal(await findTranscript(dir, [CWD], "../escape"), null);
});

function makeSm() {
  var saved = 0;
  return {
    sm: {
      skillMeta: [], workflowMeta: [], skillNames: [], slashCommands: null, currentModel: null,
      _savedDefaultModel: null, permissionRequestIndex: {},
      sendAndRecord: function () {},
      sendToSession: function () {},
      saveSessionFile: function () { saved++; },
      broadcastSessionList: function () {},
      modelsByVendor: {}, availableModels: [], availableVendors: [], installedVendors: [],
    },
    counts: function () { return { saved: saved }; },
  };
}

function makeSession(overrides) {
  return Object.assign({
    localId: 1, cliSessionId: SID, vendor: "claude", cwd: CWD, history: [], messageUUIDs: [], blocks: {},
    sentToolResults: {}, pendingPermissions: {}, pendingElicitations: {}, pendingAskUser: {},
    activeTaskToolIds: {}, taskIdMap: {}, streamedText: false, responsePreview: "", isProcessing: true,
    loop: null, title: "External trigger", turnCount: 0,
  }, overrides || {});
}

// Drives the real turn-completion path of the message processor with the real
// refresher; returns a function that completes one turn and waits for the read.
function harness(dir) {
  var h = makeSm();
  var refresher = createAiTitleRefresher({ sm: h.sm, cwd: CWD, daemonHome: "/unused", claudeDir: dir });
  var pending = null;
  var processor = attachMessageProcessor({
    sm: h.sm, send: function () {}, slug: "p", cwd: CWD, pushModule: null,
    getNotificationsModule: function () { return null; }, adapter: { vendor: "claude" },
    onProcessingChanged: function () {}, onTurnDone: null,
    refreshAiTitle: function (s) { pending = refresher(s); }, opts: {},
    discoverSkillDirs: function () { return []; }, mergeSkills: function () { return []; },
    discoverWorkflows: function () { return []; }, discoverSkillsWithMeta: function () { return []; },
    mergeSkillsWithMeta: function () { return []; }, getSDK: null,
  });
  return {
    counts: h.counts,
    turn: async function (session) {
      pending = null;
      processor.processSDKMessage(session, { yokeType: "result", cost: 0.1, duration: 1, sessionId: SID });
      if (pending) await pending;
    },
  };
}

test("a typed, an opened and a resumed session all show the CLI title once the transcript has one", async function () {
  var dir = claudeDir();
  var file = transcriptFile(dir, CWD, SID);
  fs.writeFileSync(file, userLine("hello") + aiTitle("Fix the idle reaper"));
  var h = harness(dir);

  var opened = makeSession({ title: "External trigger — abc123" });
  var typed = makeSession({ title: "why was my session reaped", titleProvisional: true });
  var resumed = makeSession({ title: "Resumed session", turnCount: 40 });
  for (var s of [opened, typed, resumed]) {
    await h.turn(s);
    assert.equal(s.title, "Fix the idle reaper");
    assert.equal(s.titleProvisional, false);
  }
});

test("a newer ai-title replaces the older one on the next turn", async function () {
  var dir = claudeDir();
  var file = transcriptFile(dir, CWD, SID);
  fs.writeFileSync(file, aiTitle("Old title"));
  var h = harness(dir);
  var s = makeSession();
  await h.turn(s);
  assert.equal(s.title, "Old title");
  var before = h.counts();

  await h.turn(s);
  assert.deepEqual(h.counts(), before, "an unchanged title is not saved again");

  fs.appendFileSync(file, userLine("next") + aiTitle("Newer title"));
  await h.turn(s);
  assert.equal(s.title, "Newer title");
});

test("with no ai-title the first-line title stays", async function () {
  var dir = claudeDir();
  fs.writeFileSync(transcriptFile(dir, CWD, SID), userLine("hello"));
  var h = harness(dir);
  var s = makeSession({ title: "hello there", titleProvisional: true });
  await h.turn(s);
  assert.equal(s.title, "hello there");
  assert.equal(s.titleProvisional, true);

  var noFile = makeSession({ cliSessionId: "no-transcript-yet" });
  await h.turn(noFile);
  assert.equal(noFile.title, "External trigger");
});

test("a title the operator set by rename is never replaced", async function () {
  var dir = claudeDir();
  fs.writeFileSync(transcriptFile(dir, CWD, SID), aiTitle("CLI title"));
  var h = harness(dir);
  var s = makeSession({ title: "My name for it", titleManuallySet: true });
  await h.turn(s);
  assert.equal(s.title, "My name for it");
});

test("a session of a vendor with no CLI transcript is not looked up", async function () {
  var dir = claudeDir();
  fs.writeFileSync(transcriptFile(dir, CWD, "thread-1"), aiTitle("Not for codex", "thread-1"));
  var h = harness(dir);
  var s = makeSession({ vendor: "codex", cliSessionId: "thread-1", title: "first line" });
  await h.turn(s);
  assert.equal(s.title, "first line");
});

test("a rename that lands while the transcript is read wins", async function () {
  var dir = claudeDir();
  fs.writeFileSync(transcriptFile(dir, CWD, SID), aiTitle("CLI title"));
  var h = makeSm();
  var refresh = createAiTitleRefresher({ sm: h.sm, cwd: CWD, daemonHome: "/unused", claudeDir: dir });
  var s = makeSession();
  var p = refresh(s);
  s.title = "Renamed meanwhile";
  s.titleManuallySet = true;
  assert.equal(await p, false);
  assert.equal(s.title, "Renamed meanwhile");
});

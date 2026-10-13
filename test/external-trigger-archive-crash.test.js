// A crash while a handled trigger is being archived must never put the trigger
// back in front of the watcher: the input was already delivered.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { attachExternalTrigger } = require("../lib/project-external-trigger");

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function makeProject(started) {
  var nextId = 1;
  return {
    sm: {
      sessions: new Map(),
      createSession: function () { return { localId: "s" + nextId++, history: [], isProcessing: false, sentToolResults: {} }; },
      saveSessionFile: function () {}, broadcastSessionList: function () {},
      appendToSessionFile: function () {},
      recordHistoryEntry: function (s, e) { s.history.push(e); },
    },
    sdk: { startQuery: function (s, text) { started.push(text); }, pushMessage: function () {} },
    onProcessingChanged: function () {},
    getLinuxUserForSession: function () { return null; },
  };
}

function trigger(id) {
  return { version: 1, id: id, projectSlug: "p", initialPrompt: "go", createdAt: new Date().toISOString() };
}

// An fs whose archive operations stop working at step `crashAt`, as if the
// process died there: 1 = while writing the result (leaves half of it),
// 2 = before the trigger is renamed into processed/, 3 = before the result is
// renamed into place.
function dyingFs(crashAt) {
  var step = 0;
  var dead = false;
  function die() { dead = true; throw new Error("simulated crash"); }
  return Object.assign({}, fs, {
    writeFileSync: function (p, data) {
      if (dead) die();
      if (String(p).endsWith(".result.tmp")) {
        step++;
        if (step === crashAt) { fs.writeFileSync(p, String(data).slice(0, 20)); die(); }
      }
      return fs.writeFileSync(p, data);
    },
    renameSync: function (from, to) {
      if (dead) die();
      step++;
      if (step === crashAt) die();
      return fs.renameSync(from, to);
    },
  });
}

async function crashThenRestart(crashAt) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-trigger-crash-"));
  var started = [];
  try {
    var t = trigger("crash-" + crashAt);
    fs.writeFileSync(path.join(dir, t.id + ".json"), JSON.stringify(t));

    var first = attachExternalTrigger({ triggersDir: dir, getProject: function () { return makeProject(started); }, fs: dyingFs(crashAt) });
    first.startWatcher();
    await sleep(50);
    first.stopWatcher();
    assert.equal(started.length, 1, "delivered once before the crash");

    var second = attachExternalTrigger({ triggersDir: dir, getProject: function () { return makeProject(started); } });
    second.startWatcher();
    await sleep(50);
    second.stopWatcher();
    assert.equal(started.length, 1, "the restart did not deliver it again");

    assert.equal(fs.existsSync(path.join(dir, t.id + ".json")), false, "trigger is out of the watched directory");
    assert.equal(fs.existsSync(path.join(dir, "processed", t.id + ".result.tmp")), false, "no half-finished record is left");
    return JSON.parse(fs.readFileSync(path.join(dir, "processed", t.id + ".json"), "utf8"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("archiving: a crash with the result torn mid-write is reported unknown, not redelivered", async function () {
  var record = await crashThenRestart(1);
  assert.equal(record.result.result, "error");
  assert.match(record.result.reason, /unknown/);
});

test("archiving: a crash after the result is written, before the trigger moves, keeps the real result", async function () {
  var record = await crashThenRestart(2);
  assert.equal(record.result.result, "opened");
});

test("archiving: a crash after the trigger moved, before the result is in place, keeps the real result", async function () {
  var record = await crashThenRestart(3);
  assert.equal(record.result.result, "opened");
  assert.equal(record.id, "crash-3");
});

test("archiving: an uninterrupted archive leaves one record with the result and no tmp file", async function () {
  var record = await crashThenRestart(99);
  assert.equal(record.result.result, "opened");
});

test("startup: a processed trigger with no result is reported and never delivered", async function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-trigger-crash-"));
  var started = [];
  var logged = [];
  var origError = console.error;
  console.error = function () { logged.push(Array.prototype.join.call(arguments, " ")); };
  try {
    fs.mkdirSync(path.join(dir, "processed"));
    fs.writeFileSync(path.join(dir, "processed", "no-result.json"), JSON.stringify(trigger("no-result")));
    var et = attachExternalTrigger({ triggersDir: dir, getProject: function () { return makeProject(started); } });
    et.startWatcher();
    await sleep(50);
    et.stopWatcher();
    assert.equal(started.length, 0);
    assert.ok(logged.some(function (l) { return /no-result\.json has no result/.test(l); }), logged.join("\n"));
  } finally {
    console.error = origError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

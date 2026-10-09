var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { attachExternalTrigger } = require("../lib/project-external-trigger");

var TTL_MS = 60 * 1000;
var OLD = new Date(Date.now() - 10 * TTL_MS).toISOString();

function mkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-trigger-ttl-"));
}

function makeProject(log, cliSessionId) {
  var sessions = new Map();
  if (cliSessionId) {
    sessions.set("live", { localId: "live", cliSessionId: cliSessionId, history: [] });
  }
  return {
    sm: {
      sessions: sessions,
      recordHistoryEntry: function (sess, obj) { sess.history.push(obj); },
      appendToSessionFile: function (sess, obj) { log.file.push(obj); },
    },
    sdk: {
      pushMessage: function (sess, text, images) {
        log.pushes.push({ text: text, images: images, argc: arguments.length });
      },
    },
    send: function () {},
    onProcessingChanged: function () {},
    getLinuxUserForSession: function () { return null; },
  };
}

function newLog() { return { pushes: [], file: [] }; }

function pushTrigger(overrides) {
  return Object.assign({
    version: 2,
    id: "ttl-push-1",
    projectSlug: "p",
    initialPrompt: "hello",
    contextNote: "from agent X",
    sessionId: "missing-session",
    createdAt: new Date().toISOString(),
  }, overrides || {});
}

function run(dir, project, extra) {
  var et = attachExternalTrigger(Object.assign({
    triggersDir: dir,
    unprocessedTtlMs: TTL_MS,
    getProject: function (slug) { return slug === "p" ? project : null; },
  }, extra || {}));
  et.startWatcher();
  et.stopWatcher();
}

test("not_found push trigger past TTL moves to expired/", function () {
  var dir = mkdir();
  var f = path.join(dir, "ttl-push-1.json");
  fs.writeFileSync(f, JSON.stringify(pushTrigger({ createdAt: OLD })));
  run(dir, makeProject(newLog(), "other"));
  assert.ok(!fs.existsSync(f));
  assert.ok(fs.existsSync(path.join(dir, "expired", "ttl-push-1.json")));
  assert.ok(!fs.existsSync(path.join(dir, "processed", "ttl-push-1.json")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("not_found push trigger within TTL stays and retries", function () {
  var dir = mkdir();
  var f = path.join(dir, "ttl-push-1.json");
  fs.writeFileSync(f, JSON.stringify(pushTrigger()));
  var log = newLog();
  var project = makeProject(log, "other");
  var et = attachExternalTrigger({
    triggersDir: dir,
    unprocessedTtlMs: TTL_MS,
    getProject: function () { return project; },
  });
  et.startWatcher();
  assert.ok(fs.existsSync(f));
  // Session appears later: the next scan delivers it.
  project.sm.sessions.set("late", { localId: "late", cliSessionId: "missing-session", history: [] });
  // The 30 s poll is too slow for a test; a dir event triggers the rescan.
  fs.writeFileSync(path.join(dir, "poke.json"), "x");
  return new Promise(function (resolve) {
    setTimeout(function () {
      et.stopWatcher();
      assert.strictEqual(log.pushes.length, 1);
      assert.ok(fs.existsSync(path.join(dir, "processed", "ttl-push-1.json")));
      assert.ok(!fs.existsSync(path.join(dir, "expired", "ttl-push-1.json")));
      fs.rmSync(dir, { recursive: true, force: true });
      resolve();
    }, 600);
  });
});

test("malformed JSON past TTL (mtime) moves to expired/, fresh stays", function () {
  var dir = mkdir();
  var oldF = path.join(dir, "old-bad.json");
  var newF = path.join(dir, "new-bad.json");
  fs.writeFileSync(oldF, "{ nope");
  fs.writeFileSync(newF, "{ nope");
  var past = new Date(Date.now() - 10 * TTL_MS);
  fs.utimesSync(oldF, past, past);
  run(dir, makeProject(newLog()));
  assert.ok(fs.existsSync(path.join(dir, "expired", "old-bad.json")));
  assert.ok(!fs.existsSync(oldF));
  assert.ok(fs.existsSync(newF));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("schema-invalid past TTL moves to expired/", function () {
  var dir = mkdir();
  var f = path.join(dir, "inv.json");
  fs.writeFileSync(f, JSON.stringify(pushTrigger({ id: "inv", initialPrompt: undefined, createdAt: OLD })));
  run(dir, makeProject(newLog()));
  assert.ok(fs.existsSync(path.join(dir, "expired", "inv.json")));
  assert.ok(!fs.existsSync(f));
});

test("unknown projectSlug past TTL moves to expired/, even after dispatched is set", function () {
  var dir = mkdir();
  var f = path.join(dir, "unk.json");
  // Fresh at first scan: dispatched[id] gets set and the file is left in place.
  var created = new Date(Date.now() - TTL_MS / 2).toISOString();
  fs.writeFileSync(f, JSON.stringify(pushTrigger({ id: "unk", projectSlug: "nope", createdAt: created })));
  var et = attachExternalTrigger({
    triggersDir: dir,
    unprocessedTtlMs: TTL_MS / 2 + 400,
    getProject: function () { return null; },
  });
  et.startWatcher();
  assert.ok(fs.existsSync(f));
  return new Promise(function (resolve) {
    setTimeout(function () {
      // Watcher-triggered rescan (debounced) must now expire it.
      fs.writeFileSync(path.join(dir, "poke.json"), "x");
      setTimeout(function () {
        et.stopWatcher();
        assert.ok(fs.existsSync(path.join(dir, "expired", "unk.json")));
        assert.ok(!fs.existsSync(f));
        fs.rmSync(dir, { recursive: true, force: true });
        resolve();
      }, 500);
    }, 500);
  });
});

test("age source: valid createdAt wins over mtime; invalid createdAt falls back to mtime", function () {
  var dir = mkdir();
  var past = new Date(Date.now() - 10 * TTL_MS);
  // Recent createdAt, ancient mtime -> not expired.
  var a = path.join(dir, "a.json");
  fs.writeFileSync(a, JSON.stringify(pushTrigger({ id: "a" })));
  fs.utimesSync(a, past, past);
  // Ancient createdAt, fresh mtime -> expired.
  var b = path.join(dir, "b.json");
  fs.writeFileSync(b, JSON.stringify(pushTrigger({ id: "b", createdAt: OLD })));
  // Unparseable createdAt, ancient mtime -> expired via mtime.
  var c = path.join(dir, "c.json");
  fs.writeFileSync(c, JSON.stringify(pushTrigger({ id: "c", createdAt: "garbage" })));
  fs.utimesSync(c, past, past);
  run(dir, makeProject(newLog(), "other"));
  assert.ok(fs.existsSync(a));
  assert.ok(fs.existsSync(path.join(dir, "expired", "b.json")));
  assert.ok(fs.existsSync(path.join(dir, "expired", "c.json")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("expired/ files are not rescanned; default TTL does not expire fresh files", function () {
  var dir = mkdir();
  fs.mkdirSync(path.join(dir, "expired"));
  var log = newLog();
  fs.writeFileSync(path.join(dir, "expired", "x.json"), JSON.stringify(pushTrigger({ id: "x", sessionId: "s" })));
  var project = makeProject(log, "s");
  var et = attachExternalTrigger({ triggersDir: dir, getProject: function () { return project; } });
  et.startWatcher();
  et.stopWatcher();
  assert.strictEqual(log.pushes.length, 0);
  assert.ok(fs.existsSync(path.join(dir, "expired", "x.json")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("push path: contextNote recorded as agent-origin entry; pushMessage third arg stays null", function () {
  var dir = mkdir();
  var log = newLog();
  var project = makeProject(log, "sid");
  fs.writeFileSync(path.join(dir, "p.json"), JSON.stringify(pushTrigger({ id: "p", sessionId: "sid" })));
  run(dir, project);
  assert.strictEqual(log.pushes.length, 1);
  assert.strictEqual(log.pushes[0].text, "hello");
  assert.strictEqual(log.pushes[0].images, null);
  var hist = project.sm.sessions.get("live").history;
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(hist[0].type, "user_message");
  assert.strictEqual(hist[0].contextNote, "from agent X");
  assert.strictEqual(hist[0].triggerId, "p");
  assert.strictEqual(hist[0].source, "external-trigger");
  assert.deepStrictEqual(log.file, hist);
  fs.rmSync(dir, { recursive: true, force: true });
});

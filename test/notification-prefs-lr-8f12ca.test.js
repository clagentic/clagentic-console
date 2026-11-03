"use strict";

// Per-user notification preferences (lib/notification-prefs.js) and the push
// filter that enforces them where push is sent (lib/push.js).

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var prefs = require("../lib/notification-prefs");

function memoryStore(initial) {
  var file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "notif-prefs-")), "notification-prefs.json");
  if (initial) fs.writeFileSync(file, JSON.stringify(initial));
  var writes = [];
  var s = prefs.createPrefsStore({
    file: file,
    persist: function (doc) { writes.push(JSON.parse(JSON.stringify(doc))); fs.writeFileSync(file, JSON.stringify(doc)); return Promise.resolve(); },
  });
  return { store: s, file: file, writes: writes };
}

test("defaults keep today's behaviour: every banner and push on, sound for a finished turn only", function () {
  var d = memoryStore().store.get("u1");
  prefs.CATEGORIES.forEach(function (c) {
    assert.equal(d.banner[c], true, "banner " + c);
    assert.equal(d.push[c], true, "push " + c);
    assert.equal(d.sound[c], c === "turn_done", "sound " + c);
  });
});

test("'Approval prompts only' keeps prompts and reminders and mutes finished turns", function () {
  var m = memoryStore();
  var v = m.store.set("u1", { preset: "approval_prompts" });
  assert.equal(v.preset, "approval_prompts");
  ["banner", "sound", "push"].forEach(function (surface) {
    assert.equal(m.store.allows("u1", surface, "approval"), true);
    assert.equal(m.store.allows("u1", surface, "approval_reminder"), true);
    assert.equal(m.store.allows("u1", surface, "turn_done"), false);
    assert.equal(m.store.allows("u1", surface, "messages"), false);
  });
  assert.equal(m.store.allows("u1", "push", "system"), true, "a login or update notice is not a preset's to mute");
});

test("'Approval reminders only' has no first notice: the prompt is muted, its reminder is not", function () {
  var m = memoryStore();
  m.store.set("u1", { preset: "approval_reminders" });
  ["banner", "sound", "push"].forEach(function (surface) {
    assert.equal(m.store.allows("u1", surface, "approval"), false);
    assert.equal(m.store.allows("u1", surface, "approval_reminder"), true);
    assert.equal(m.store.allows("u1", surface, "turn_done"), false);
  });
});

test("a per-cell change makes the preset Custom and 'all' restores the defaults", function () {
  var m = memoryStore();
  var v = m.store.set("u1", { surfaces: { push: { loop: false } } });
  assert.equal(v.preset, null);
  assert.equal(m.store.allows("u1", "push", "loop"), false);
  assert.equal(m.store.allows("u1", "banner", "loop"), true);
  assert.equal(m.store.set("u1", { preset: "all" }).preset, "all");
  assert.equal(m.store.allows("u1", "push", "loop"), true);
});

test("preferences are per user and survive a restart of the store", function () {
  var m = memoryStore();
  m.store.set("alice", { preset: "approval_reminders" });
  assert.equal(m.store.allows("alice", "push", "turn_done"), false);
  assert.equal(m.store.allows("bob", "push", "turn_done"), true);
  var reloaded = prefs.createPrefsStore({ file: m.file, persist: function () { return Promise.resolve(); } });
  assert.equal(reloaded.allows("alice", "push", "turn_done"), false);
  assert.equal(reloaded.view("alice").preset, "approval_reminders");
  assert.equal(reloaded.allows("bob", "push", "turn_done"), true);
});

test("a daemon without accounts keeps one set under the default user", function () {
  var m = memoryStore();
  m.store.set(null, { preset: "approval_prompts" });
  assert.equal(m.store.allows(undefined, "push", "turn_done"), false);
  assert.ok(JSON.parse(fs.readFileSync(m.file, "utf8")).users[prefs.DEFAULT_USER]);
});

test("stored and client-sent junk never becomes a preference", function () {
  var m = memoryStore({ version: 1, users: { u1: { push: { turn_done: "no", approval: false, bogus: false }, banner: 7 } } });
  var got = m.store.get("u1");
  assert.equal(got.push.turn_done, true, "a non-boolean is ignored");
  assert.equal(got.push.approval, false);
  assert.equal(got.push.bogus, undefined);
  m.store.set("u1", { preset: "__proto__", surfaces: { push: { constructor: false, loop: "x" }, nope: { loop: false } } });
  assert.equal(m.store.get("u1").push.loop, true);
});

test("first load carries the browser's old sound switch once, and not over an existing choice", function () {
  var m = memoryStore();
  assert.equal(m.store.view("u1").known, false);
  m.store.migrateLegacy("u1", { sound: false });
  assert.equal(m.store.view("u1").known, true);
  assert.equal(m.store.allows("u1", "sound", "turn_done"), false);
  m.store.set("u1", { surfaces: { sound: { turn_done: true } } });
  m.store.migrateLegacy("u1", { sound: false });
  assert.equal(m.store.allows("u1", "sound", "turn_done"), true, "a second migrate does not undo a choice");
});

test("categories cover every notification type and push payload the daemon raises", function () {
  assert.equal(prefs.categoryOfNotification("response_done"), "turn_done");
  assert.equal(prefs.categoryOfNotification("permission_request"), "approval");
  assert.equal(prefs.categoryOfNotification("permission_reminder"), "approval_reminder");
  assert.equal(prefs.categoryOfNotification("loop_error"), "loop");
  assert.equal(prefs.categoryOfNotification("auth_required"), "system");
  assert.equal(prefs.categoryOfNotification("constructor"), null);
  assert.equal(prefs.categoryOfPush({ type: "done", tag: "claude-done" }), "turn_done");
  assert.equal(prefs.categoryOfPush({ type: "done", tag: "ralph-loop-done" }), "loop");
  ["permission_request", "elicitation", "ask_user"].forEach(function (t) {
    assert.equal(prefs.categoryOfPush({ type: t }), "approval", t);
  });
  assert.equal(prefs.categoryOfPush({ type: "permission_reminder" }), "approval_reminder");
  assert.equal(prefs.categoryOfPush({ type: "test" }), null, "the silent validation push is never filtered");
});

test("the default store file is notification-prefs.json under the console config directory", function () {
  var config = require("../lib/config");
  assert.equal(path.basename(config.CONFIG_DIR), "console");
  assert.equal(prefs.FILE_NAME, "notification-prefs.json");
});

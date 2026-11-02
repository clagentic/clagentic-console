"use strict";

// The browser half of the notification preferences: the server's copy decides
// what alerts, nothing is decided before it arrives, and the old localStorage
// sound switch is offered to the server once.

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var { pathToFileURL } = require("url");

var MODULES = path.join(__dirname, "..", "lib", "public", "modules");

async function load() {
  var storage = {};
  global.localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null; },
    setItem: function (k, v) { storage[k] = String(v); },
  };
  global.document = { getElementById: function () { return null; } };
  var sent = [];
  var wsRef = await import(pathToFileURL(path.join(MODULES, "ws-ref.js")).href);
  wsRef.setWs({ readyState: 1, send: function (raw) { sent.push(JSON.parse(raw)); } });
  var mod = await import(pathToFileURL(path.join(MODULES, "notification-prefs.js")).href + "?c=" + Math.random());
  return { mod: mod, sent: sent, storage: storage, wsRef: wsRef };
}

function prefsMsg(over) {
  var all = { turn_done: true, approval: true, approval_reminder: true, loop: true, messages: true, system: true };
  return Object.assign({
    type: "notification_prefs", known: true, preset: "all", categories: [], presets: [],
    prefs: { banner: Object.assign({}, all), sound: Object.assign({}, all), push: Object.assign({}, all) },
  }, over || {});
}

test("before the server has answered, and for an uncategorised item, everything is wanted", async function () {
  var c = await load();
  assert.equal(c.mod.hasNotificationPrefs(), false);
  assert.equal(c.mod.isSurfaceWanted("banner", "turn_done"), true);
  c.mod.handleNotificationPrefs(prefsMsg());
  assert.equal(c.mod.isSurfaceWanted("banner", null), true);
});

test("a muted cell suppresses that surface for that category only", async function () {
  var c = await load();
  var m = prefsMsg();
  m.prefs.banner.turn_done = false;
  c.mod.handleNotificationPrefs(m);
  assert.equal(c.mod.isSurfaceWanted("banner", "turn_done"), false);
  assert.equal(c.mod.isSurfaceWanted("sound", "turn_done"), true);
  assert.equal(c.mod.isSurfaceWanted("banner", "approval"), true);
});

test("the old sound switch is offered to the server once, when the server has no copy", async function () {
  var c = await load();
  c.storage["notif-sound"] = "0";
  c.mod.handleNotificationPrefs(prefsMsg({ known: false }));
  assert.deepEqual(c.sent, [{ type: "notification_prefs_migrate", legacy: { sound: false } }]);
  c.mod.handleNotificationPrefs(prefsMsg({ known: false }));
  assert.equal(c.sent.length, 1, "not again");
});

test("nothing is offered when the server already holds the user's preferences", async function () {
  var c = await load();
  c.storage["notif-sound"] = "0";
  c.mod.handleNotificationPrefs(prefsMsg({ known: true }));
  assert.deepEqual(c.sent, []);
});

test("a notification chimes only while the tab is hidden and the type's sound preference is on", async function () {
  var c = await load();
  var reminder = { type: "permission_reminder", category: "approval_reminder" };
  var turn = { type: "response_done", category: "turn_done" };
  var request = { type: "permission_request", category: "approval" };
  var soundOnForReminder = prefsMsg();
  soundOnForReminder.prefs.sound.approval_reminder = true;
  var defaults = prefsMsg();
  ["turn_done", "approval", "approval_reminder", "loop", "messages", "system"].forEach(function (k) {
    defaults.prefs.sound[k] = k === "turn_done";
  });

  c.mod.handleNotificationPrefs(defaults);
  global.document.hidden = false;
  assert.equal(c.mod.shouldChimeForNotification(reminder, true), false, "focused tab: no sound");
  assert.equal(c.mod.shouldChimeForNotification(request, true), false, "focused tab: no sound");

  global.document.hidden = true;
  assert.equal(c.mod.shouldChimeForNotification(reminder, true), false, "hidden, defaults: a reminder is silent");
  assert.equal(c.mod.shouldChimeForNotification(request, true), false, "hidden, defaults: a prompt is silent");
  assert.equal(c.mod.shouldChimeForNotification(turn, true), false, "a finished turn plays its own chime, not this one");

  c.mod.handleNotificationPrefs(soundOnForReminder);
  assert.equal(c.mod.shouldChimeForNotification(reminder, true), true, "hidden, reminder sound on: a chime per reminder");
  assert.equal(c.mod.shouldChimeForNotification(reminder, false), false, "the browser's own sound switch off: silent");
  global.document.hidden = false;
  assert.equal(c.mod.shouldChimeForNotification(reminder, true), false, "focused again: silent");
  delete global.document.hidden;
});

"use strict";

// Push is filtered where it is sent, with the stored preferences of the user
// each subscription belongs to: a muted type never reaches that user's phone.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var home = fs.mkdtempSync(path.join(os.tmpdir(), "push-prefs-"));
process.env.CLAGENTIC_CONSOLE_HOME = home;

var webpush = require("web-push");
var { initPush } = require("../lib/push");
var { createPrefsStore } = require("../lib/notification-prefs");

var sent = [];
webpush.sendNotification = function (sub, json) {
  var body = JSON.parse(json);
  if (body.type !== "test") sent.push({ endpoint: sub.endpoint, type: body.type });
  return Promise.resolve();
};

function setup() {
  sent.length = 0;
  var prefs = createPrefsStore({ file: path.join(home, "prefs-" + Math.random() + ".json"), persist: function () { return Promise.resolve(); } });
  var push = initPush({ prefs: prefs });
  push.addSubscription({ endpoint: "https://push.invalid/alice-phone" }, null, "alice");
  push.addSubscription({ endpoint: "https://push.invalid/bob-phone" }, null, "bob");
  sent.length = 0;
  return { push: push, prefs: prefs };
}

test("a muted type is not sent to the user's subscription; another user's is unaffected", function () {
  var w = setup();
  w.prefs.set("alice", { preset: "approval_reminders" });
  w.push.sendPush({ type: "response_done", title: "t", body: "b" });
  assert.deepEqual(sent.map(function (s) { return s.endpoint; }), ["https://push.invalid/bob-phone"]);
});

test("a close push for a muted category is not sent either", function () {
  var w = setup();
  w.prefs.set("alice", { preset: "approval_reminders" });
  w.push.sendPushToUser("alice", { type: "notify_close", closes: "permission_request", tags: ["t"] });
  assert.deepEqual(sent, []);
});

test("with 'Approval reminders only' a prompt is not pushed and its reminder is", function () {
  var w = setup();
  w.prefs.set("alice", { preset: "approval_reminders" });
  w.push.sendPushToUser("alice", { type: "permission_request", requestId: "r1" });
  w.push.sendPushToUser("alice", { type: "elicitation" });
  w.push.sendPushToUser("alice", { type: "ask_user" });
  assert.deepEqual(sent, [], "no first notice");
  w.push.sendPushToUser("alice", { type: "permission_reminder", tag: "prompt-reminder-a:1" });
  assert.deepEqual(sent.map(function (s) { return s.type; }), ["permission_reminder"]);
});

test("with 'Approval prompts only' prompts are pushed and finished turns are not", function () {
  var w = setup();
  w.prefs.set("alice", { preset: "approval_prompts" });
  w.push.sendPushToUser("alice", { type: "permission_request" });
  w.push.sendPushToUser("alice", { type: "response_done" });
  assert.deepEqual(sent.map(function (s) { return s.type; }), ["permission_request"]);
});

test("a subscription with no account follows the default user's preferences", function () {
  sent.length = 0;
  var prefs = createPrefsStore({ file: path.join(home, "prefs-default.json"), persist: function () { return Promise.resolve(); } });
  var push = initPush({ prefs: prefs, isMultiUser: function () { return false; } });
  push.addSubscription({ endpoint: "https://push.invalid/only-phone" }, null, null);
  sent.length = 0;
  prefs.set(null, { surfaces: { push: { turn_done: false } } });
  push.sendPush({ type: "response_done" });
  assert.deepEqual(sent, []);
  push.sendPush({ type: "permission_request" });
  assert.equal(sent.length, 1);
});

test("without preferences wired, push behaves as before", function () {
  sent.length = 0;
  var push = initPush();
  push.addSubscription({ endpoint: "https://push.invalid/legacy" }, null, "carol");
  sent.length = 0;
  push.sendPushToUser("carol", { type: "response_done" });
  assert.equal(sent.length, 1);
});

"use strict";

// A push aimed at a user reaches that user's device only if the subscription
// carries the user. The project-scoped subscribe route dropped the user, so in
// multi-user mode a user-targeted push matched nothing and said nothing.

var test = require("node:test");
var assert = require("node:assert/strict");
var { EventEmitter } = require("events");
var fs = require("fs");
var os = require("os");
var path = require("path");

var home = fs.mkdtempSync(path.join(os.tmpdir(), "push-sub-user-"));
process.env.CLAGENTIC_CONSOLE_HOME = home;

var webpush = require("web-push");
var config = require("../lib/config");
var { initPush } = require("../lib/push");
var store = require("../lib/store");
var subsFile = path.join(config.CONFIG_DIR, "push-subs.json");
var { attachHTTP } = require("../lib/project-http");

var sent = [];
webpush.sendNotification = function (sub, json) {
  var body = JSON.parse(json);
  if (body.type !== "test") sent.push({ endpoint: sub.endpoint, type: body.type });
  return Promise.resolve();
};

var logs = [];
var realLog = console.log;

function capture() {
  logs.length = 0;
  console.log = function (line) { logs.push(String(line)); };
}
function release() { console.log = realLog; }

// Earlier tests leave queued writes of push-subs.json. The seed goes through
// the same per-file write queue, so it lands after every one of them and the
// returned promise settles when it has.
function seedStored(subs) {
  return store.writeJson("push-subs.json", { subs: subs });
}

function setup(multi) {
  sent.length = 0;
  fs.rmSync(subsFile, { force: true });
  return initPush({ isMultiUser: function () { return multi; } });
}

// Drives the real project-scoped route with a request carrying (or not) the
// user the server resolved from the login cookie.
function projectSubscribe(push, user, sub, replaceEndpoint) {
  var handler = attachHTTP({ cwd: "/p", slug: "p", pushModule: push, osUsers: false });
  var req = new EventEmitter();
  req.method = "POST";
  req.url = "/p/p/api/push-subscribe";
  req.headers = {};
  req._clagenticUser = user;
  var out = { status: null };
  var done = new Promise(function (resolve) {
    var res = {
      writeHead: function (code) { out.status = code; },
      end: function (b) { out.body = b; resolve(out); },
    };
    handler.handleHTTP(req, res, "/api/push-subscribe");
  });
  req.emit("data", JSON.stringify({ subscription: sub, replaceEndpoint: replaceEndpoint || null }));
  req.emit("end");
  return done;
}

var PUSH = { type: "permission_reminder", tag: "t" };

test("an authenticated project-scoped subscribe receives a push aimed at that user", async function () {
  var push = setup(true);
  var out = await projectSubscribe(push, { id: "u1" }, { endpoint: "https://push.invalid/u1-phone" });
  assert.equal(out.status, 200);
  push.sendPushToUser("u1", PUSH);
  assert.deepEqual(sent.map(function (s) { return s.endpoint; }), ["https://push.invalid/u1-phone"]);
});

test("a project-scoped subscribe with no proven user is refused in multi-user mode and not stored", async function () {
  var push = setup(true);
  var out = await projectSubscribe(push, null, { endpoint: "https://push.invalid/anon" });
  assert.equal(out.status, 401);
  push.sendPush({ type: "done", tag: "claude-done" });
  assert.deepEqual(sent, []);
});

test("an authenticated re-register claims a subscription stored without a user", async function () {
  await seedStored([{ endpoint: "https://push.invalid/old-phone", keys: { p256dh: "x", auth: "y" } }]);
  var push = initPush({ isMultiUser: function () { return true; } });
  sent.length = 0;
  push.sendPushToUser("u1", PUSH);
  assert.deepEqual(sent, [], "unclaimed, it belongs to nobody");
  push.addSubscription({ endpoint: "https://push.invalid/old-phone", keys: { p256dh: "x", auth: "y" } }, null, "u1");
  push.sendPushToUser("u1", PUSH);
  assert.deepEqual(sent.map(function (s) { return s.endpoint; }), ["https://push.invalid/old-phone"]);
});

test("an anonymous subscription is neither targeted nor broadcast to in multi-user mode", async function () {
  await seedStored([
    { endpoint: "https://push.invalid/anon" },
    { endpoint: "https://push.invalid/u1", _userId: "u1" },
  ]);
  var push = initPush({ isMultiUser: function () { return true; } });
  sent.length = 0;
  push.sendPush({ type: "done", tag: "claude-done" });
  push.sendPushToUser("u2", PUSH);
  assert.deepEqual(sent.map(function (s) { return s.endpoint; }), ["https://push.invalid/u1"]);
});

test("a mode that cannot be read counts as multi-user", function () {
  var push = initPush({ isMultiUser: function () { throw new Error("unreadable"); } });
  assert.equal(push.addSubscription({ endpoint: "https://push.invalid/x" }, null, null), false);
});

test("single-user mode is unchanged: anonymous subscriptions are stored and broadcast to", async function () {
  var push = setup(false);
  var out = await projectSubscribe(push, null, { endpoint: "https://push.invalid/solo" });
  assert.equal(out.status, 200);
  push.sendPush({ type: "done", tag: "claude-done" });
  assert.deepEqual(sent.map(function (s) { return s.endpoint; }), ["https://push.invalid/solo"]);
});

test("a push aimed at a user with no subscription logs one no-subscription line, without endpoint or keys", function () {
  var push = setup(true);
  push.addSubscription({ endpoint: "https://push.invalid/u1", keys: { p256dh: "SECRETKEY", auth: "SECRETAUTH" } }, null, "u1");
  capture();
  try {
    push.sendPushToUser("u2", PUSH);
  } finally {
    release();
  }
  assert.deepEqual(logs, ["[push] no-subscription user=u2 type=permission_reminder"]);
});

// Callers that reach sendPushToUser through the audience rule or directly. Each
// runs over the real push module with a stored subscription, so the delivery
// and the log line are what the device and the operator would see.

var { createPromptRegistry } = require("../lib/prompt-registry");
var { attachNotifications } = require("../lib/project-notifications");
var { createPromptReminders } = require("../lib/prompt-reminders");
var { pushForSession } = require("../lib/push-audience");
var { attachUserMention } = require("../lib/project-user-mention");

var MIN = 60000;

function reminderWorld(push, ownerId) {
  var clock = { t: 1000000 };
  var session = { localId: 1, title: "Session 1", ownerId: ownerId };
  var nm = attachNotifications({ broadcastAll: function () {}, sendToUser: function () {}, pushModule: null });
  var registry = createPromptRegistry({
    index: Object.create(null),
    getSession: function () { return session; },
    sendAndRecord: function () {},
    saveSessionFile: function () {},
    getNotificationsModule: function () { return nm; },
    getProjectName: function () { return "proj"; },
  });
  var realNow = Date.now;
  Date.now = function () { return clock.t; };
  var rem = createPromptReminders({
    notifications: nm,
    push: push,
    isMultiUser: function () { return true; },
    listAdmins: function () { return []; },
    getConfig: function () { return null; },
    now: function () { return clock.t; },
    listSessions: function () { return [{ slug: "p", project: "Proj", session: session, prompts: registry }]; },
  });
  rem.start();
  registry.open(session, "permission", { toolName: "Bash", toolInput: { command: "ls" } },
    { toolUseId: "t1", notification: { title: "t", slug: "p", sessionId: 1 } });
  return {
    fire: function (minutes) { clock.t += minutes * MIN; rem.sweep(true); },
    done: function () { rem.stop(); Date.now = realNow; },
  };
}

test("a reminder push to an owner whose subscription was claimed is delivered; an unclaimed one is not", async function () {
  await seedStored([{ endpoint: "https://push.invalid/old-phone", keys: { p256dh: "x", auth: "y" } }]);
  var push = initPush({ isMultiUser: function () { return true; } });
  var w = reminderWorld(push, "u1");
  try {
    sent.length = 0;
    w.fire(6);
    assert.deepEqual(sent, [], "stored without a user, it belongs to nobody");
    push.addSubscription({ endpoint: "https://push.invalid/old-phone", keys: { p256dh: "x", auth: "y" } }, null, "u1");
    w.fire(10);
    assert.deepEqual(sent.map(function (s) { return s.endpoint + " " + s.type; }), ["https://push.invalid/old-phone permission_reminder"]);
  } finally { w.done(); }
});

test("a loop-complete push follows the session audience: the owner's claimed subscription gets it, other users' do not", function () {
  var push = setup(true);
  push.addSubscription({ endpoint: "https://push.invalid/u1", keys: { p256dh: "x", auth: "y" } }, null, "u1");
  push.addSubscription({ endpoint: "https://push.invalid/u2", keys: { p256dh: "x", auth: "y" } }, null, "u2");
  var payload = { type: "done", slug: "p", title: "Loop Complete", body: "Completed after 3 iteration(s)", tag: "ralph-loop-done" };
  var where = pushForSession(push, "u1", payload, function () { return true; }, function () { return []; });
  assert.equal(where, "owner");
  assert.deepEqual(sent.map(function (s) { return s.endpoint; }), ["https://push.invalid/u1"]);
});

test("a user mention push to a user with no subscription logs the no-subscription line once", function () {
  var push = setup(true);
  var mention = attachUserMention({
    slug: "p",
    sm: { recordHistoryEntry: function () {}, appendToSessionFile: function () {} },
    send: function () {},
    sendTo: function () {},
    sendToSession: function () {},
    sendToSessionOthers: function () {},
    getSessionForWs: function () { return { localId: 1 }; },
    getLinuxUserForSession: function () { return null; },
    saveImageFile: function () { return null; },
    usersModule: { findUserById: function (id) { return { id: id, username: id }; } },
    pushModule: push,
  });
  capture();
  try {
    mention.handleUserMention({ _clagenticUser: { id: "u1", username: "u1" } }, { targetUserId: "u2", text: "look" });
  } finally {
    release();
  }
  assert.deepEqual(logs, ["[push] no-subscription user=u2 type=user_mention"]);
});

test("a direct-message push to a user with no subscription logs the no-subscription line once", function () {
  var push = setup(true);
  capture();
  try {
    push.sendPushToUser("u2", { type: "dm", title: "u1", body: "hi", tag: "dm-k", dmKey: "k" });
  } finally {
    release();
  }
  assert.deepEqual(logs, ["[push] no-subscription user=u2 type=dm"]);
});

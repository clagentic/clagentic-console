"use strict";

// The in-app permission_request banner carries tool input, so it follows the
// push audience (lib/push-audience.js): live (notify) and on connect
// (sendConnectionState).

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

process.env.CLAGENTIC_CONSOLE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-banner-audience-"));

var { attachNotifications } = require("../lib/project-notifications");

function world(multi) {
  var sent = [];
  var nm = attachNotifications({
    broadcastAll: function (m) { sent.push({ to: "everyone", msg: m }); },
    sendToUser: function (u, m) { sent.push({ to: u, msg: m }); },
    pushModule: null,
    isMultiUser: function () { return multi; },
    listAdmins: function () { return ["admin-1"]; },
  });
  function request(ownerId) {
    nm.notify("permission_request", {
      title: "Run Bash", slug: "proj", sessionId: "s1", ownerId: ownerId || null,
      requestId: "r-" + Math.random(), toolName: "Bash", toolInput: { command: "cat secrets" },
    });
  }
  function connect(userId) {
    var state = null;
    nm.sendConnectionState({ _clagenticUser: userId ? { id: userId } : undefined }, function (ws, m) {
      if (m.type === "notifications_state") state = m;
    });
    return state.notifications.filter(function (n) { return n.type === "permission_request"; }).length;
  }
  function recipients() { return sent.map(function (s) { return s.to; }); }
  return { request: request, connect: connect, recipients: recipients };
}

test("multi-user, ownerless: the admins get the banner, a non-admin neither live nor on connect", function () {
  var w = world(true);
  w.request(null);
  assert.deepEqual(w.recipients(), ["admin-1"]);
  assert.equal(w.connect("admin-1"), 1);
  assert.equal(w.connect("bob"), 0);
  assert.equal(w.connect(null), 0);
});

test("multi-user, owned: the owner gets the banner, another user neither live nor on connect", function () {
  var w = world(true);
  w.request("alice");
  assert.deepEqual(w.recipients(), ["alice"]);
  assert.equal(w.connect("alice"), 1);
  assert.equal(w.connect("bob"), 0);
});

test("single-user, ownerless: broadcast and shown to every connection, as before", function () {
  var w = world(false);
  w.request(null);
  assert.deepEqual(w.recipients(), ["everyone"]);
  assert.equal(w.connect(null), 1);
});

// The badge counts what the viewer is shown, on connect and on every live send.
function countWorld(multi) {
  var sent = [];
  // Notifications persist on disk and load at attach; start each world empty.
  fs.rmSync(path.join(require("../lib/config").CONFIG_DIR, "notifications.json"), { force: true });
  var nm = attachNotifications({
    broadcastAll: function (m) { sent.push({ to: "everyone", msg: m }); },
    sendToUser: function (u, m) { sent.push({ to: u, msg: m }); },
    broadcastPerViewer: function (build) {
      ["admin-1", "bob"].forEach(function (u) { sent.push({ to: u, msg: build(u) }); });
    },
    pushModule: null,
    isMultiUser: function () { return multi; },
    listAdmins: function () { return ["admin-1"]; },
  });
  function connectCount(userId) {
    var count = null;
    nm.sendConnectionState({ _clagenticUser: userId ? { id: userId } : undefined }, function (ws, m) {
      if (m.type === "notifications_state") count = m.unreadCount;
    });
    return count;
  }
  return { nm: nm, sent: sent, connectCount: connectCount };
}

test("multi-user: an ownerless banner is withheld from a non-admin, so their count excludes it", function () {
  var w = countWorld(true);
  w.nm.notify("permission_request", { title: "Run", slug: "p", sessionId: "s", ownerId: null, requestId: "r1", toolName: "Bash", toolInput: {} });
  w.nm.notify("mate_dm", { senderName: "x", preview: "hi" });
  assert.equal(w.connectCount("admin-1"), 2);
  assert.equal(w.connectCount("bob"), 1);
  assert.equal(w.connectCount(null), 1);
  var created = w.sent.filter(function (s) { return s.msg.type === "notification_created"; });
  var toBob = created.filter(function (s) { return s.to === "bob"; });
  assert.equal(toBob.length, 1);
  assert.equal(toBob[0].msg.unreadCount, 1);
  var adminLast = created.filter(function (s) { return s.to === "admin-1"; }).pop();
  assert.equal(adminLast.msg.unreadCount, 2);
});

test("multi-user: dismissing sends each viewer their own count", function () {
  var w = countWorld(true);
  var audience = { ownerId: null, isMultiUser: function () { return true; }, listAdmins: function () { return ["admin-1"]; } };
  var core = require("../lib/notify").notifyFor(null, w.nm);
  core.notify("permission_request", { slug: "p", sessionId: 1, requestId: "r1" }, { push: { title: "Run", body: "" }, banner: { title: "Run", toolName: "Bash", toolInput: {} } }, audience);
  w.nm.notify("mate_dm", { senderName: "x", preview: "hi" });
  w.sent.length = 0;
  core.resolve({ slug: "p", sessionId: 1, requestId: "r1" }, audience);
  var dismissed = w.sent.filter(function (s) { return s.msg.type === "notification_dismissed"; });
  assert.equal(dismissed.length, 2);
  dismissed.forEach(function (s) { assert.equal(s.msg.unreadCount, 1); });
  assert.equal(w.connectCount("bob"), 1);
  assert.equal(w.connectCount("admin-1"), 1);
});

test("single-user: counts are unchanged", function () {
  var w = countWorld(false);
  w.nm.notify("permission_request", { title: "Run", slug: "p", sessionId: "s", ownerId: null, requestId: "r1", toolName: "Bash", toolInput: {} });
  w.nm.notify("mate_dm", { senderName: "x", preview: "hi" });
  assert.equal(w.connectCount(null), 2);
  assert.equal(w.connectCount("bob"), 2);
});

// A client's dismiss and clear-all act only on what the requesting user is
// shown (visibleTo), and each viewer is told only the ids it could see go.
// Notifications come from the real notify/show path; the frames are the
// per-viewer messages the store sends.
var buildNotify = require("../lib/build-update-notify");

var VIEWERS = ["admin-1", "alice", "bob"];

function dismissWorld(multi) {
  fs.rmSync(path.join(require("../lib/config").CONFIG_DIR, "notifications.json"), { force: true });
  var frames = [];
  var created = {};
  var resolved = [];
  var pushCalls = [];
  function record(to, m) {
    if (m.type === "notification_created") created[m.notification.type + ":" + (m.notification.targetUserId || (m.notification.targetUserIds || []).join(",") || "all")] = m.notification.id;
    frames.push({ to: to, msg: m });
  }
  var push = {
    sendPush: function (p) { pushCalls.push(p); },
    sendPushToUser: function (u, p) { pushCalls.push(p); },
  };
  var nm = attachNotifications({
    broadcastAll: function (m) { record("everyone", m); },
    sendToUser: function (u, m) { record(u, m); },
    broadcastPerViewer: function (build) { VIEWERS.forEach(function (u) { record(u, build(u)); }); },
    pushModule: push,
    isMultiUser: function () { return multi; },
    listAdmins: function () { return ["admin-1"]; },
    onResolvedByOperator: function (type) { resolved.push(type); },
  });
  var env = { push: push, inApp: nm, isMultiUser: function () { return multi; }, listAdmins: function () { return ["admin-1"]; } };
  function stored() {
    var seen = {};
    VIEWERS.concat([null]).forEach(function (u) {
      nm.sendConnectionState({ _clagenticUser: u ? { id: u } : undefined }, function (ws, m) {
        if (m.type === "notifications_state") m.notifications.forEach(function (n) { seen[n.id] = true; });
      });
    });
    return Object.keys(seen).sort();
  }
  return { nm: nm, env: env, frames: frames, created: created, resolved: resolved, pushCalls: pushCalls, stored: stored };
}

function dismissedIds(w, to) {
  return w.frames.filter(function (f) { return f.to === to && f.msg.type === "notification_dismissed"; })
    .map(function (f) { return f.msg.ids; });
}

var DISMISS_ROWS = [
  {
    name: "AC1: a non-admin dismissing the admin-only offer removes nothing and declines nothing",
    multi: true, user: "bob", logs: 1,
    setup: function (w) { buildNotify.showBuildOffer(w.env, { message: "m", buildUpdate: {}, actionable: null }); },
    msg: function (w) { return { type: "notification_dismiss", ids: [w.created["build_update_offer:admin-1"]] }; },
    standing: ["build_update_offer:admin-1"], resolved: [],
    told: { "admin-1": [], alice: [], bob: [] },
  },
  {
    name: "AC2: the admin dismissing the offer removes it and declines it",
    multi: true, user: "admin-1", logs: 0,
    setup: function (w) { buildNotify.showBuildOffer(w.env, { message: "m", buildUpdate: {}, actionable: null }); },
    msg: function (w) { return { type: "notification_dismiss", ids: [w.created["build_update_offer:admin-1"]] }; },
    standing: [], resolved: ["build_update_offer"],
    told: { "admin-1": [["build_update_offer:admin-1"]], alice: [[]], bob: [[]] },
  },
  {
    name: "AC3: a clear-all by a user outside both targets clears only the untargeted notification",
    multi: true, user: "bob", logs: 0,
    setup: function (w) {
      w.nm.notify("update_available", {});
      w.nm.notify("auth_required", { targetUserId: "alice" });
      w.nm.notify("auth_required", { targetUserIds: ["admin-1"] });
    },
    msg: function () { return { type: "notification_dismiss_all" }; },
    standing: ["auth_required:alice", "auth_required:admin-1"], resolved: ["update_available"],
  },
  {
    name: "AC3: a clear-all by a targeted user also clears what is aimed at that user",
    multi: true, user: "alice", logs: 0,
    setup: function (w) {
      w.nm.notify("update_available", {});
      w.nm.notify("auth_required", { targetUserId: "alice" });
      w.nm.notify("mate_dm", { senderName: "x", targetUserIds: ["admin-1"] });
    },
    msg: function () { return { type: "notification_dismiss_all" }; },
    standing: ["mate_dm:admin-1"], resolved: ["auth_required", "update_available"],
  },
  {
    name: "AC4: a dismiss naming a shown and a hidden id removes only the shown one and names only it",
    multi: true, user: "bob", logs: 1,
    setup: function (w) {
      w.nm.notify("mate_dm", { senderName: "x" });
      w.nm.notify("mate_dm", { senderName: "y", targetUserId: "alice" });
    },
    msg: function (w) { return { type: "notification_dismiss", ids: [w.created["mate_dm:all"], w.created["mate_dm:alice"]] }; },
    standing: ["mate_dm:alice"], resolved: [],
    told: { "admin-1": [["mate_dm:all"]], alice: [["mate_dm:all"]], bob: [["mate_dm:all"]] },
  },
  {
    name: "AC5: an admin dismissing an admin-targeted notification does not hand its id to a non-admin",
    multi: true, user: "admin-1", logs: 0,
    setup: function (w) { w.nm.notify("mate_dm", { senderName: "x", targetUserIds: ["admin-1"] }); },
    msg: function (w) { return { type: "notification_dismiss", ids: [w.created["mate_dm:admin-1"]] }; },
    standing: [], resolved: [],
    told: { "admin-1": [["mate_dm:admin-1"]], alice: [[]], bob: [[]] },
  },
  {
    name: "AC6: single-user, a dismiss by id removes the notification and names it to everyone",
    multi: false, user: null, logs: 0,
    setup: function (w) { w.nm.notify("update_available", {}); w.nm.notify("mate_dm", { senderName: "x" }); },
    msg: function (w) { return { type: "notification_dismiss", ids: [w.created["update_available:all"]] }; },
    standing: ["mate_dm:all"], resolved: ["update_available"],
    told: { "admin-1": [["update_available:all"]], alice: [["update_available:all"]], bob: [["update_available:all"]] },
  },
  {
    name: "AC6: single-user, a clear-all clears everything",
    multi: false, user: null, logs: 0,
    setup: function (w) { w.nm.notify("update_available", {}); w.nm.notify("mate_dm", { senderName: "x" }); },
    msg: function () { return { type: "notification_dismiss_all" }; },
    standing: [], resolved: ["update_available"],
  },
];

DISMISS_ROWS.forEach(function (row) {
  test(row.name, function (t) {
    var w = dismissWorld(row.multi);
    row.setup(w);
    var warns = t.mock.method(console, "warn", function () {});
    var ws = { _clagenticUser: row.user ? { id: row.user } : undefined };
    var msg = row.msg(w);
    w.frames.length = 0;
    w.pushCalls.length = 0;
    assert.equal(w.nm.handleNotificationMessage(ws, msg), true);
    assert.deepEqual(w.stored(), row.standing.map(function (k) { return w.created[k]; }).sort());
    assert.deepEqual(w.resolved, row.resolved);
    assert.equal(warns.mock.calls.length, row.logs, "one log line per refused dismiss");
    if (row.resolved.length === 0) assert.deepEqual(w.pushCalls, [], "no close pushed");
    if (row.told) {
      Object.keys(row.told).forEach(function (viewer) {
        var want = row.told[viewer].map(function (list) { return list.map(function (k) { return w.created[k]; }); });
        assert.deepEqual(dismissedIds(w, viewer), want, viewer + " is told only ids it could see go");
      });
    }
  });
});

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
  w.nm.notify("permission_request", { title: "Run", slug: "p", sessionId: "s", ownerId: null, requestId: "r1", toolName: "Bash", toolInput: {} });
  w.nm.notify("mate_dm", { senderName: "x", preview: "hi" });
  w.sent.length = 0;
  w.nm.dismissByRequestId("r1");
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

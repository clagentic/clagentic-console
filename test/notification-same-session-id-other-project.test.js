"use strict";

// Session local ids are unique only within a project, but a user's
// notifications reach every project socket the user has open. Viewing session
// N of project A must not dismiss project B's session N notification, and the
// dismissal is global on the server.

var test = require("node:test");
var assert = require("node:assert/strict");
var { setupToolsEnv, moduleUrl } = require("./fake-dom-prompt-cards");

async function setup(t) {
  await setupToolsEnv(t);
  var storeMod = await import(moduleUrl("store.js"));
  storeMod.store.set({ currentSlug: "proj-a", activeSessionId: 102 });
  var sent = [];
  var wsRef = await import(moduleUrl("ws-ref.js"));
  wsRef.setWs({ readyState: 1, send: function (raw) { sent.push(JSON.parse(raw)); } });
  var mod = await import(moduleUrl("app-notifications.js"));
  return { mod: mod, sent: sent };
}

function created(over) {
  return {
    type: "notification_created", unreadCount: 1,
    notification: Object.assign({
      id: "n-1", type: "permission_request", category: "approval", title: "Run Bash", body: "",
      slug: "proj-b", sessionId: 102, meta: { requestId: "r-1", kind: "permission", toolName: "Bash", toolInput: { command: "ls" } },
    }, over),
  };
}

function dismisses(sent) { return sent.filter(function (m) { return m.type === "notification_dismiss"; }); }

test("a permission_request for another project's same-id session is not dismissed", async function (t) {
  var c = await setup(t);
  c.mod.handleNotificationCreated(created({}));
  assert.deepEqual(dismisses(c.sent), []);
});

test("a permission_reminder for another project's same-id session is not dismissed", async function (t) {
  var c = await setup(t);
  c.mod.handleNotificationCreated(created({ id: "n-2", type: "permission_reminder", category: "approval_reminder" }));
  assert.deepEqual(dismisses(c.sent), []);
});

test("a notification with no project slug is never auto-dismissed by session id alone", async function (t) {
  var c = await setup(t);
  c.mod.handleNotificationCreated(created({ slug: "" }));
  assert.deepEqual(dismisses(c.sent), []);
});

test("a notification for the viewed session of the viewed project is still auto-dismissed", async function (t) {
  var c = await setup(t);
  c.mod.handleNotificationCreated(created({ slug: "proj-a" }));
  assert.deepEqual(dismisses(c.sent), [{ type: "notification_dismiss", ids: ["n-1"] }]);
});

test("another session of the viewed project is not dismissed", async function (t) {
  var c = await setup(t);
  c.mod.handleNotificationCreated(created({ slug: "proj-a", sessionId: 7 }));
  assert.deepEqual(dismisses(c.sent), []);
});

// --- banner tap, persistence and reconcile through the shared client router ---

async function setupBanners(t) {
  var c = await setup(t);
  c.mod.initAppNotifications();
  c.client = await import(moduleUrl("notify-client.js"));
  c.container = global.document.body._children[global.document.body._children.length - 1];
  c.banner = function (id) { return c.container.querySelector('[data-notif-id="' + id + '"]'); };
  c.tap = function (id) {
    c.banner(id)._listeners.click[0]({ target: { closest: function () { return null; } } });
  };
  return c;
}

function switches(sent) { return sent.filter(function (m) { return m.type === "switch_session"; }); }

test("a banner tap for the viewed project switches to its session through routeTo", async function (t) {
  var c = await setupBanners(t);
  c.mod.handleNotificationCreated(created({ slug: "proj-a", sessionId: 7 }));
  c.tap("n-1");
  assert.deepEqual(switches(c.sent), [{ type: "switch_session", id: 7 }]);
});

test("a banner tap for another project's same-numbered session does not switch this project's session (AC3)", async function (t) {
  var c = await setupBanners(t);
  c.mod.handleNotificationCreated(created({ slug: "proj-b", sessionId: 102 }));
  try {
    c.tap("n-1");
  } catch (e) {
    // The fake DOM does not model switchProject's page teardown; what routeTo
    // recorded before it is the behaviour under test.
    assert.match(String(e.message), /ws/);
  }
  assert.deepEqual(switches(c.sent), [], "the open project's own session 102 is not switched to");
  assert.equal(c.client.takePendingSession(), 102, "the route waits for proj-b's connection");
});

test("the banner is closed and its notification dismissed by the tap", async function (t) {
  var c = await setupBanners(t);
  c.mod.handleNotificationCreated(created({ slug: "proj-a", sessionId: 7 }));
  c.tap("n-1");
  assert.deepEqual(dismisses(c.sent), [{ type: "notification_dismiss", ids: ["n-1"] }]);
  assert.ok(c.banner("n-1").classList.contains("hide"));
});

test("persistent versus auto-dismiss comes from the notification's registry flag, not its type (AC4)", async function (t) {
  var c = await setupBanners(t);
  c.mod.handleNotificationCreated(created({ id: "stay", slug: "proj-b", persistent: true }));
  c.mod.handleNotificationCreated(created({ id: "go", slug: "proj-b", persistent: false }));
  c.mod.handleNotificationCreated(created({ id: "mine", slug: "proj-b", type: "user_mention", meta: { persistent: true } }));
  t.mock.timers.tick(3500);
  assert.ok(!c.banner("stay").classList.contains("hide"), "a persistent permission_request stays");
  assert.ok(c.banner("go").classList.contains("hide"), "a non-persistent one, whatever its type, goes");
  assert.ok(!c.banner("mine").classList.contains("hide"), "a banner marked persistent in meta stays");
});

function persistentBanner(over) {
  return created(Object.assign({
    persistent: true, liveInState: true, collapse: "request", key: "n:permission_request:proj-b:102:r-1", createdAt: 1000,
  }, over));
}

test("after a restart the banners of prompts no longer live are removed by the shared live check (AC5)", async function (t) {
  var c = await setupBanners(t);
  c.mod.handleNotificationCreated(persistentBanner({ id: "gone" }));
  c.mod.handleNotificationCreated(persistentBanner({ id: "kept", key: "n:permission_request:proj-b:103:r-9", sessionId: 103, meta: { requestId: "r-9", kind: "permission", toolName: "Bash", toolInput: {} } }));
  var live = { slug: "proj-a", at: 2000, items: [{ sessionId: "103", requestId: "r-9", toolUseId: null }] };
  c.mod.handleNotificationsState({ notifications: [], unreadCount: 0, livePrompts: live });
  assert.ok(c.banner("gone").classList.contains("hide"), "its prompt is not live");
  assert.ok(!c.banner("kept").classList.contains("hide"), "its prompt still waits");
});

test("a banner the server still lists is kept by the same check", async function (t) {
  var c = await setupBanners(t);
  var notif = persistentBanner({ id: "listed" }).notification;
  c.mod.handleNotificationCreated({ type: "notification_created", unreadCount: 1, notification: notif });
  c.mod.handleNotificationsState({ notifications: [notif], unreadCount: 1, livePrompts: { slug: "proj-a", at: 2000, items: [] } });
  assert.ok(!c.banner("listed").classList.contains("hide"));
});

// --- the deep link survives a sessionStorage failure (AC6) ---

function deepLinkEnv(storage) {
  var replaced = [];
  global.location = { pathname: "/p/proj-a/", search: "?session=7&request=r-1", hash: "" };
  global.history = { replaceState: function (a, b, url) { replaced.push(url); } };
  global.sessionStorage = storage;
  return replaced;
}

function throwingStorage() {
  return {
    setItem: function () { throw new Error("quota"); },
    getItem: function () { throw new Error("denied"); },
    removeItem: function () { throw new Error("denied"); },
  };
}

test("a deep link survives a sessionStorage failure: the query stays and the console lands on the session (AC6)", async function (t) {
  var c = await setupBanners(t);
  var replaced = deepLinkEnv(throwingStorage());
  t.after(function () { delete global.sessionStorage; delete global.history; });
  c.client.initNotifyClient();
  assert.deepEqual(replaced, [], "the query is not stripped while it is the only copy");
  c.mod.handleNotificationsState({ notifications: [], unreadCount: 0 });
  assert.deepEqual(switches(c.sent), [{ type: "switch_session", id: 7 }]);
  assert.deepEqual(replaced, ["/p/proj-a/"], "stripped once the route was taken");
});

test("a deep link whose storage works is stripped at once and still routes", async function (t) {
  var c = await setupBanners(t);
  var backing = {};
  var replaced = deepLinkEnv({
    setItem: function (k, v) { backing[k] = String(v); },
    getItem: function (k) { return backing[k] === undefined ? null : backing[k]; },
    removeItem: function (k) { delete backing[k]; },
  });
  t.after(function () { delete global.sessionStorage; delete global.history; });
  c.client.initNotifyClient();
  assert.deepEqual(replaced, ["/p/proj-a/"]);
  c.mod.handleNotificationsState({ notifications: [], unreadCount: 0 });
  assert.deepEqual(switches(c.sent), [{ type: "switch_session", id: 7 }]);
});

test("a route waits for an open connection and is not dropped by a state message before it", async function (t) {
  var c = await setupBanners(t);
  var wsRef = await import(moduleUrl("ws-ref.js"));
  deepLinkEnv(throwingStorage());
  t.after(function () { delete global.sessionStorage; delete global.history; });
  c.client.initNotifyClient();
  wsRef.setWs({ readyState: 0, send: function () { throw new Error("not open"); } });
  c.mod.handleNotificationsState({ notifications: [], unreadCount: 0 });
  wsRef.setWs({ readyState: 1, send: function (raw) { c.sent.push(JSON.parse(raw)); } });
  c.mod.handleNotificationsState({ notifications: [], unreadCount: 0 });
  assert.deepEqual(switches(c.sent), [{ type: "switch_session", id: 7 }]);
});

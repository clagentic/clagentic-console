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

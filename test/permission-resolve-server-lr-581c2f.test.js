"use strict";
// Server-side coverage for the permission resolve path: a grant still lands
// after a long-open request, an unknown/stale response is answered explicitly,
// and every path that ends a request dismisses its notification banner.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { createSDKBridge } = require("../lib/sdk-bridge");
var { attachSessions } = require("../lib/project-sessions");
var { sweepClearedPermissionIndex } = require("../lib/sdk-permission-ownership");

var IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function makeSessionManager(tmpHome) {
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  });
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var sessionsModule;
  try {
    sessionsModule = require("../lib/sessions");
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
  return sessionsModule.createSessionManager({
    cwd: tmpHome,
    send: function () {},
    sendTo: function () {},
    sendEach: function () {},
  });
}

function makeNotifications() {
  var dismissed = [];
  return {
    dismissed: dismissed,
    notify: function () {},
    dismissByRequestId: function (id) { dismissed.push(id); },
  };
}

function makeHarness() {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-perm-resolve-"));
  var sm = makeSessionManager(tmpHome);
  var notifications = makeNotifications();
  var adapter = {
    vendor: "claude",
    createQuery: function () { throw new Error("not used"); },
    init: function () { return Promise.resolve({ models: [], skills: [] }); },
  };
  var bridge = createSDKBridge({
    cwd: tmpHome,
    slug: "test-perm-resolve",
    sessionManager: sm,
    send: function () {},
    adapter: adapter,
    adapters: { claude: adapter },
    getNotificationsModule: function () { return notifications; },
    onProcessingChanged: function () {},
  });
  var sent = [];
  var handlers = attachSessions({
    cwd: tmpHome, slug: "test-perm-resolve", osUsers: false, currentVersion: "0.0.0",
    sm: sm, sdk: bridge, tm: null, clients: [], opts: {},
    getNotificationsModule: function () { return notifications; },
    send: function () {},
    sendTo: function (ws, msg) { sent.push(msg); },
    sendToAdmins: function () {},
    sendToSession: function () {},
    sendToSessionOthers: function () {},
    usersModule: { isMultiUser: function () { return false; } },
    userPresence: null, pushModule: null,
    getSessionForWs: function (ws) { return ws._session || null; },
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: function () { return true; },
    getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function (o) { return o; },
    onProcessingChanged: function () {},
    broadcastPresence: function () {},
    adapter: null,
    getProjectList: function () { return []; },
    getProjectCount: function () { return 0; },
    getScheduleCount: function () { return 0; },
  });
  return { tmpHome: tmpHome, sm: sm, bridge: bridge, handlers: handlers, notifications: notifications, sent: sent };
}

function cleanup(h) {
  try { fs.rmSync(h.tmpHome, { recursive: true, force: true }); } catch (_) {}
}

test("a long-open permission request survives the idle reaper and allow_always still resolves and persists the grant", async function (t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  var h = makeHarness();
  try {
    var session = h.sm.createSessionRaw({});
    session.cliSessionId = "sess-perm-resolve-idle";
    var closed = false;
    session.queryInstance = { close: function () { closed = true; } };
    session.isProcessing = true;
    // Already past the idle window, so only the isProcessing guard can save it.
    session.lastActivityAt = Date.now() - IDLE_TIMEOUT_MS - 60 * 1000;
    session.pendingPermissions = {};
    h.sm.sessions.set(session.localId, session);

    var decision = h.bridge.handleCanUseTool(session, "Write", { file_path: "/tmp/x" }, { toolUseID: "tu-1", signal: null });
    var requestId = Object.keys(session.pendingPermissions)[0];
    assert.ok(requestId, "a pending permission must be registered");

    h.bridge.startIdleReaper();
    t.mock.timers.tick(IDLE_TIMEOUT_MS + 5 * 60 * 1000);
    h.bridge.stopIdleReaper();

    assert.equal(closed, false, "the reaper must not close a session that is still processing");
    assert.ok(session.pendingPermissions[requestId], "the request must still be pending after the idle window");

    h.handlers.handleSessionsMessage({ _session: session }, { type: "permission_response", requestId: requestId, decision: "allow_always" });

    var result = await decision;
    assert.equal(result.behavior, "allow");
    assert.equal(session.allowedTools["Write"], true);
    var sm2 = makeSessionManager(h.tmpHome);
    var rebuilt = null;
    sm2.sessions.forEach(function (s) { if (s.cliSessionId === "sess-perm-resolve-idle") rebuilt = s; });
    assert.ok(rebuilt, "session must be rehydrated from disk");
    assert.equal(rebuilt.allowedTools["Write"], true, "the grant must persist across rehydration");
  } finally {
    t.mock.timers.reset();
    cleanup(h);
  }
});

test("resolving a request dismisses its notification", function () {
  var h = makeHarness();
  try {
    var session = h.sm.createSessionRaw({});
    session.pendingPermissions = {};
    h.sm.sessions.set(session.localId, session);
    var decision = h.bridge.handleCanUseTool(session, "Write", { file_path: "/tmp/x" }, { toolUseID: "tu-2", signal: null });
    var requestId = Object.keys(session.pendingPermissions)[0];
    assert.ok(requestId, "a pending permission must be registered");

    h.handlers.handleSessionsMessage({ _session: session }, { type: "permission_response", requestId: requestId, decision: "allow" });

    assert.deepEqual(h.notifications.dismissed, [requestId]);
    return decision;
  } finally {
    cleanup(h);
  }
});

test("a response for an unknown request gets an explicit stale reply and its banner is dismissed", function () {
  var h = makeHarness();
  try {
    var session = h.sm.createSessionRaw({});
    session.pendingPermissions = {};

    h.handlers.handleSessionsMessage({ _session: session }, { type: "permission_response", requestId: "does-not-exist", decision: "allow_always" });

    assert.deepEqual(h.sent, [{ type: "permission_cancel", requestId: "does-not-exist", reason: "stale" }]);
    assert.deepEqual(h.notifications.dismissed, ["does-not-exist"]);
  } finally {
    cleanup(h);
  }
});

test("a response with no resolvable session still gets a stale reply", function () {
  var h = makeHarness();
  try {
    h.handlers.handleSessionsMessage({}, { type: "permission_response", requestId: "orphan", decision: "allow" });
    assert.deepEqual(h.sent, [{ type: "permission_cancel", requestId: "orphan", reason: "stale" }]);
  } finally {
    cleanup(h);
  }
});

test("aborting a pending request dismisses its notification", function () {
  var h = makeHarness();
  try {
    var session = h.sm.createSessionRaw({});
    session.pendingPermissions = {};
    var ac = new AbortController();
    var decision = h.bridge.handleCanUseTool(session, "Write", { file_path: "/tmp/x" }, { toolUseID: "tu-3", signal: ac.signal });
    var requestId = Object.keys(session.pendingPermissions)[0];
    assert.ok(requestId, "a pending permission must be registered");

    ac.abort();

    assert.deepEqual(h.notifications.dismissed, [requestId]);
    return decision;
  } finally {
    cleanup(h);
  }
});

test("the turn-boundary sweep reports every dropped request but not kept ones", function () {
  var sm = { permissionRequestIndex: { a: 1, b: 1 } };
  var prev = { a: { resolve: function () {} }, b: { resolve: function () {} } };
  var dropped = [];

  sweepClearedPermissionIndex(sm, prev, { b: prev.b }, function (id) { dropped.push(id); });

  assert.deepEqual(dropped, ["a"]);
});

test("notifications module dismissByRequestId removes only the matching permission banner", function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-perm-notif-"));
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  try {
    ["../lib/config", "../lib/project-notifications"].forEach(function (m) {
      try { delete require.cache[require.resolve(m)]; } catch (_) {}
    });
    var { attachNotifications } = require("../lib/project-notifications");
    var broadcasts = [];
    var nm = attachNotifications({ broadcastAll: function (m) { broadcasts.push(m); }, pushModule: null });
    nm.notify("permission_request", { requestId: "r1", toolName: "Bash" });
    nm.notify("permission_request", { requestId: "r2", toolName: "Bash" });

    nm.dismissByRequestId("r1");

    var dismissals = broadcasts.filter(function (m) { return m.type === "notification_dismissed"; });
    assert.equal(dismissals.length, 1);
    assert.equal(dismissals[0].ids.length, 1);
    assert.equal(nm.getUnreadCount(), 1);
    nm.dismissByRequestId("unknown");
    assert.equal(nm.getUnreadCount(), 1);
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
    ["../lib/config", "../lib/project-notifications"].forEach(function (m) {
      try { delete require.cache[require.resolve(m)]; } catch (_) {}
    });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

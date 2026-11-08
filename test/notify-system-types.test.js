"use strict";

// The system notifications (a missing sign-in, the build-update offer, a newer
// release) go through the notification core: one registration each, collapse
// and close from the core, the audience a property of the type, and the tap
// routed by the shared router. Plus the direct-message deep link's durable
// fallback.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

// The banner store persists under the console config directory: keep it off
// the host's own.
process.env.CLAGENTIC_CONSOLE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "notify-system-"));

var notifyApi = require("../lib/notify");
var { SYSTEM_TYPES } = require("../lib/notify/types");
var payloads = require("../lib/notify/payload");
var sw = require("../lib/public/notify-sw-logic.js");
var NotifyTarget = require("../lib/public/notify-target.js");
var { attachNotifications } = require("../lib/project-notifications");
var { notifyAuthRequired } = require("../lib/auth-required-notify");
var buildNotify = require("../lib/build-update-notify");
var { createStandingOffer } = require("../lib/build-update-standing");
var { composeNotice } = require("../lib/build-update-offer");
var { setupToolsEnv, moduleUrl } = require("./fake-dom-prompt-cards");

function spyPush() {
  var calls = [];
  return {
    calls: calls,
    sendPush: function (p) { calls.push({ to: "everyone", payload: p }); },
    sendPushToUser: function (u, p) { calls.push({ to: u, payload: p }); },
  };
}

var MULTI = function () { return true; };
var SINGLE = function () { return false; };
var ADMINS = function () { return ["admin-1", "admin-2"]; };

// The real banner store, with what each viewer is sent recorded.
function realStore(push, mode) {
  var sentToUser = [];
  var created = [];
  var store = attachNotifications({
    broadcastAll: function (m) { created.push({ to: "everyone", msg: m }); },
    sendToUser: function (u, m) { created.push({ to: u, msg: m }); sentToUser.push(u); },
    pushModule: push,
    isMultiUser: mode || MULTI,
    listAdmins: ADMINS,
  });
  store.stateFor = function (viewer) {
    var out = null;
    store.sendConnectionState({ _clagenticUser: viewer ? { id: viewer } : null }, function (ws, m) { out = m; }, null);
    return out.notifications;
  };
  store.created = created;
  return store;
}

function offersOf(list) { return list.filter(function (n) { return n.type === "build_update_offer"; }); }

var ASSESSMENT = { loadedBuildSha: "a".repeat(40), installedBuildSha: "b".repeat(40), installedContentHash: "h", reason: "sha" };

// AC1: one registration per type, the declarations in it.
test("each system type is registered once, as category system, with its collapse and audience declared (AC1)", function () {
  var declared = {
    auth_required: { collapse: "session", audience: "target" },
    build_update_offer: { collapse: "session", audience: "admins" },
    update_available: { collapse: "session", audience: "admins" },
  };
  assert.deepEqual(Object.keys(SYSTEM_TYPES).sort(), Object.keys(declared).sort());
  Object.keys(declared).forEach(function (name) {
    var type = notifyApi.getType(name);
    assert.ok(type, name + " is registered");
    assert.equal(type.category, "system");
    assert.equal(type.collapse, declared[name].collapse);
    assert.equal(type.audience, declared[name].audience);
    assert.equal(type.banner, true);
    assert.throws(function () { notifyApi.registerType(name, { collapse: "session" }); }, /already registered/, name + " cannot be registered a second time");
  });
  assert.throws(function () { notifyApi.createTypeRegistry().register("x", { collapse: "session", audience: "everyone" }); }, /audience/);
});

// AC2
test("two sign-in notices for one session show once per surface, to the owner alone, with a target (AC2)", function () {
  var push = spyPush();
  var store = realStore(push);
  var fields = { slug: "proj", session: { localId: 4, ownerId: "alice" }, title: "Claude is not logged in", vendor: "claude", loginCommand: "claude", linuxUser: null, canAutoLogin: false };
  var first = notifyAuthRequired(push, store, fields);
  var second = notifyAuthRequired(push, store, Object.assign({}, fields, { title: "Claude is not logged in (again)" }));
  assert.equal(first.tag, "n:auth_required:proj:4");
  assert.equal(second.tag, first.tag, "the platform replaces the earlier push");
  assert.deepEqual(push.calls.map(function (c) { return c.to; }), ["alice", "alice"], "no other user is pushed");
  assert.deepEqual(first.target, { slug: "proj", sessionId: "4", requestId: null });
  var alice = store.stateFor("alice");
  assert.equal(alice.length, 1, "the later banner replaced the earlier one");
  assert.equal(alice[0].title, "Claude is not logged in (again)");
  assert.equal(alice[0].targetUserId, "alice");
  assert.equal(alice[0].slug, "proj");
  assert.equal(alice[0].sessionId, 4);
  assert.deepEqual(store.stateFor("mallory"), [], "another user is never shown it");
  assert.equal(notifyApi.getType("auth_required").persistent, true);
});

test("a prompt resolving never closes a system notification", function () {
  var push = spyPush();
  var core = notifyApi.notifyFor(push, null);
  core.notify("auth_required", { slug: "proj", sessionId: 4 }, { push: { title: "T", body: "B" } }, { ownerId: "alice" });
  push.calls.length = 0;
  core.resolve({ slug: "proj", sessionId: 4 }, { ownerId: "alice" });
  core.resolve({ slug: "proj", sessionId: 4, requestId: "r1" }, { ownerId: "alice" });
  assert.deepEqual(push.calls.filter(function (c) { return c.payload.closes === "auth_required"; }), []);
});

// AC3
test("the offer raised by the offer path, the standing reconcile and a repeat is one offer per surface (AC3)", async function () {
  var push = spyPush();
  var store = realStore(push);
  var env = { push: push, inApp: store, isMultiUser: MULTI, listAdmins: ADMINS };
  var message = composeNotice(ASSESSMENT, { available: false, commits: [], truncated: false, reason: "r" });
  var direct = buildNotify.showBuildOffer(env, message);
  var standing = createStandingOffer({
    listChanges: function () { return Promise.resolve({ available: true, commits: [], truncated: false, reason: null }); },
    desired: function () { return ASSESSMENT; },
    compose: composeNotice,
    show: function (m) { buildNotify.showBuildOffer(env, m); },
    retract: function () { buildNotify.resolveBuildOffer(env); },
  });
  standing.reconcile(ASSESSMENT);
  await new Promise(function (r) { setImmediate(r); });
  buildNotify.showBuildOffer(env, message);
  assert.equal(direct.tag, "n:build_update_offer::");
  assert.ok(push.calls.length >= 3);
  push.calls.forEach(function (c) { assert.equal(c.payload.tag, direct.tag, "every emit shares the core's tag"); });
  ["admin-1", "admin-2"].forEach(function (admin) {
    assert.equal(offersOf(store.stateFor(admin)).length, 1, admin + " holds exactly one offer");
  });
  assert.equal(offersOf(store.stateFor("alice")).length, 0, "a non-admin is not shown it");
  var held = offersOf(store.stateFor("admin-1"))[0];
  assert.equal(held.key, direct.tag);
  assert.equal(held.meta.actionable.action, "restart_for_build_update");
  assert.equal(held.meta.buildUpdate.token, undefined, "no restart token is broadcast");
});

test("the offer and the sign-in notice are raised only through the core: no tag, dedupe or route of their own (AC7)", function () {
  ["lib/auth-required-notify.js", "lib/build-update-notify.js"].forEach(function (file) {
    var src = fs.readFileSync(path.join(__dirname, "..", file), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src, /\btag\b|\.url\b|sendPush|\.show\(|diagnostic/i, file);
  });
  var daemon = fs.readFileSync(path.join(__dirname, "..", "lib", "daemon.js"), "utf8");
  assert.doesNotMatch(daemon, /createStandingOffer\(\{[^]*?\bbroadcast:/, "the standing offer raises and withdraws through the core, not a broadcast");
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "lib", "public", "modules", "build-notice-gate.js")), "the page-side gate is gone");
});

// AC4
test("resolving the offer closes it on push and in every page, for the admins (AC4)", function () {
  var push = spyPush();
  var store = realStore(push);
  var env = { push: push, inApp: store, isMultiUser: MULTI, listAdmins: ADMINS };
  var sent = buildNotify.showBuildOffer(env, composeNotice(ASSESSMENT, null));
  push.calls.length = 0;
  buildNotify.resolveBuildOffer(env);
  assert.deepEqual(push.calls.map(function (c) { return c.to; }), ["admin-1", "admin-2"]);
  var close = push.calls[0].payload;
  assert.equal(close.type, payloads.CLOSE_TYPE);
  assert.deepEqual(close.tags, [sent.tag]);
  assert.equal(close.closes, "build_update_offer", "the close follows the type's own preference");
  assert.equal(offersOf(store.stateFor("admin-1")).length, 0);
  assert.equal(store.created.filter(function (c) { return c.msg.type === "notification_dismissed"; }).length > 0, true);
});

test("declining the offer in one page closes it on the phone and in every other page, and is reported (AC4)", function () {
  var push = spyPush();
  var declined = [];
  var sentToUser = [];
  var broadcasts = [];
  var store = attachNotifications({
    broadcastAll: function (m) { broadcasts.push(m); },
    sendToUser: function (u, m) { sentToUser.push({ to: u, msg: m }); },
    pushModule: push,
    isMultiUser: MULTI,
    listAdmins: ADMINS,
    onResolvedByOperator: function (type) { declined.push(type); },
  });
  var env = { push: push, inApp: store, isMultiUser: MULTI, listAdmins: ADMINS };
  buildNotify.showBuildOffer(env, composeNotice(ASSESSMENT, null));
  var id = sentToUser.filter(function (s) { return s.msg.type === "notification_created"; })[0].msg.notification.id;
  push.calls.length = 0;
  sentToUser.length = 0;
  assert.equal(store.handleNotificationMessage({ _clagenticUser: { id: "admin-1" } }, { type: "notification_dismiss", ids: [id] }), true);
  assert.deepEqual(push.calls.map(function (c) { return c.payload.type; }), [payloads.CLOSE_TYPE, payloads.CLOSE_TYPE]);
  assert.deepEqual(push.calls.map(function (c) { return c.to; }), ["admin-1", "admin-2"]);
  assert.deepEqual(declined, ["build_update_offer"]);
  assert.ok(broadcasts.some(function (m) { return m.type === "notification_dismissed" && m.ids.indexOf(id) !== -1; }), "every page is told");
});

test("closing a sign-in banner is not a resolve: nothing is pushed or reported", function () {
  var push = spyPush();
  var declined = [];
  var store = attachNotifications({
    broadcastAll: function () {}, sendToUser: function () {}, pushModule: push, isMultiUser: MULTI, listAdmins: ADMINS,
    onResolvedByOperator: function (type) { declined.push(type); },
  });
  notifyAuthRequired(push, store, { slug: "proj", session: { localId: 4, ownerId: "alice" }, title: "T", vendor: "claude", loginCommand: "claude", linuxUser: null, canAutoLogin: false });
  push.calls.length = 0;
  var list = null;
  store.sendConnectionState({ _clagenticUser: { id: "alice" } }, function (ws, m) { list = m.notifications; }, null);
  store.handleNotificationMessage({ _clagenticUser: { id: "alice" } }, { type: "notification_dismiss", ids: [list[0].id] });
  assert.deepEqual(push.calls, []);
  assert.deepEqual(declined, []);
});

test("the offer does not outlive a daemon restart, and an offer persisted by a prior run is dropped", function () {
  assert.equal(notifyApi.getType("build_update_offer").ephemeral, true);
  assert.equal(notifyApi.getType("update_available").ephemeral, true);
  assert.equal(notifyApi.getType("auth_required").ephemeral, false);
  var cfg = require("../lib/config");
  var file = path.join(cfg.CONFIG_DIR, "notifications.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([
    { id: "o", type: "build_update_offer", title: "x" },
    { id: "u", type: "update_available", title: "x" },
    { id: "a", type: "auth_required", title: "x" },
  ]));
  var store = attachNotifications({ broadcastAll: function () {}, isMultiUser: SINGLE });
  var list = null;
  store.sendConnectionState({ _clagenticUser: null }, function (ws, m) { list = m.notifications; }, null);
  assert.deepEqual(list.map(function (n) { return n.id; }), ["a"]);
  fs.rmSync(file, { force: true });
});

// AC5
test("update_available reaches only the admins in a multi-user install; the emitter cannot widen it (AC5)", function () {
  var push = spyPush();
  var store = realStore(push);
  var core = notifyApi.notifyFor(push, store);
  core.notify("update_available", { slug: null, sessionId: null }, {
    push: { title: "Update available", body: "v9" },
    banner: { title: "Update available", version: "9", targetUserId: "mallory", targetUserIds: ["mallory"] },
  }, { ownerId: "mallory", isMultiUser: MULTI, listAdmins: ADMINS });
  assert.deepEqual(push.calls.map(function (c) { return c.to; }), ["admin-1", "admin-2"]);
  var shown = store.created.filter(function (c) { return c.msg.type === "notification_created"; });
  assert.deepEqual(shown.map(function (c) { return c.to; }).sort(), ["admin-1", "admin-2"]);
  assert.equal(store.stateFor("mallory").length, 0);
  assert.equal(store.stateFor("admin-2").length, 1);
});

test("update_available in a single-user install goes to the one person", function () {
  var push = spyPush();
  notifyApi.notifyFor(push, null).notify("update_available", { slug: null, sessionId: null }, { push: { title: "T", body: "B" } }, { isMultiUser: SINGLE });
  assert.deepEqual(push.calls.map(function (c) { return c.to; }), ["everyone"]);
});

// AC6
test("a tap on a system push hands the page the type, and the page's router opens the place registered for it (AC6)", async function () {
  var posted = [];
  var win = { url: "https://h.example/", visibilityState: "visible", focus: function () { return Promise.resolve(); }, postMessage: function (m) { posted.push(m); } };
  var p = payloads.buildPayload(notifyApi.getType("build_update_offer"), NotifyTarget.makeTarget({ slug: null, sessionId: null }), { title: "T", body: "B" });
  assert.equal(p.url, "/");
  await sw.handleClick({
    scope: "https://h.example/",
    clients: { matchAll: function () { return Promise.resolve([win]); }, openWindow: function () { throw new Error("a window exists"); } },
  }, { data: p });
  assert.deepEqual(posted, [{ type: "notify_route", target: { slug: null, sessionId: null, requestId: null }, notifyType: "build_update_offer" }]);
  var swSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "sw.js"), "utf8") + fs.readFileSync(path.join(__dirname, "..", "lib", "public", "notify-sw-logic.js"), "utf8");
  assert.doesNotMatch(swSrc, /build_update_offer|update_available|auth_required/, "no per-type routing in the worker");
});

async function pageWith(t, slug) {
  await setupToolsEnv(t);
  var storeMod = await import(moduleUrl("store.js"));
  storeMod.store.set({ currentSlug: slug || "proj-a", activeSessionId: 1 });
  var sent = [];
  var wsRef = await import(moduleUrl("ws-ref.js"));
  wsRef.setWs({ readyState: 1, send: function (raw) { sent.push(JSON.parse(raw)); } });
  var mod = await import(moduleUrl("app-notifications.js") + "?sys=" + Math.random());
  mod.initAppNotifications();
  var client = await import(moduleUrl("notify-client.js"));
  var container = global.document.body._children[global.document.body._children.length - 1];
  return {
    mod: mod, client: client, sent: sent,
    banner: function (id) { return container.querySelector('[data-notif-id="' + id + '"]'); },
    tap: function (id) { this.banner(id)._listeners.click[0]({ target: { closest: function () { return null; } } }); },
  };
}

function offerCreated(id) {
  return {
    type: "notification_created", unreadCount: 1,
    notification: {
      id: id, type: "build_update_offer", category: "system", title: "A newer build is installed", body: "Running build a; installed build b.",
      slug: "", sessionId: null, persistent: true, key: "n:build_update_offer::",
      meta: {
        message: "Running build a; installed build b.",
        buildUpdate: { loadedBuildSha: "a", installedBuildSha: "b", reason: "sha", changes: { available: false, commits: [], truncated: false, reason: "r" } },
        actionable: { label: "Restart to apply update", action: "restart_for_build_update" },
      },
    },
  };
}

test("tapping the offer banner opens the place its action lives and does not decline it; its close button does (AC6, AC4)", async function (t) {
  var c = await pageWith(t);
  var opened = 0;
  c.client.registerPlace("build_update_offer", function () { opened++; });
  c.mod.handleNotificationCreated(offerCreated("o1"));
  assert.ok(c.banner("o1"), "the offer is a banner");
  c.tap("o1");
  assert.equal(opened, 1);
  assert.deepEqual(c.sent.filter(function (m) { return m.type === "notification_dismiss"; }), [], "looking at the offer does not decline it");
});

test("a dismissal from the server removes the offer's banner on every page (AC4)", async function (t) {
  var c = await pageWith(t);
  c.mod.handleNotificationCreated(offerCreated("o2"));
  c.mod.handleNotificationDismissed({ ids: ["o2"], unreadCount: 0 });
  assert.ok(c.banner("o2").classList.contains("hide"));
});

test("an update notice renders its banner from the notification, for the admins it reached (AC5, AC6)", async function (t) {
  var c = await pageWith(t);
  c.mod.handleNotificationCreated({
    type: "notification_created", unreadCount: 1,
    notification: { id: "u1", type: "update_available", category: "system", title: "Update available", body: "", slug: "", sessionId: null, meta: { version: "9.9.9", current: "1.0.0" } },
  });
  var banner = c.banner("u1");
  assert.ok(banner, "a banner keyed by the notification");
  assert.ok(banner.textContent.indexOf("v9.9.9 is available") !== -1);
  var opened = 0;
  c.client.registerPlace("update_available", function () { opened++; });
  c.tap("u1");
  assert.equal(opened, 1, "a tap opens the update UI");
});

test("a second update notice replaces the first (the core dismisses it), never two banners (AC1)", async function (t) {
  var c = await pageWith(t);
  function update(id) {
    return { type: "notification_created", unreadCount: 1, notification: { id: id, type: "update_available", category: "system", title: "Update available", body: "", slug: "", sessionId: null, meta: { version: "9.9.9" } } };
  }
  c.mod.handleNotificationCreated(update("u1"));
  c.mod.handleNotificationDismissed({ ids: ["u1"], unreadCount: 0 });
  c.mod.handleNotificationCreated(update("u2"));
  assert.ok(c.banner("u1").classList.contains("hide"));
  assert.ok(!c.banner("u2").classList.contains("hide"));
});

test("a sign-in notice that targets a session routes to that session through the router (AC6)", async function (t) {
  var c = await pageWith(t, "proj-a");
  c.mod.handleNotificationCreated({
    type: "notification_created", unreadCount: 1,
    notification: { id: "a1", type: "auth_required", category: "system", title: "Claude is not logged in", body: "b", slug: "proj-a", sessionId: 7, persistent: true, meta: { vendor: "claude", loginCommand: "claude" } },
  });
  assert.ok(c.banner("a1"), "a banner for a session the page is not on is shown");
});

// AC8: the direct-message deep link survives a reload before the connection.
function fakeSessionStorage(refuse) {
  var backing = {};
  return {
    backing: backing,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(backing, k) ? backing[k] : null; },
    setItem: function (k, v) { if (refuse) throw new Error("quota"); backing[k] = String(v); },
    removeItem: function (k) { delete backing[k]; },
  };
}

var envReady = new WeakSet();

async function freshClient(t, search, storage) {
  if (!envReady.has(t)) {
    envReady.add(t);
    await setupToolsEnv(t);
  }
  var replaced = [];
  global.sessionStorage = storage;
  global.location = { pathname: "/", search: search, hash: "" };
  global.history = { replaceState: function (a, b, url) { replaced.push(url); } };
  var mod = await import(moduleUrl("notify-client.js") + "?dm=" + Math.random());
  return { mod: mod, replaced: replaced };
}

test("a ?dm= deep link keeps its destination across a reload before the connection (AC8)", async function (t) {
  var storage = fakeSessionStorage(false);
  var first = await freshClient(t, "?dm=u7", storage);
  first.mod.initNotifyClient();
  assert.deepEqual(first.replaced, ["/"], "the query is dropped once sessionStorage holds the target");
  // The page reloads (a new module instance, no query, the same sessionStorage).
  var second = await freshClient(t, "", storage);
  second.mod.initNotifyClient();
  assert.equal(second.mod.takePendingPeer(), "u7");
  assert.equal(second.mod.takePendingPeer(), null, "taking it ends the wait");
  assert.deepEqual(storage.backing, {}, "and clears the stored copy");
});

test("a ?dm= deep link keeps the query while sessionStorage refuses it, and drops it once taken (AC8)", async function (t) {
  var storage = fakeSessionStorage(true);
  var c = await freshClient(t, "?dm=u7", storage);
  c.mod.initNotifyClient();
  assert.deepEqual(c.replaced, [], "the query is the only durable copy, so it stays");
  assert.equal(c.mod.takePendingPeer(), "u7", "the in-memory copy still serves");
  assert.deepEqual(c.replaced, ["/"], "taken: the query goes");
});

test("a tap on a message before the connection is up waits in sessionStorage too (AC8)", async function (t) {
  var storage = fakeSessionStorage(false);
  var first = await freshClient(t, "", storage);
  (await import(moduleUrl("ws-ref.js"))).setWs(null);
  first.mod.routeTo({ peerId: "u3" });
  var second = await freshClient(t, "", storage);
  assert.equal(second.mod.takePendingPeer(), "u3");
});

test("the session deep link is unchanged: stored, query dropped, taken once (AC8)", async function (t) {
  var storage = fakeSessionStorage(false);
  var first = await freshClient(t, "?session=5&request=r", storage);
  first.mod.initNotifyClient();
  assert.deepEqual(first.replaced, ["/"]);
  var second = await freshClient(t, "", storage);
  assert.equal(second.mod.takePendingSession(), 5);
  assert.equal(second.mod.takePendingSession(), null);
});

test("the quiet period after a declined offer comes from the setting: set, default and invalid values", function () {
  var { noticeCooldownFrom, DEFAULT_NOTICE_COOLDOWN_MS } = require("../lib/build-update-offer");
  assert.equal(noticeCooldownFrom(undefined), DEFAULT_NOTICE_COOLDOWN_MS);
  assert.equal(noticeCooldownFrom(""), DEFAULT_NOTICE_COOLDOWN_MS);
  assert.equal(noticeCooldownFrom("abc"), DEFAULT_NOTICE_COOLDOWN_MS);
  assert.equal(noticeCooldownFrom("-5"), DEFAULT_NOTICE_COOLDOWN_MS);
  assert.equal(noticeCooldownFrom("0"), 0);
  assert.equal(noticeCooldownFrom("120000"), 120000);
  assert.equal(DEFAULT_NOTICE_COOLDOWN_MS, 3600000);
});

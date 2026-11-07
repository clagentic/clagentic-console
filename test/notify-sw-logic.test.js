"use strict";

// The service worker's show, close and tap logic and the page's reconcile,
// over fake browser objects.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var sw = require("../lib/public/notify-sw-logic.js");
var payloads = require("../lib/notify/payload");
var { createTypeRegistry } = require("../lib/notify/type-registry");
var { registerBuiltins } = require("../lib/notify/types");

var registry = registerBuiltins(createTypeRegistry());
function corePayload(type, t) {
  return payloads.buildPayload(registry.get(type), t, { title: "T", body: "B" });
}

function fakeNotification(tag, data) {
  return { tag: tag, data: data, closed: false, close: function () { this.closed = true; } };
}

function world(opts) {
  opts = opts || {};
  var shown = [];
  var opened = [];
  var windows = (opts.windows || []).map(function (w) {
    return Object.assign({ posted: [], focused: false,
      focus: function () { this.focused = true; return Promise.resolve(this); },
      postMessage: function (m) { this.posted.push(m); } }, w);
  });
  var registration = {
    showNotification: function (title, o) {
      shown = shown.filter(function (n) { return n.tag !== o.tag; });
      var n = fakeNotification(o.tag, o.data);
      n.options = o; n.title = title;
      shown.push(n);
      return Promise.resolve();
    },
    getNotifications: function (f) {
      return Promise.resolve(shown.filter(function (n) { return !n.closed && (!f || !f.tag || n.tag === f.tag); }));
    },
  };
  return {
    shown: function () { return shown.filter(function (n) { return !n.closed; }); },
    opened: opened,
    windows: windows,
    env: {
      registration: registration,
      clients: {
        matchAll: function () { return Promise.resolve(windows); },
        openWindow: function (u) { opened.push(u); return Promise.resolve(); },
      },
      userAgent: opts.userAgent || "Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile Safari/537.36",
      scope: "https://h.example/",
      setTimeout: function (fn) { fn(); },
    },
  };
}

test("a core payload is shown from its own tag and options, in the foreground too", async function () {
  var w = world({ windows: [{ url: "https://h.example/p/p/", visibilityState: "visible", focused: true }] });
  var data = corePayload("permission_request", { slug: "p", sessionId: 3, requestId: "r1" });
  await sw.handlePush(w.env, data);
  assert.equal(w.shown().length, 1);
  assert.equal(w.shown()[0].tag, data.tag);
  assert.equal(w.shown()[0].options.requireInteraction, true);
  assert.deepEqual(w.shown()[0].options.data.target, data.target);
});

test("two pushes for one target show one notification; two ask_user targets show two", async function () {
  var w = world();
  var t = { slug: "p", sessionId: 3, requestId: "r1" };
  await sw.handlePush(w.env, corePayload("permission_reminder", t));
  await sw.handlePush(w.env, corePayload("permission_reminder", t));
  assert.equal(w.shown().length, 1);
  assert.equal(w.shown()[0].options.renotify, true);
  var w2 = world();
  await sw.handlePush(w2.env, corePayload("ask_user", { slug: "p", sessionId: 1, requestId: "a" }));
  await sw.handlePush(w2.env, corePayload("ask_user", { slug: "p", sessionId: 2, requestId: "b" }));
  assert.equal(w2.shown().length, 2);
});

test("a close push closes the shown notification where a push may show nothing", async function () {
  var w = world();
  var data = corePayload("permission_request", { slug: "p", sessionId: 3, requestId: "r1" });
  await sw.handlePush(w.env, data);
  var shownBefore = w.shown()[0];
  await sw.handlePush(w.env, payloads.buildClose(registry.get("permission_request"), data.tag));
  assert.equal(shownBefore.closed, true);
});

test("a close push replaces the notification with a silent notice where every push must show one", async function () {
  var ios = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
  assert.equal(sw.requiresVisible(ios), true);
  assert.equal(sw.requiresVisible("Mozilla/5.0 (Macintosh) AppleWebKit/605 Version/17 Safari/605"), true);
  assert.equal(sw.requiresVisible("Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile Safari/537.36"), false);
  var w = world({ userAgent: ios });
  var data = corePayload("permission_request", { slug: "p", sessionId: 3, requestId: "r1" });
  await sw.handlePush(w.env, data);
  var replaced = [];
  var realShow = w.env.registration.showNotification;
  w.env.registration.showNotification = function (title, o) { replaced.push(o); return realShow(title, o); };
  await sw.handlePush(w.env, payloads.buildClose(registry.get("permission_request"), data.tag));
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].tag, data.tag);
  assert.equal(replaced[0].silent, true);
  assert.equal(replaced[0].requireInteraction, false);
  assert.equal(w.shown().length, 0, "the notice closes itself");
});

test("a tap focuses a window and posts it the target; the project's own window is preferred", async function () {
  var w = world({ windows: [
    { url: "https://h.example/p/q/", visibilityState: "visible" },
    { url: "https://h.example/p/p/", visibilityState: "hidden" },
  ] });
  var data = corePayload("permission_request", { slug: "p", sessionId: 3, requestId: "r1" });
  await sw.handleClick(w.env, { data: data });
  assert.equal(w.windows[1].focused, true, "lands on P, not Q");
  assert.equal(w.windows[0].focused, false);
  assert.deepEqual(w.windows[1].posted, [{ type: "notify_route", target: { slug: "p", sessionId: "3", requestId: "r1" } }]);
});

test("a tap with only another project's window open routes that window to the target", async function () {
  var w = world({ windows: [{ url: "https://h.example/p/q/", visibilityState: "visible" }] });
  var data = corePayload("permission_request", { slug: "p", sessionId: 3, requestId: "r1" });
  await sw.handleClick(w.env, { data: data });
  assert.equal(w.windows[0].posted[0].target.slug, "p");
  assert.equal(w.opened.length, 0);
});

test("a tap with no window open opens the deep link", async function () {
  var w = world();
  var data = corePayload("ask_user", { slug: "p", sessionId: 3, requestId: "r1" });
  await sw.handleClick(w.env, { data: data });
  assert.deepEqual(w.opened, ["https://h.example/p/p/?session=3&request=r1"]);
});

test("a tap on the silent resolved notice does nothing", async function () {
  var w = world();
  await sw.handleClick(w.env, { data: { resolved: true } });
  assert.equal(w.opened.length, 0);
});

test("legacy payloads are shown and tapped as before", async function () {
  var w = world();
  await sw.handlePush(w.env, { type: "done", title: "d", body: "b", slug: "p" });
  assert.equal(w.shown()[0].tag, "claude-done");
  assert.equal(w.shown()[0].options.requireInteraction, undefined);
  await sw.handlePush(w.env, { type: "dm", title: "d", body: "b" });
  assert.ok(w.shown().some(function (n) { return n.tag === "dm"; }));
  await sw.handlePush(w.env, { type: "done", title: "d", body: "b", tag: "ralph-loop-done" });
  assert.ok(w.shown().some(function (n) { return n.tag === "ralph-loop-done"; }));
  await sw.handlePush(w.env, { type: "user_mention", title: "m", body: "b", data: { slug: "p" } });
  assert.ok(w.shown().some(function (n) { return n.tag === "clagentic"; }));
  await sw.handlePush(w.env, { type: "test" });
  assert.equal(w.shown().length, 4);

  var vis = world({ windows: [{ url: "https://h.example/p/p/", visibilityState: "visible" }] });
  await sw.handlePush(vis.env, { type: "done", title: "d", body: "b" });
  assert.equal(vis.shown().length, 0, "done is still suppressed in the foreground");

  var tap = world({ windows: [{ url: "https://h.example/p/p/", visibilityState: "hidden" }] });
  await sw.handleClick(tap.env, { data: { type: "done", slug: "p" } });
  assert.equal(tap.windows[0].focused, true);
  assert.deepEqual(tap.windows[0].posted, []);
  var none = world();
  await sw.handleClick(none.env, { data: { type: "done", slug: "p" } });
  assert.deepEqual(none.opened, ["https://h.example/p/p/"]);
});

test("legacy permission, reminder and ask payloads keep their old tags", async function () {
  var w = world({ windows: [{ url: "https://h.example/", visibilityState: "visible", focused: true }] });
  await sw.handlePush(w.env, { type: "permission_request", requestId: "r9", title: "t", body: "b" });
  await sw.handlePush(w.env, { type: "ask_user", title: "t", body: "b" });
  await sw.handlePush(w.env, { type: "permission_reminder", title: "t", body: "b", tag: "prompt-reminder-p:1" });
  var tags = w.shown().map(function (n) { return n.tag; }).sort();
  assert.deepEqual(tags, ["claude-ask", "perm-r9", "prompt-reminder-p:1"]);
});

var SCOPE_P = { slug: "p", livePrompts: null };

test("reconcile closes a verifiable notification whose prompt is gone, and only that", async function () {
  var w = world();
  await sw.handlePush(w.env, corePayload("permission_request", { slug: "p", sessionId: 3, requestId: "live" }));
  await sw.handlePush(w.env, corePayload("permission_request", { slug: "p", sessionId: 3, requestId: "gone" }));
  await sw.handlePush(w.env, corePayload("permission_reminder", { slug: "p", sessionId: 3, requestId: "old" }));
  var state = [
    { type: "permission_request", meta: { requestId: "live" } },
    { type: "permission_reminder", meta: { reminderKey: "p:3", requestIds: ["live"] } },
  ];
  var closed = await sw.reconcileShown(w.env.registration, state, SCOPE_P);
  assert.equal(closed, 1);
  var open = w.shown().map(function (n) { return n.options.data.target.requestId; }).sort();
  assert.deepEqual(open, ["live", "old"]);
  closed = await sw.reconcileShown(w.env.registration, [], SCOPE_P);
  assert.equal(closed, 2, "with nothing live both close");
});

test("reconcile verifies ask_user and elicitation against the server's live-prompt record", async function () {
  var w = world();
  var ask = corePayload("ask_user", { slug: "p", sessionId: 3, requestId: "toolu_live" });
  var gone = corePayload("ask_user", { slug: "p", sessionId: 3, requestId: "toolu_gone" });
  var elicit = corePayload("elicitation", { slug: "p", sessionId: 4, requestId: "e1" });
  [ask, gone, elicit].forEach(function (d) { d.sentAt = 1000; });
  await sw.handlePush(w.env, ask);
  await sw.handlePush(w.env, gone);
  await sw.handlePush(w.env, elicit);
  var live = { slug: "p", at: 2000, items: [{ sessionId: "3", requestId: "uuid-1", toolUseId: "toolu_live" }] };
  var closed = await sw.reconcileShown(w.env.registration, [], { slug: "p", livePrompts: live });
  assert.equal(closed, 2, "the ended question and the ended elicitation");
  assert.deepEqual(w.shown().map(function (n) { return n.options.data.target.requestId; }), ["toolu_live"]);
});

test("reconcile does not judge a notification sent after the record was taken", async function () {
  var w = world();
  var fresh = corePayload("ask_user", { slug: "p", sessionId: 3, requestId: "toolu_new" });
  fresh.sentAt = 3000;
  await sw.handlePush(w.env, fresh);
  var closed = await sw.reconcileShown(w.env.registration, [], { slug: "p", livePrompts: { slug: "p", at: 2000, items: [] } });
  assert.equal(closed, 0);
});

test("reconcile never closes another project's notification", async function () {
  var w = world();
  await sw.handlePush(w.env, corePayload("permission_request", { slug: "q", sessionId: 3, requestId: "r1" }));
  var ask = corePayload("ask_user", { slug: "q", sessionId: 3, requestId: "a1" });
  ask.sentAt = 1;
  await sw.handlePush(w.env, ask);
  assert.equal(await sw.reconcileShown(w.env.registration, [], { slug: "p", livePrompts: { slug: "p", at: 2, items: [] } }), 0);
  assert.equal(w.shown().length, 2);
  assert.equal(await sw.reconcileShown(w.env.registration, [], { slug: "", livePrompts: null }), 0, "no slug, no judgement");
});

test("a close where every push must show one leaves a newer notification under the tag alone", async function () {
  var ios = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
  var w = world({ userAgent: ios });
  var t = { slug: "p", sessionId: 3, requestId: "r1" };
  var first = corePayload("permission_request", t);
  await sw.handlePush(w.env, first);
  var lingers = [];
  w.env.setTimeout = function (fn) { lingers.push(fn); };
  var closing = sw.handlePush(w.env, payloads.buildClose(registry.get("permission_request"), first.tag));
  await new Promise(function (r) { setImmediate(r); });
  assert.equal(lingers.length, 1);
  // A live notification takes the tag before the linger ends.
  await sw.handlePush(w.env, corePayload("permission_request", t));
  lingers[0]();
  await closing;
  assert.equal(w.shown().length, 1);
  assert.equal(w.shown()[0].options.data.core, 1, "the live notification stays");
});

test("a close with nothing shown shows one silent notice and closes it at once where a push must show one", async function () {
  var ios = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
  var w = world({ userAgent: ios });
  var shownCalls = [];
  var realShow = w.env.registration.showNotification;
  w.env.registration.showNotification = function (title, o) { shownCalls.push(o); return realShow(title, o); };
  var waits = 0;
  w.env.setTimeout = function () { waits++; };
  await sw.handlePush(w.env, payloads.buildClose(registry.get("permission_request"), ["n:permission_request:p:3:r1", "n:ask_user:p:3:r1"]));
  assert.equal(shownCalls.length, 1, "one notice for the whole close");
  assert.equal(shownCalls[0].silent, true);
  assert.equal(waits, 0, "no linger");
  assert.equal(w.shown().length, 0);

  var android = world();
  var calls = 0;
  var realAndroid = android.env.registration.showNotification;
  android.env.registration.showNotification = function (title, o) { calls++; return realAndroid(title, o); };
  await sw.handlePush(android.env, payloads.buildClose(registry.get("permission_request"), "n:permission_request:p:3:r1"));
  assert.equal(calls, 0, "a platform that allows it shows nothing");
});

test("sw.js wires the generic handlers and drops the dead error branch", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "sw.js"), "utf8");
  assert.match(src, /importScripts\("\/notify-target\.js", "\/notify-sw-logic\.js"\)/);
  assert.doesNotMatch(src, /claude-error|data\.type === "error"/);
  var handlers = {};
  var sandbox = {
    self: null,
    importScripts: function () {},
    caches: {}, fetch: function () {}, URL: URL, Response: function () {},
    NotifySw: { handlePush: function () { return Promise.resolve(); }, handleClick: function () { return Promise.resolve(); } },
  };
  sandbox.self = {
    location: { origin: "https://h.example" },
    registration: { scope: "https://h.example/" },
    addEventListener: function (n, fn) { handlers[n] = fn; },
  };
  vm.runInNewContext(src, Object.assign(sandbox, { self: sandbox.self }));
  assert.ok(handlers.push && handlers.notificationclick);
});

test("the banner reconcile shares the push reconcile's live check (AC5)", function () {
  var banner = function (over) {
    return Object.assign({
      id: "n1", type: "permission_request", slug: "p", sessionId: 3, key: "n:permission_request:p:3:r1",
      collapse: "request", liveInState: true, createdAt: 1000, meta: { requestId: "r1" },
    }, over);
  };
  var live = { slug: "p", at: 2000, items: [{ sessionId: "3", requestId: "r1", toolUseId: null }] };
  assert.equal(sw.isBannerLive(banner(), [banner()], null), true, "listed by the server");
  assert.equal(sw.isBannerLive(banner(), [], live), true, "not listed, its prompt still waits");
  assert.equal(sw.isBannerLive(banner(), [], { slug: "p", at: 2000, items: [] }), false, "its prompt is gone");
  assert.equal(sw.isBannerLive(banner({ createdAt: 3000 }), [], { slug: "p", at: 2000, items: [] }), true, "newer than the record");
  assert.equal(sw.isBannerLive(banner({ liveInState: false }), [], { slug: "p", at: 2000, items: [] }), true, "not judged");
  var reminder = banner({ type: "permission_reminder", collapse: "session", key: "n:permission_reminder:p:3", meta: {} });
  assert.equal(sw.isBannerLive(reminder, [], live), false, "a reminder is live only while listed");
  assert.equal(sw.isBannerLive(reminder, [reminder], live), true);
});

test("a shown push is live while a banner under its tag is listed", async function () {
  var w = world();
  var data = corePayload("permission_reminder", { slug: "p", sessionId: 3, requestId: "r1" });
  await sw.handlePush(w.env, data);
  var listed = [{ key: data.tag, type: "permission_reminder", meta: {} }];
  assert.equal(await sw.reconcileShown(w.env.registration, listed, SCOPE_P), 0);
  assert.equal(await sw.reconcileShown(w.env.registration, [], SCOPE_P), 1);
});

"use strict";

// The build-update offer, from a confirmed stale assessment to what an admin's
// open tab shows. The whole chain is real: the standing offer, the notification
// core, the banner store and the page's own handlers (over a fake DOM). Only the
// socket is a list of the frames the daemon sent to the admin.
//
// The first block is the reproduction at the commit before the fix: it names
// which stage (emit, delivery, render) holds. The rest pin the pop-up, the
// connect case, clear-all and the decline cooldown.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

process.env.CLAGENTIC_CONSOLE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "build-offer-popup-"));

var { attachNotifications } = require("../lib/project-notifications");
var buildNotify = require("../lib/build-update-notify");
var { createStandingOffer } = require("../lib/build-update-standing");
var { composeNotice } = require("../lib/build-update-offer");
var { createBuildMonitor } = require("../lib/build-monitor");
var { createPrefsStore } = require("../lib/notification-prefs");
var dom = require("./fake-dom-prompt-cards");

var ADMIN = "admin-1";
var MULTI = function () { return true; };
var LISTED = { available: true, commits: [{ sha: "1234567890ab", subject: "fix a thing" }], truncated: false, reason: null };
var RESTART_LABEL = "Restart to apply update";

var seq = 0;

function stale(tag) {
  // The tag leads: the offer's text shortens a sha, and two offers with the same
  // text inside the diagnostics dedup window would be taken for one.
  return { loadedBuildSha: (tag + "a".repeat(40)).slice(0, 40), installedBuildSha: (tag + "b".repeat(40)).slice(0, 40), installedContentHash: "h" + tag, reason: "sha" };
}

function spyPush() {
  var calls = [];
  return {
    calls: calls,
    sendPush: function (p) { calls.push({ to: "everyone", payload: p }); },
    sendPushToUser: function (u, p) { calls.push({ to: u, payload: p }); },
  };
}

// The daemon side: the real banner store, the real standing offer over a real
// build monitor, and the frames the admin's socket received.
function daemonWorld(o) {
  o = o || {};
  var frames = [];
  var push = o.push || spyPush();
  var resolvedByOperator = [];
  var clock = { t: 1000000 };
  var verdict = { current: o.assessment || stale(String(++seq)) };
  var store = attachNotifications({
    broadcastAll: function (m) { frames.push(m); },
    sendToUser: function (u, m) { if (u === ADMIN) frames.push(m); },
    pushModule: push,
    isMultiUser: MULTI,
    listAdmins: function () { return [ADMIN]; },
    onResolvedByOperator: function (type) {
      resolvedByOperator.push(type);
      if (type === buildNotify.TYPE) standing.declined();
    },
  });
  var env = { push: push, inApp: store, isMultiUser: MULTI, listAdmins: function () { return [ADMIN]; } };
  var shows = [];
  var monitor = createBuildMonitor({
    assess: function () { return Object.assign({ state: "stale" }, verdict.current); },
    log: function () {},
    reminderEvery: 30,
  });
  var standing = createStandingOffer({
    listChanges: function () { return Promise.resolve(LISTED); },
    desired: function () { return monitor.confirmedStale(); },
    quietMs: 3600000,
    now: function () { return clock.t; },
    compose: composeNotice,
    show: function (m) { shows.push(m); buildNotify.showBuildOffer(env, m); },
    retract: function () { buildNotify.resolveBuildOffer(env); },
  });
  return {
    frames: frames, push: push, store: store, standing: standing, shows: shows, clock: clock,
    resolvedByOperator: resolvedByOperator, verdict: verdict,
    // Two consecutive checks confirm a stale verdict; the reconcile follows each.
    poll: function () { monitor.check(); standing.reconcile(monitor.confirmedStale()); },
    settle: function () { return new Promise(function (r) { setImmediate(r); }); },
    // What the daemon sends a tab that connects now.
    connect: function () {
      var out = null;
      store.sendConnectionState({ _clagenticUser: { id: ADMIN } }, function (ws, m) { out = m; }, null);
      return out;
    },
    created: function () { return frames.filter(function (m) { return m.type === "notification_created"; }); },
  };
}

function setPrefs(prefsMod, view) {
  prefsMod.handleNotificationPrefs({ prefs: view.prefs, preset: view.preset, known: true, categories: [], presets: [] });
}

// The admin's browser: the real page handlers over a fake DOM.
async function adminPage(t) {
  await dom.setupToolsEnv(t);
  // Animation frames run at once, so a shown pop-up carries its "visible" class.
  global.requestAnimationFrame = function (fn) { fn(); return 0; };
  var toasts = new dom.FakeElement("div");
  global.document.body.appendChild(toasts);
  global.document.getElementById = function (id) { return id === "diagnostic-toast-container" ? toasts : null; };
  var storeMod = await import(dom.moduleUrl("store.js"));
  storeMod.store.set({ currentSlug: "proj-a", activeSessionId: 1 });
  var sent = [];
  var wsRef = await import(dom.moduleUrl("ws-ref.js"));
  wsRef.setWs({ readyState: 1, send: function (raw) { sent.push(JSON.parse(raw)); } });
  var diagnostics = await import(dom.moduleUrl("diagnostics.js"));
  // The diagnostics module is shared by every page instance of this process.
  diagnostics.withdrawBuildOffer();
  // The preferences module is shared too: every page starts from the defaults.
  var prefsMod = await import(dom.moduleUrl("notification-prefs.js"));
  setPrefs(prefsMod, createPrefsStore({ file: path.join(process.env.CLAGENTIC_CONSOLE_HOME, "prefs-none.json"), persist: function () {} }).view(null));
  var mod = await import(dom.moduleUrl("app-notifications.js") + "?popup=" + (++seq));
  mod.initAppNotifications();
  var banners = global.document.body._children[global.document.body._children.length - 1];
  var page = {
    sent: sent, mod: mod, diagnostics: diagnostics, toasts: toasts, banners: banners,
    receive: function (m) {
      if (m.type === "notification_created") mod.handleNotificationCreated(m);
      else if (m.type === "notifications_state") mod.handleNotificationsState(m);
      else if (m.type === "notification_dismissed") mod.handleNotificationDismissed(m);
      else if (m.type === "notification_dismissed_all") mod.handleNotificationDismissedAll(m);
    },
    popups: function () {
      return toasts.querySelectorAll('[data-diag-source="build-update"]').filter(function (el) {
        return el.classList.contains("visible") && el.querySelectorAll("button").some(function (b) { return b.textContent === RESTART_LABEL; });
      });
    },
    bannerOf: function (id) { return banners.querySelector('[data-notif-id="' + id + '"]'); },
    // The server answers a frame the page sent, as the daemon would.
    deliver: function (world, from) {
      world.frames.slice(from || 0).forEach(function (m) { page.receive(m); });
    },
  };
  return page;
}

// The offer's own close: the restart click asks for the confirmation, and "Not
// now" on it declines. The page's close frame goes to the daemon's store.
function declineViaPage(w, page) {
  page.popups()[0].querySelectorAll("button").filter(function (b) { return b.textContent === RESTART_LABEL; })[0].click();
  page.diagnostics.addDiagnostic({
    type: "diagnostic", severity: "warning", source: "build-update", message: "A restart now would end 0 live sessions.",
    buildUpdate: Object.assign({ token: "tok" }, w.created()[0].notification.meta.buildUpdate),
    actionable: { label: "Restart now", action: "confirm_build_update_restart" },
  });
  page.toasts.querySelectorAll("button").filter(function (b) { return b.textContent === "Not now"; })[0].click();
  var dismissals = page.sent.filter(function (m) { return m.type === "notification_dismiss"; });
  assert.equal(dismissals.length, 1, "the page asked the server to close the offer");
  var from = w.frames.length;
  w.store.handleNotificationMessage({ _clagenticUser: { id: ADMIN } }, dismissals[0]);
  page.deliver(w, from);
}

// ---------------------------------------------------------------------------
// Reproduction at main: which stage holds, which does not.
// ---------------------------------------------------------------------------

test("repro: a confirmed stale assessment is emitted as an offer notification (emit)", async function () {
  var w = daemonWorld();
  w.poll();
  assert.equal(w.shows.length, 0, "one stale check is not confirmed");
  w.poll();
  await w.settle();
  assert.ok(w.shows.length >= 1, "the standing offer raised the offer");
  var held = w.connect().notifications.filter(function (n) { return n.type === "build_update_offer"; });
  assert.equal(held.length, 1, "the banner store holds the offer");
  assert.equal(held[0].meta.actionable.action, "restart_for_build_update");
});

test("repro: the admin's socket is sent the offer (delivery)", async function () {
  var w = daemonWorld();
  w.poll(); w.poll();
  await w.settle();
  assert.ok(w.created().length >= 1, "a notification_created frame reached the admin socket");
  assert.equal(w.created()[0].notification.type, "build_update_offer");
  assert.equal(w.created()[0].notification.category, "system");
});

test("one alert: the page draws the offer's pop-up and no stack banner, on arrival, on connect and from the bell", async function (t) {
  var w = daemonWorld();
  var page = await adminPage(t);
  w.poll(); w.poll();
  await w.settle();
  page.deliver(w);
  var offer = w.created()[0].notification;
  assert.equal(page.bannerOf(offer.id), null, "no stack banner for the offer");
  assert.equal(page.banners.querySelectorAll(".notif-banner").length, 0, "nothing in the banner stack");
  assert.equal(page.popups().length, 1, "the pop-up is the one alert");
  page.receive(w.connect());
  assert.equal(page.bannerOf(offer.id), null, "none after a reconnect's state either");
  assert.equal(page.popups().length, 1);
});

test("AC1: while a tab is open the offer is a visible pop-up carrying the restart action", async function (t) {
  var w = daemonWorld();
  var page = await adminPage(t);
  w.poll(); w.poll();
  await w.settle();
  page.deliver(w);
  assert.equal(page.popups().length, 1, "a pop-up with the restart button is on screen");
});

// ---------------------------------------------------------------------------
// The rows after the fix.
// ---------------------------------------------------------------------------

test("AC1: the change list arriving later replaces the pop-up in place: still one", async function (t) {
  var w = daemonWorld();
  var page = await adminPage(t);
  w.poll(); w.poll();
  page.deliver(w);
  assert.equal(page.popups().length, 1);
  var from = w.frames.length;
  await w.settle();
  page.deliver(w, from);
  assert.ok(w.created().length >= 2, "the core sent the refreshed offer");
  t.mock.timers.tick(300);
  assert.equal(page.popups().length, 1, "one pop-up, replaced in place");
});

test("AC1: a pop-up the operator closed is not brought back by the refresh; closing it declines nothing", async function (t) {
  var w = daemonWorld();
  var page = await adminPage(t);
  w.poll(); w.poll();
  page.deliver(w);
  page.popups()[0].querySelectorAll(".toast-diagnostic-dismiss")[0]._listeners.click[0]({});
  t.mock.timers.tick(300);
  assert.equal(page.popups().length, 0, "closed");
  var from = w.frames.length;
  await w.settle();
  page.deliver(w, from);
  t.mock.timers.tick(300);
  assert.ok(w.created().length >= 2, "the core sent the refreshed offer");
  assert.equal(page.popups().length, 0, "it does not pop up again");
  assert.deepEqual(page.sent, [], "closing a pop-up declined nothing");
});

test("AC3: a clear-all with the pop-up up draws no banner and leaves the offer undeclined", async function (t) {
  var w = daemonWorld();
  var page = await adminPage(t);
  w.poll(); w.poll();
  await w.settle();
  page.deliver(w);
  var from = w.frames.length;
  w.store.handleNotificationMessage({ _clagenticUser: { id: ADMIN } }, { type: "notification_dismiss_all" });
  page.deliver(w, from);
  assert.equal(page.banners.querySelectorAll(".notif-banner").length, 0);
  assert.deepEqual(w.resolvedByOperator, []);
  assert.equal(page.popups().length, 1);
});

test("AC1: with the banner surface muted for the system category the entry is held but no pop-up shows", async function (t) {
  var w = daemonWorld();
  var page = await adminPage(t);
  var prefsMod = await import(dom.moduleUrl("notification-prefs.js"));
  var muted = createPrefsStore({ file: path.join(process.env.CLAGENTIC_CONSOLE_HOME, "prefs-muted.json"), persist: function () {} });
  muted.set(null, { surfaces: { banner: { system: false } } });
  setPrefs(prefsMod, muted.view(null));
  w.poll(); w.poll();
  page.deliver(w);
  assert.equal(page.popups().length, 0, "muted: no pop-up");
  assert.equal(page.toasts.querySelectorAll('[data-diag-source="build-update"]').length, 0);
});

test("AC2: a page that connects while the offer stands shows the pop-up once", async function (t) {
  var w = daemonWorld();
  w.poll(); w.poll();
  await w.settle();
  var page = await adminPage(t);
  page.receive(w.connect());
  assert.equal(page.popups().length, 1, "the pop-up shows on connect");
  // Another socket of the same page (a project switch) is sent the same state.
  page.receive(w.connect());
  page.receive(w.connect());
  assert.equal(page.popups().length, 1, "and only once");
  assert.deepEqual(page.sent, []);
});

test("AC2: a page that connects after the offer was withdrawn shows no pop-up", async function (t) {
  var w = daemonWorld();
  w.poll(); w.poll();
  await w.settle();
  buildNotify.resolveBuildOffer({ push: w.push, inApp: w.store, isMultiUser: MULTI, listAdmins: function () { return [ADMIN]; } });
  var page = await adminPage(t);
  page.receive(w.connect());
  assert.equal(page.popups().length, 0);
});

test("AC3: a notifications clear-all neither declines the offer nor removes its entry and pop-up", async function (t) {
  var w = daemonWorld();
  var page = await adminPage(t);
  w.poll(); w.poll();
  await w.settle();
  page.deliver(w);
  assert.equal(page.popups().length, 1);
  w.push.calls.length = 0;
  var from = w.frames.length;
  assert.equal(w.store.handleNotificationMessage({ _clagenticUser: { id: ADMIN } }, { type: "notification_dismiss_all" }), true);
  page.deliver(w, from);
  assert.deepEqual(w.resolvedByOperator, [], "the daemon was not told the offer was declined");
  assert.deepEqual(w.push.calls, [], "no close was pushed to the phone");
  var held = w.connect().notifications.filter(function (n) { return n.type === "build_update_offer"; });
  assert.equal(held.length, 1, "the offer is still held");
  assert.equal(page.popups().length, 1, "the pop-up is still there");
  // The standing offer is not quiet: the same assessment raises nothing new, so
  // it never has to come back.
  var shown = w.shows.length;
  w.poll();
  assert.equal(w.shows.length, shown);
});

test("AC3: a clear-all still clears every other notification", async function (t) {
  var w = daemonWorld();
  var page = await adminPage(t);
  w.poll(); w.poll();
  await w.settle();
  w.store.notify("loop_complete", { slug: "proj-a", name: "L", reason: "complete", iterations: 1 }, {});
  page.deliver(w);
  var from = w.frames.length;
  w.store.handleNotificationMessage({ _clagenticUser: { id: ADMIN } }, { type: "notification_dismiss_all" });
  page.deliver(w, from);
  var left = w.connect().notifications.map(function (n) { return n.type; });
  assert.deepEqual(left, ["build_update_offer"]);
});

test("AC3: the offer's own close declines it and tells the daemon", async function (t) {
  var w = daemonWorld();
  var page = await adminPage(t);
  w.poll(); w.poll();
  await w.settle();
  page.deliver(w);
  declineViaPage(w, page);
  assert.deepEqual(w.resolvedByOperator, ["build_update_offer"]);
  assert.equal(w.connect().notifications.filter(function (n) { return n.type === "build_update_offer"; }).length, 0);
});

test("AC4: after a decline no pop-up shows until the cooldown has elapsed", async function (t) {
  var w = daemonWorld();
  var page = await adminPage(t);
  w.poll(); w.poll();
  await w.settle();
  page.deliver(w);
  assert.equal(page.banners.querySelectorAll(".notif-banner").length, 0, "no banner exists: the pop-up's decline alone carries the cooldown");
  declineViaPage(w, page);
  t.mock.timers.tick(300);
  assert.equal(page.popups().length, 0, "declined");
  var from = w.frames.length;
  var shown = w.shows.length;
  w.clock.t += 60000;
  w.poll();
  await w.settle();
  assert.equal(w.shows.length, shown, "inside the cooldown nothing is raised");
  assert.equal(w.frames.length, from, "and nothing is sent to the page");
  assert.equal(page.popups().length, 0);
  w.clock.t += 3600000;
  w.poll();
  await w.settle();
  page.deliver(w, from);
  assert.ok(w.shows.length > shown, "after the cooldown the standing offer returns");
  assert.equal(page.popups().length, 1, "and pops up again");
});

test("AC5: with the system push preference off, the offer is not pushed to the phone", async function () {
  // The real push module over a stubbed transport, for a subscribed admin whose
  // system push is off.
  var webpush = require("web-push");
  var sentToDevice = [];
  var realSend = webpush.sendNotification;
  webpush.sendNotification = function (sub, json) { sentToDevice.push(JSON.parse(json)); return Promise.resolve(); };
  try {
    var { initPush } = require("../lib/push");
    var prefs = createPrefsStore({ file: path.join(process.env.CLAGENTIC_CONSOLE_HOME, "prefs-ac5.json"), persist: function () {} });
    prefs.set(ADMIN, { surfaces: { push: { system: false } } });
    var pushModule = initPush({ prefs: prefs, isMultiUser: MULTI });
    pushModule.addSubscription({ endpoint: "https://push.example.invalid/ac5" }, null, ADMIN);
    sentToDevice.length = 0;
    var w = daemonWorld({ push: pushModule });
    w.poll(); w.poll();
    await w.settle();
    assert.ok(w.created().length >= 1, "the in-console offer was raised");
    assert.deepEqual(sentToDevice.filter(function (p) { return p.type !== "test"; }), [], "nothing reached the device");
    // And with the preference on, the same path does push, so the row proves the filter.
    prefs.set(ADMIN, { surfaces: { push: { system: true } } });
    var w2 = daemonWorld({ push: pushModule });
    w2.poll(); w2.poll();
    await w2.settle();
    assert.ok(sentToDevice.some(function (p) { return p.type === "build_update_offer"; }), "push follows the preference");
  } finally {
    webpush.sendNotification = realSend;
  }
});

test("a connecting page is sent its preferences before the notification state, so a muted banner is known when the offer is judged", function () {
  var order = [];
  var store = attachNotifications({
    broadcastAll: function () {}, isMultiUser: MULTI, listAdmins: function () { return [ADMIN]; },
    prefsStore: createPrefsStore({ file: path.join(process.env.CLAGENTIC_CONSOLE_HOME, "prefs-order.json"), persist: function () {} }),
  });
  store.sendConnectionState({ _clagenticUser: { id: ADMIN } }, function (ws, m) { order.push(m.type); }, null);
  assert.deepEqual(order, ["notification_prefs", "notifications_state"]);
});

// ---------------------------------------------------------------------------
// Fold round 2.
// ---------------------------------------------------------------------------

test("R-573-1: a non-admin's clear-all message carries no admin-only id; the admin's names the offer", function () {
  var VIEWERS = [ADMIN, "member-2"];
  var out = {};
  var store = attachNotifications({
    broadcastAll: function () {},
    broadcastPerViewer: function (build) { VIEWERS.forEach(function (v) { out[v] = build(v); }); },
    sendToUser: function () {},
    isMultiUser: MULTI,
    listAdmins: function () { return [ADMIN]; },
  });
  var env = { push: null, inApp: store, isMultiUser: MULTI, listAdmins: function () { return [ADMIN]; } };
  buildNotify.showBuildOffer(env, composeNotice(stale("r1"), LISTED));
  var held = null;
  store.sendConnectionState({ _clagenticUser: { id: ADMIN } }, function (ws, m) { held = m; }, null);
  var offerId = held.notifications.filter(function (n) { return n.type === "build_update_offer"; })[0].id;
  assert.ok(offerId, "the admin holds the offer");
  assert.equal(store.handleNotificationMessage({ _clagenticUser: { id: ADMIN } }, { type: "notification_dismiss_all" }), true);
  assert.deepEqual(out[ADMIN].kept, [offerId], "the admin is told what stands");
  assert.deepEqual(out["member-2"].kept, [], "the member is told no admin-only id");
  assert.ok(JSON.stringify(out["member-2"]).indexOf(offerId) === -1, "the id appears nowhere in the member's message");
});

test("R-573-2: a refresh of an offer on screen, through show(), keeps one pop-up with the updated content", async function (t) {
  var w = daemonWorld();
  var page = await adminPage(t);
  w.poll(); w.poll();
  page.deliver(w);
  assert.equal(page.popups().length, 1);
  var before = page.popups()[0].textContent;
  var from = w.frames.length;
  await w.settle();
  var refresh = w.frames.slice(from);
  assert.deepEqual(refresh.map(function (m) { return m.type; }), ["notification_dismissed", "notification_created"]);
  assert.equal(refresh[0].replaced, true, "the dismissal says a replacement follows");
  // The dismissal and the replacement are separate frames; the page's own
  // animation can finish between them.
  page.receive(refresh[0]);
  t.mock.timers.tick(300);
  assert.equal(page.popups().length, 1, "the pop-up is not lost on the dismissal");
  page.receive(refresh[1]);
  t.mock.timers.tick(300);
  assert.equal(page.popups().length, 1, "still one pop-up");
  assert.notEqual(page.popups()[0].textContent, before, "carrying the refreshed content");
});

test("R-573-2: a resolve (no replacement) still withdraws the offer and its pop-up", async function (t) {
  var w = daemonWorld();
  var page = await adminPage(t);
  w.poll(); w.poll();
  await w.settle();
  page.deliver(w);
  var from = w.frames.length;
  buildNotify.resolveBuildOffer({ push: w.push, inApp: w.store, isMultiUser: MULTI, listAdmins: function () { return [ADMIN]; } });
  page.deliver(w, from);
  t.mock.timers.tick(300);
  assert.equal(page.popups().length, 0, "gone");
});

test("R-573-3: the diagnostics clear-all keeps the offer entry and its pop-up, declines nothing, and clears the rest", async function (t) {
  var w = daemonWorld();
  var page = await adminPage(t);
  var panel = new dom.FakeElement("div");
  var list = new dom.FakeElement("div");
  var toggle = new dom.FakeElement("button");
  var badge = new dom.FakeElement("span");
  var clearAll = new dom.FakeElement("button");
  clearAll.className = "diagnostics-panel-clear-all";
  panel.appendChild(clearAll);
  var byId = { "diagnostic-toast-container": page.toasts, "diagnostics-panel": panel, "diagnostics-panel-list": list, "diagnostics-panel-btn": toggle, "diagnostics-panel-badge": badge };
  global.document.getElementById = function (id) { return byId[id] || null; };
  page.diagnostics.initDiagnostics();
  w.poll(); w.poll();
  await w.settle();
  page.deliver(w);
  page.diagnostics.addDiagnostic({ type: "diagnostic", severity: "warning", source: "other-source", message: "something else" });
  assert.equal(list.querySelectorAll(".diagnostics-item").length, 2);
  page.sent.length = 0;
  clearAll.click();
  t.mock.timers.tick(300);
  assert.equal(list.querySelectorAll(".diagnostics-item").length, 1, "only the offer's entry is left");
  assert.equal(page.popups().length, 1, "its pop-up is still there");
  assert.equal(page.toasts.querySelectorAll('[data-diag-source="other-source"]').length, 0, "other toasts went");
  assert.deepEqual(page.sent, [], "nothing was declined");
  // Its own entry's dismiss is a decline.
  list.querySelectorAll(".diagnostics-item-dismiss")[0].click();
  assert.equal(page.sent.filter(function (m) { return m.type === "notification_dismiss"; }).length, 1);
});

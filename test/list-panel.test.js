"use strict";

// The Notifications (bell) and Diagnostics buttons open the same list panel
// (modules/list-panel.js). The real modules run over the hand-built DOM: the
// shared panel's behaviour is one table run once per user, then the bell's own
// rows (one per notification type, each action checked against the banner's),
// the bell no longer re-raising stored notifications, and clear-all.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var dom = require("./fake-dom-prompt-cards");
var cssRules = require("./fixtures/css-rules");

var MENUS_CSS = fs.readFileSync(path.join(__dirname, "../lib/public/css/menus.css"), "utf8");

var FakeElement = dom.FakeElement;
var seq = 0;

// The hand-built DOM does not parse markup; rows and banners are drawn from html
// strings, so an element of this page parses what it is given into children.
function decode(s) { return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"'); }
class HtmlElement extends FakeElement {
  get innerHTML() { return this._html || ""; }
  set innerHTML(v) {
    this._children = [];
    this._text = "";
    this._html = String(v);
    var self = this;
    parseHtml(this._html).forEach(function (c) { self.appendChild(c); });
  }
}
function parseHtml(html) {
  var root = new HtmlElement("div");
  var open = [root];
  var VOID = { img: true, br: true, input: true };
  var re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  var m;
  while ((m = re.exec(html))) {
    var top = open[open.length - 1];
    if (m[5] !== undefined) { top._text += decode(m[5]); continue; }
    if (m[1]) { if (!VOID[m[2]]) open.pop(); continue; }
    var el = new HtmlElement(m[2]);
    var attrRe = /([\w:-]+)(?:="([^"]*)")?/g;
    var a;
    while ((a = attrRe.exec(m[3]))) {
      var value = a[2] === undefined ? "" : decode(a[2]);
      if (a[1] === "class") el.className = value;
      else el.setAttribute(a[1], value);
    }
    top.appendChild(el);
    if (!VOID[m[2]] && !m[4]) open.push(el);
  }
  return root._children;
}
FakeElement.prototype.closest = function (tag) {
  for (var n = this; n; n = n._parent) if (n.tagName === tag.toUpperCase()) return n;
  return null;
};
// A click carries what a browser's does: the target and a stopPropagation.
FakeElement.prototype.click = function () {
  if (this.disabled) return;
  var self = this;
  (this._listeners.click || []).slice().forEach(function (fn) { fn({ target: self, stopPropagation: function () {} }); });
};

// One browser tab: the page's buttons, the #info-panels column, the toast stack,
// the socket (a list of the frames it was sent) and the registry's document
// listeners, which the test fires by hand.
async function page(t) {
  // A test may open more than one page: each starts from fresh timers.
  t.mock.timers.reset();
  await dom.setupToolsEnv(t);
  global.requestAnimationFrame = function (fn) { fn(); return 0; };
  global.document.createElement = function (tag) { return new HtmlElement(tag); };
  var registry = await import(dom.moduleUrl("overlay-registry.js"));
  registry.closeOpenMenu();
  var listeners = {};
  global.document.addEventListener = function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); };
  var find = function (node, id) {
    return node.id === id ? node : node._children.reduce(function (hit, c) { return hit || find(c, id); }, null);
  };
  global.document.getElementById = function (id) { return find(global.document.body, id); };
  function mount(tag, id, cls) {
    var el = new HtmlElement(tag);
    el.id = id;
    if (cls) el.className = cls;
    global.document.body.appendChild(el);
    return el;
  }
  var p = {
    registry: registry,
    host: mount("div", "info-panels"),
    stack: mount("div", "overlay-stack", "overlay-stack"),
    bell: mount("button", "notif-center-btn"),
    diagBtn: mount("button", "diagnostics-panel-btn"),
    sent: [],
    focused: [],
  };
  mount("span", "notif-center-badge", "hidden");
  mount("span", "diagnostics-panel-badge", "hidden");
  [p.bell, p.diagBtn].forEach(function (btn) { btn.focus = function () { p.focused.push(btn); }; });
  var storeMod = await import(dom.moduleUrl("store.js"));
  storeMod.store.set({ currentSlug: "proj-a", activeSessionId: 1 });
  var wsRef = await import(dom.moduleUrl("ws-ref.js"));
  wsRef.setWs({ readyState: 1, send: function (raw) { p.sent.push(JSON.parse(raw)); } });
  p.notif = await import(dom.moduleUrl("app-notifications.js") + "?list-panel=" + (++seq));
  p.diagnostics = await import(dom.moduleUrl("diagnostics.js"));
  p.notif.initAppNotifications();
  p.diagnostics.initDiagnostics();
  p.notifPanel = global.document.getElementById("notifications-panel");
  p.diagPanel = global.document.getElementById("diagnostics-panel");
  // The diagnostics module is shared by every page of this process.
  p.diagPanel.querySelector(".list-panel-clear-all").click();
  p.sent.length = 0;
  p.escape = function () { (listeners.keydown || []).forEach(function (fn) { fn({ key: "Escape" }); }); };
  p.clickAt = function (target) { (listeners.click || []).forEach(function (fn) { fn({ target: target }); }); };
  p.rows = function (panel) { return panel.querySelectorAll(".list-panel-row"); };
  p.isOpen = function (panel) { return registry.isMenuOpen(panel); };
  p.state = function (notifications, unread) {
    p.notif.handleNotificationsState({ notifications: notifications, unreadCount: unread === undefined ? notifications.length : unread });
  };
  return p;
}

function notification(id, over) {
  return Object.assign({
    id: id, type: "loop_complete", category: "agents", title: "Loop " + id, body: "done", slug: "proj-b", sessionId: 7, meta: {},
  }, over);
}

// ---------------------------------------------------------------------------
// The shared panel: one table, run once per user.
// ---------------------------------------------------------------------------

var USERS = [
  {
    name: "notifications", panel: "notifPanel", button: "bell", other: "diagBtn", otherPanel: "diagPanel",
    emptyText: "No notifications.", title: "Notifications",
    reinit: function (p) { p.notif.initAppNotifications(); },
    arrive: function (p) { var id = "n" + (++seq); p.notif.handleNotificationCreated({ unreadCount: 1, notification: notification(id) }); },
    // The card the arrival raises in the toast stack, which the panel does not touch.
    cards: function (p) { return p.stack.querySelectorAll(".notif-banner").length; },
  },
  {
    name: "diagnostics", panel: "diagPanel", button: "diagBtn", other: "bell", otherPanel: "notifPanel",
    emptyText: "No diagnostics this session.", title: "Diagnostics",
    reinit: function (p) { p.diagnostics.initDiagnostics(); },
    arrive: function (p) { var n = ++seq; p.diagnostics.addDiagnostic({ type: "diagnostic", severity: "warning", source: "s" + n, message: "message " + n }); },
    cards: function (p) { return p.stack.querySelectorAll(".toast-diagnostic").length; },
  },
];

var SHARED = [
  { name: "a press opens the panel in the page's info-panels column, with its header, close and clear-all",
    run: function (p, u) {
      p[u.button].click();
      var el = p[u.panel];
      assert.equal(p.isOpen(el), true);
      assert.equal(el.classList.contains("hidden"), false);
      assert.equal(el.parentNode, p.host, "same column");
      assert.equal(el.querySelector(".usage-panel-header span").textContent, u.title);
      assert.ok(el.querySelector(".usage-panel-header .list-panel-clear-all"), "clear-all in the header");
      assert.equal(el.querySelectorAll(".overlay-close").length, 1, "one close control");
      assert.equal(el._children[el._children.length - 1].className.indexOf("overlay-close") !== -1, true, "close control last, in its corner");
    } },
  { name: "the same button again closes it, and aria-expanded follows on the button",
    run: function (p, u) {
      assert.equal(p[u.button].getAttribute("aria-expanded"), "false");
      p[u.button].click();
      assert.equal(p[u.button].getAttribute("aria-expanded"), "true");
      p[u.button].click();
      assert.equal(p.isOpen(p[u.panel]), false);
      assert.equal(p[u.button].getAttribute("aria-expanded"), "false");
      assert.equal(p[u.panel].classList.contains("hidden"), true);
    } },
  { name: "an empty list shows its fixed text in the panel, and nothing pops up",
    run: function (p, u) {
      var before = p.stack._children.length;
      p[u.button].click();
      assert.equal(p[u.panel].querySelector(".list-panel-empty").textContent, u.emptyText);
      t_tick(p, 5000);
      assert.equal(p.stack._children.length, before, "no timed banner");
    } },
  { name: "the other button closes the first and opens the second (one open)",
    run: function (p, u) {
      p[u.button].click();
      p[u.other].click();
      assert.equal(p.isOpen(p[u.panel]), false);
      assert.equal(p.isOpen(p[u.otherPanel]), true);
      assert.equal(p[u.button].getAttribute("aria-expanded"), "false");
      assert.equal(p[u.other].getAttribute("aria-expanded"), "true");
    } },
  { name: "Escape closes it and focus returns to the button",
    run: function (p, u) {
      p[u.button].click();
      p.focused.length = 0;
      p.escape();
      assert.equal(p.isOpen(p[u.panel]), false);
      assert.deepEqual(p.focused, [p[u.button]]);
    } },
  { name: "the close control closes it and focus returns to the button",
    run: function (p, u) {
      p[u.button].click();
      p.focused.length = 0;
      p[u.panel].querySelector(".overlay-close").click();
      assert.equal(p.isOpen(p[u.panel]), false);
      assert.deepEqual(p.focused, [p[u.button]]);
    } },
  { name: "an outside click closes it and leaves focus where the click went; a click inside does not close it",
    run: function (p, u) {
      p[u.button].click();
      p.clickAt(p[u.panel].querySelector(".list-panel-empty"));
      assert.equal(p.isOpen(p[u.panel]), true, "inside");
      p.focused.length = 0;
      p.clickAt(global.document.body);
      assert.equal(p.isOpen(p[u.panel]), false, "outside");
      assert.deepEqual(p.focused, []);
    } },
  { name: "an arrival while the panel is open is listed in it, and its card is raised in the stack as before",
    run: function (p, u) {
      p[u.button].click();
      var cards = u.cards(p);
      u.arrive(p);
      assert.equal(p.rows(p[u.panel]).length, 1);
      assert.equal(p[u.panel].querySelector(".list-panel-empty"), null, "the empty state is gone");
      assert.equal(u.cards(p), cards + 1, "the arrival card");
      assert.equal(p.isOpen(p[u.panel]), true, "still open");
    } },
  { name: "an arrival for this list while the other panel is open is listed, and the other stays open",
    run: function (p, u) {
      p[u.other].click();
      u.arrive(p);
      assert.equal(p.isOpen(p[u.otherPanel]), true);
      assert.equal(p.rows(p[u.panel]).length, 1, "listed for when it opens");
      p[u.button].click();
      assert.equal(p.rows(p[u.panel]).length, 1);
    } },
  { name: "every row has its own dismiss control, and it removes just that row",
    run: function (p, u) {
      u.arrive(p); u.arrive(p);
      p[u.button].click();
      var rows = p.rows(p[u.panel]);
      assert.equal(rows.length, 2);
      rows.forEach(function (r) {
        assert.equal(r.querySelectorAll(".list-panel-row-dismiss").length, 1);
        assert.ok(r.querySelector(".list-panel-row-dismiss").getAttribute("aria-label"), "the dismiss control is named");
      });
      rows[0].querySelector(".list-panel-row-dismiss").click();
      assert.equal(p.rows(p[u.panel]).length, 1);
    } },
  { name: "clear-all empties the list into the same empty state, and the close control stays",
    run: function (p, u) {
      u.arrive(p); u.arrive(p); u.arrive(p);
      p[u.button].click();
      assert.equal(p.rows(p[u.panel]).length, 3);
      p[u.panel].querySelector(".list-panel-clear-all").click();
      assert.equal(p.rows(p[u.panel]).length, 0);
      assert.equal(p[u.panel].querySelector(".list-panel-empty").textContent, u.emptyText);
      assert.equal(p.isOpen(p[u.panel]), true);
    } },
  { name: "at phone width the same component opens, in the same column",
    run: function (p, u) {
      global.window.innerWidth = 390;
      p[u.button].click();
      assert.equal(p.isOpen(p[u.panel]), true);
      assert.ok(p[u.panel].classList.contains("list-panel"));
      assert.equal(p[u.panel].parentNode, p.host);
    } },
  { name: "a second init leaves one opener listener: one press opens and the panel stays open",
    run: function (p, u) {
      u.reinit(p);
      assert.equal(p[u.button]._listeners.click.length, 1, "one listener on the opener");
      p[u.button].click();
      assert.equal(p.isOpen(p[u.panel]), true);
      p[u.button].click();
      assert.equal(p.isOpen(p[u.panel]), false, "and one more press closes it");
    } },
  // The panel sits in the click-through #info-panels column, so it opts
  // back into pointer events on its own bounds when open, and a closed one is
  // display:none and blocks none. Read from the real stylesheet.
  { name: "an open panel takes pointer events and a closed one is hidden, so blocks none",
    run: function (p, u) {
      var el = p[u.panel];
      assert.ok(el.classList.contains("list-panel"), "styled by the shared class");
      assert.equal(cssRules.valueAt(MENUS_CSS, "#info-panels", "pointer-events", 1280), "none");
      p[u.button].click();
      assert.equal(el.classList.contains("hidden"), false);
      assert.equal(cssRules.valueAt(MENUS_CSS, ".list-panel", "pointer-events", 1280), "auto");
      p[u.button].click();
      assert.equal(el.classList.contains("hidden"), true);
      assert.equal(cssRules.valueAt(MENUS_CSS, ".list-panel.hidden", "display", 1280), "none");
    } },
  { name: "the clear-all and row dismiss controls are styled by the shared stylesheet",
    run: function (p, u) {
      u.arrive(p);
      p[u.button].click();
      var row = p.rows(p[u.panel])[0];
      assert.ok(row.querySelector(".list-panel-row-dismiss"));
      assert.ok(p[u.panel].querySelector(".list-panel-clear-all"));
      assert.equal(cssRules.valueAt(MENUS_CSS, ".list-panel-row-dismiss", "position", 1280), "absolute");
      assert.equal(cssRules.valueAt(MENUS_CSS, ".usage-panel-header .list-panel-clear-all", "cursor", 1280), "pointer");
    } },
];

var tickRef = null;
function t_tick(p, ms) { tickRef.mock.timers.tick(ms); }

USERS.forEach(function (u) {
  SHARED.forEach(function (row) {
    test(u.name + ": " + row.name, async function (t) {
      tickRef = t;
      var p = await page(t);
      row.run(p, u);
    });
  });
});

test("both panels are built the same: the same classes, in the same order, whatever the list", async function (t) {
  var p = await page(t);
  function shape(node) {
    return [node.className.split(/\s+/).filter(function (c) { return c === "list-panel" || c.indexOf("list-panel-") === 0 || c === "usage-panel-header" || c === "usage-panel-body"; }).join(".")]
      .concat(node._children.map(shape));
  }
  var strip = function (el) { return JSON.stringify(shape(el)); };
  assert.equal(strip(p.notifPanel), strip(p.diagPanel));
  assert.equal(p.notifPanel.parentNode, p.diagPanel.parentNode);
});

// ---------------------------------------------------------------------------
// The bell: stored notifications are rows, not re-raised banners.
// ---------------------------------------------------------------------------

var BELL = [
  { name: "none stored: the panel shows its empty state; no banner and no timed message", stored: 0 },
  { name: "one stored: one row, no banner", stored: 1 },
  { name: "many stored: one row each, newest first, no banner and no floating Clear all", stored: 3 },
];

BELL.forEach(function (row) {
  test("bell with " + row.name, async function (t) {
    tickRef = t;
    var p = await page(t);
    var list = [];
    for (var i = 0; i < row.stored; i++) list.push(notification("s" + i));
    p.state(list);
    p.bell.click();
    assert.equal(p.stack.querySelectorAll(".notif-banner").length, 0, "nothing raised in the stack");
    assert.equal(p.stack.querySelectorAll(".notif-banner-clear-all").length, 0);
    t_tick(p, 5000);
    assert.equal(p.stack.querySelectorAll(".notif-banner").length, 0, "no timed message");
    var rows = p.rows(p.notifPanel);
    assert.equal(rows.length, row.stored);
    assert.deepEqual(rows.map(function (r) { return r.getAttribute("data-notif-id"); }), list.map(function (n) { return n.id; }));
    assert.equal(!!p.notifPanel.querySelector(".list-panel-empty"), row.stored === 0);
    p.bell.click();
    assert.equal(p.isOpen(p.notifPanel), false, "pressing again closes, it does not raise again");
    assert.equal(p.stack.querySelectorAll(".notif-banner").length, 0);
  });
});

test("a row dismissed while the socket is offline lowers the bell count at once", async function (t) {
  var p = await page(t);
  p.state([notification("o1"), notification("o2")]);
  var badge = global.document.getElementById("notif-center-badge");
  assert.equal(badge.textContent, "2");
  var wsRef = await import(dom.moduleUrl("ws-ref.js"));
  wsRef.setWs({ readyState: 3, send: function () { throw new Error("offline"); } });
  p.bell.click();
  p.rows(p.notifPanel)[0].querySelector(".list-panel-row-dismiss").click();
  assert.equal(p.rows(p.notifPanel).length, 1);
  assert.equal(badge.textContent, "1");
  p.rows(p.notifPanel)[0].querySelector(".list-panel-row-dismiss").click();
  assert.equal(badge.classList.contains("hidden"), true);
});

test("a row keyed like an inherited property (toString) is removed on the next sync", async function (t) {
  var p = await page(t);
  p.state([notification("toString")]);
  assert.equal(p.rows(p.notifPanel).length, 1);
  p.state([]);
  assert.equal(p.rows(p.notifPanel).length, 0);
  assert.ok(p.notifPanel.querySelector(".list-panel-empty"));
});

test("the removed paths are gone: no re-raise function and no random empty-state message", function () {
  var fs = require("fs");
  var path = require("path");
  var src = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "app-notifications.js"), "utf8");
  assert.equal(/showAllBanners|randomEmptyMessage|EMPTY_MESSAGES/.test(src), false);
});

// ---------------------------------------------------------------------------
// Rows keep their actions: each type, the panel's row against the arrival banner.
// ---------------------------------------------------------------------------

var PERMISSION_META = { requestId: "r1", kind: "permission", toolName: "Bash", toolInput: { command: "ls" } };

var TYPES = [
  { name: "permission prompt: answer",
    notif: notification("p1", { type: "permission_request", category: "approval", persistent: true, meta: PERMISSION_META }),
    act: function (root) { root.querySelector('button[data-decision="allow"]').click(); },
    frames: [{ type: "prompt_response", requestId: "r1", kind: "permission", decision: "allow", targetSlug: "proj-b" }] },
  { name: "permission prompt: allow for session and no",
    notif: notification("p2", { type: "permission_request", category: "approval", persistent: true, meta: PERMISSION_META }),
    act: function (root) {
      assert.deepEqual(root.querySelectorAll("button[data-decision]").map(function (b) { return b.getAttribute("data-decision"); }), ["allow", "allow_always", "deny"]);
      root.querySelector('button[data-decision="deny"]').click();
    },
    frames: [{ type: "prompt_response", requestId: "r1", kind: "permission", decision: "deny", targetSlug: "proj-b" }] },
  { name: "permission prompt: go to session",
    notif: notification("p3", { type: "permission_request", category: "approval", persistent: true, slug: "proj-a", sessionId: 9, meta: PERMISSION_META }),
    act: function (root) { root.querySelector(".notif-banner-goto").click(); },
    frames: [{ type: "switch_session", id: 9 }, { type: "notification_dismiss", ids: ["p3"] }] },
  { name: "permission reminder: tap goes to its session and dismisses",
    notif: notification("r1", { type: "permission_reminder", category: "approval", slug: "proj-a", sessionId: 4 }),
    act: function (root) { fire(root); },
    frames: [{ type: "notification_dismiss", ids: ["r1"] }, { type: "switch_session", id: 4 }] },
  { name: "user mention: tap goes to its session and dismisses",
    notif: notification("m1", { type: "user_mention", category: "social", slug: "proj-a", sessionId: 5, meta: { fromName: "Pat" } }),
    act: function (root) { fire(root); },
    frames: [{ type: "notification_dismiss", ids: ["m1"] }, { type: "switch_session", id: 5 }] },
  { name: "update available: Update now",
    notif: notification("u1", { type: "update_available", category: "system", slug: null, sessionId: null, title: "Update", meta: { version: "9.9.9" } }),
    act: function (root) {
      assert.equal(root.querySelector(".notif-banner-title").textContent, "v9.9.9 is available");
      var btn = root.querySelector(".notif-banner-update-now");
      btn.click();
      assert.equal(btn.disabled, true);
      assert.equal(btn.textContent, "Updating...");
    },
    frames: [{ type: "update_now" }] },
  { name: "update available: per-row dismiss",
    notif: notification("u2", { type: "update_available", category: "system", slug: null, sessionId: null, title: "Update", meta: { version: "9.9.9" } }),
    act: function (root) { dismissOf(root).click(); },
    frames: [{ type: "notification_dismiss", ids: ["u2"] }],
    rowOnly: true },
  // The agent has no login command registered, so the terminal is not started
  // (it needs the whole terminal UI); the dismissal and the reminder it raises are.
  { name: "auth required: Open terminal and log in",
    notif: notification("a1", { type: "auth_required", category: "system", slug: null, sessionId: null, persistent: true, meta: { vendor: "unregistered-agent" } }),
    act: function (root) { root.querySelector(".notif-banner-auth-login").click(); },
    frames: [{ type: "notification_dismiss", ids: ["a1"] }],
    // Only the panel's row is followed on: the sign-in row leaves, the login
    // reminder row takes its place, outlasts a refresh and offers a new session.
    afterRow: function (q, rowEl) {
      assert.equal(q.notifPanel.querySelector('[data-notif-id="a1"]'), null, "the sign-in row is gone");
      assert.ok(q.notifPanel.querySelector('[data-auth-reminder="true"]'), "the reminder is a row too");
      q.sent.length = 0;
      q.state([]);
      assert.ok(q.notifPanel.querySelector('[data-auth-reminder="true"]'), "it outlasts a state refresh");
      q.notifPanel.querySelector(".notif-banner-new-session").click();
      assert.deepEqual(q.sent, [{ type: "new_session" }]);
      assert.equal(q.notifPanel.querySelector('[data-auth-reminder="true"]'), null);
    } },
];

function fire(root) {
  (root._listeners.click || []).slice().forEach(function (fn) { fn({ target: root, stopPropagation: function () {} }); });
}
function dismissOf(row) { return row.querySelector(".list-panel-row-dismiss"); }

// The frames without the request ids the page generates.
function shapeOf(frames) {
  return frames.map(function (f) {
    var c = Object.assign({}, f);
    if (c.type === "term_create") delete c.requestId;
    return c;
  });
}

TYPES.forEach(function (row) {
  test("notification rows: " + row.name + ", the same frames the banner sends", async function (t) {
    var p = await page(t);
    // The banner, as the arrival draws it.
    var viaBanner = null;
    if (!row.rowOnly) {
      p.notif.handleNotificationCreated({ unreadCount: 1, notification: row.notif });
      var banner = p.stack.querySelector('[data-notif-id="' + row.notif.id + '"]');
      assert.ok(banner, "the arrival banner is drawn");
      p.sent.length = 0;
      row.act(banner);
      viaBanner = shapeOf(p.sent);
      assert.deepEqual(viaBanner, row.frames, "the banner's frames");
    }
    // The row, from the bell.
    var q = await page(t);
    q.state([row.notif]);
    q.bell.click();
    var rowEl = q.notifPanel.querySelector('[data-notif-id="' + row.notif.id + '"]');
    assert.ok(rowEl, "the row is listed");
    q.sent.length = 0;
    row.act(rowEl);
    assert.deepEqual(shapeOf(q.sent), row.frames, "the row's frames");
    if (viaBanner) assert.deepEqual(shapeOf(q.sent), viaBanner, "row and banner agree");
    if (row.afterRow) row.afterRow(q, rowEl);
  });
});

test("notification rows: a permission row waiting for the server stays as it is through a refresh, and is answerable again when the connection drops", async function (t) {
  var p = await page(t);
  var n = TYPES[0].notif;
  p.state([n]);
  p.bell.click();
  var row = p.notifPanel.querySelector('[data-notif-id="p1"]');
  var allow = row.querySelector('button[data-decision="allow"]');
  allow.click();
  assert.equal(allow.disabled, true, "sending");
  p.state([n, notification("later")]);
  assert.equal(p.notifPanel.querySelector('[data-notif-id="p1"]'), row, "the same row node, not redrawn");
  assert.equal(allow.disabled, true);
  p.notif.restoreUnconfirmedPromptBanners("Connection lost. Choose again.");
  assert.equal(allow.disabled, false, "answerable again");
});

// ---------------------------------------------------------------------------
// Clear-all and reload.
// ---------------------------------------------------------------------------

var OFFER = notification("offer1", {
  type: "build_update_offer", category: "system", slug: null, sessionId: null,
  meta: {
    buildUpdate: { loadedBuildSha: "a".repeat(40), installedBuildSha: "b".repeat(40) },
    message: "A newer build is installed.",
    actionable: { label: "Restart to apply update", action: "restart_for_build_update" },
  },
});

test("notifications clear-all asks the server, empties the list, and keeps the standing build offer in the diagnostics list", async function (t) {
  var p = await page(t);
  p.state([notification("c1"), notification("c2"), OFFER]);
  assert.equal(p.diagPanel.querySelectorAll(".diagnostics-item").length, 1, "the offer is held in diagnostics");
  p.bell.click();
  assert.equal(p.rows(p.notifPanel).length, 2, "the bell lists the two, not the offer");
  p.sent.length = 0;
  p.notifPanel.querySelector(".list-panel-clear-all").click();
  assert.deepEqual(p.sent, [{ type: "notification_dismiss_all" }]);
  assert.equal(p.rows(p.notifPanel).length, 0);
  assert.equal(p.notifPanel.querySelector(".list-panel-empty").textContent, "No notifications.");
  // The server's answer names what it kept.
  p.notif.handleNotificationDismissedAll({ kept: ["offer1"], unreadCount: 1 });
  assert.equal(p.rows(p.notifPanel).length, 0);
  assert.equal(p.diagPanel.querySelectorAll(".diagnostics-item").length, 1, "the offer stays in diagnostics");
  assert.equal(p.diagPanel.querySelectorAll(".list-panel-row").length, 1);
  p.diagPanel.querySelector(".list-panel-clear-all").click();
  assert.equal(p.diagPanel.querySelectorAll(".diagnostics-item").length, 1, "and survives the diagnostics clear-all too");
});

test("reload after clearing notifications: the server's list no longer holds them, so the panel opens empty", async function (t) {
  var p = await page(t);
  p.state([notification("c1"), notification("c2")]);
  p.bell.click();
  p.notifPanel.querySelector(".list-panel-clear-all").click();
  // A reload is a new page: its first state is the server's, with the cleared ones gone.
  var q = await page(t);
  q.state([]);
  q.bell.click();
  assert.equal(q.rows(q.notifPanel).length, 0);
  assert.equal(q.notifPanel.querySelector(".list-panel-empty").textContent, "No notifications.");
});

test("diagnostics clear-all is client-side: it sends nothing to the server, so a reload starts with an empty list", async function (t) {
  var p = await page(t);
  p.diagnostics.addDiagnostic({ type: "diagnostic", severity: "error", source: "x" + (++seq), message: "boom " + seq });
  p.diagnostics.addDiagnostic({ type: "diagnostic", severity: "error", source: "x" + (++seq), message: "boom " + seq });
  var badge = global.document.getElementById("diagnostics-panel-badge");
  assert.equal(badge.textContent, "2");
  p.diagBtn.click();
  p.rows(p.diagPanel)[0].querySelector(".list-panel-row-dismiss").click();
  assert.equal(badge.textContent, "1", "a dismissal refreshes the badge");
  p.sent.length = 0;
  p.diagPanel.querySelector(".list-panel-clear-all").click();
  assert.equal(badge.classList.contains("hidden"), true, "clear-all hides the badge");
  assert.deepEqual(p.sent, [], "no frame");
  assert.equal(p.rows(p.diagPanel).length, 0);
  var fresh = await import(dom.moduleUrl("diagnostics.js") + "?reload=" + (++seq));
  global.document.getElementById("diagnostics-panel").remove();
  fresh.initDiagnostics();
  var reloaded = global.document.getElementById("diagnostics-panel");
  assert.equal(reloaded.querySelectorAll(".list-panel-row").length, 0, "a new page holds no diagnostics");
});

test("a notification arriving while the bell's panel is open lands in it, and its row has the actions its banner had", async function (t) {
  var p = await page(t);
  p.bell.click();
  p.notif.handleNotificationCreated({ unreadCount: 1, notification: TYPES[0].notif });
  var row = p.notifPanel.querySelector('[data-notif-id="p1"]');
  assert.ok(row, "listed while open");
  assert.equal(row.querySelectorAll("button[data-decision]").length, 3);
  assert.ok(p.stack.querySelector('[data-notif-id="p1"]'), "and the banner is raised");
  p.notif.handleNotificationDismissed({ ids: ["p1"], unreadCount: 0 });
  assert.equal(p.notifPanel.querySelector('[data-notif-id="p1"]'), null, "the server's dismissal takes the row out");
  assert.ok(p.notifPanel.querySelector(".list-panel-empty"));
});

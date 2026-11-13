"use strict";

// Toasts and banners share one component (modules/overlay.js), one stacking
// manager (modules/overlay-stack.js) and one stylesheet (css/overlay.css).
// No browser: the real modules run over the hand-built DOM, and the real
// stylesheets are read through the css-rules fixture at a desktop and a phone
// width. Each table below is one area; a row is one variant.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var dom = require("./fake-dom-prompt-cards");
var cssRules = require("./fixtures/css-rules");

var CSS_DIR = path.join(__dirname, "..", "lib", "public", "css");
function css(name) { return fs.readFileSync(path.join(CSS_DIR, name), "utf8"); }
var OVERLAY = css("overlay.css");
var BASE = css("base.css");
var DIAGNOSTICS = css("diagnostics.css");
var NOTIFICATIONS = css("notifications-center.css");

var DESKTOP = 1280;
var PHONE = 390;
var WIDTHS = [DESKTOP, PHONE];
var instance = 0;

// One browser: the real modules over a fake DOM whose getElementById walks the
// tree, so the stack and the reload banner are found by id as in a page.
async function browser(t) {
  await dom.setupToolsEnv(t);
  global.requestAnimationFrame = function (fn) { fn(); return 0; };
  var find = function (node, id) {
    return node.id === id ? node : node._children.reduce(function (hit, c) { return hit || find(c, id); }, null);
  };
  global.document.getElementById = function (id) { return find(global.document.body, id); };
  var storeMod = await import(dom.moduleUrl("store.js"));
  storeMod.store.set({ currentSlug: "proj-a", activeSessionId: 1 });
  var wsRef = await import(dom.moduleUrl("ws-ref.js"));
  wsRef.setWs({ readyState: 1, send: function () {} });
  var n = ++instance;
  var notif = await import(dom.moduleUrl("app-notifications.js") + "?overlay=" + n);
  notif.initAppNotifications();
  return {
    notif: notif,
    diagnostics: await import(dom.moduleUrl("diagnostics.js") + "?overlay=" + n),
    utils: await import(dom.moduleUrl("utils.js")),
    guard: await import(dom.moduleUrl("build-guard.js")),
    stack: function () { return global.document.body.querySelector(".overlay-stack"); },
  };
}

function banner(id, over) {
  return {
    type: "notification_created", unreadCount: 1,
    notification: Object.assign({
      id: id, type: "permission_request", category: "approval", title: "Run Bash", body: "", persistent: true,
      slug: "proj-b", sessionId: 102, meta: { requestId: "r-" + id, kind: "permission", toolName: "Bash", toolInput: { command: "ls" } },
    }, over),
  };
}

// Every surface in scope, raised through its own module. `find` locates its card.
var SURFACES = [
  { name: "plain toast", dismissible: false, find: ".overlay-toast",
    raise: function (b) { b.utils.showToast("Saved", "error", "detail line"); } },
  { name: "diagnostic toast", dismissible: true, find: ".toast-diagnostic",
    raise: function (b) { b.diagnostics.addDiagnostic({ type: "diagnostic", severity: "warning", source: "preflight", message: "m" }); } },
  { name: "build-update offer", dismissible: true, find: ".toast-diagnostic",
    raise: function (b) {
      b.diagnostics.addDiagnostic({
        type: "diagnostic", severity: "warning", source: "build-update", message: "A newer build is installed.",
        actionable: { label: "Restart to apply update", action: "restart_for_build_update" },
      });
    } },
  { name: "notification banner", dismissible: true, find: '.notif-banner[data-notif-id="b1"]',
    raise: function (b) { b.notif.handleNotificationCreated(banner("b1")); } },
  { name: "update-available banner", dismissible: true, find: '.notif-banner[data-notif-id="u1"]',
    raise: function (b) { b.notif.handleNotificationCreated(banner("u1", { type: "update_available", persistent: true, meta: { version: "9.9.9" } })); } },
  { name: "auth-required banner", dismissible: true, find: "[data-auth-banner]",
    raise: function (b) { b.notif.showAuthRequiredBanner({ id: "a1", vendor: "v", loginCommand: "login" }); } },
  { name: "reload banner, service-worker update", dismissible: true, find: ".sw-update-banner",
    raise: function (b) { b.guard.showReloadBanner(global.document, function () {}, { text: "New version available", dismissible: true }); } },
  { name: "reload banner, build guard", dismissible: false, find: ".sw-update-banner",
    raise: function (b) { b.guard.showReloadBanner(global.document, function () {}); } },
];

function escapeKey(card) {
  (card._listeners.keydown || []).forEach(function (fn) { fn({ key: "Escape", target: { tagName: "DIV" } }); });
}

// ---------------------------------------------------------------------------
// Stacking: one column, so no two cards share a spot
// ---------------------------------------------------------------------------

test("a diagnostic toast, a banner, a plain toast and the reload banner share one in-flow column at each width", async function (t) {
  for (var w = 0; w < WIDTHS.length; w++) {
    var width = WIDTHS[w];
    var at = "at " + width + "px";
    t.mock.timers.reset(); // each row is a fresh browser
    var b = await browser(t);
    ["diagnostic toast", "notification banner", "plain toast", "reload banner, build guard"].forEach(function (name) {
      SURFACES.filter(function (s) { return s.name === name; })[0].raise(b);
    });

    var cards = b.stack().children;
    assert.equal(cards.length, 4, "all four are children of the one stack " + at);
    cards.forEach(function (card) {
      assert.ok(card.classList.contains("overlay"), "each is the shared card " + at);
      assert.deepEqual(Object.keys(card.style), [], "no card places itself with an inline style " + at);
    });
    assert.equal(global.document.body.querySelectorAll(".overlay-stack").length, 1, "one stack, not one per surface " + at);

    // The stack is a fixed flex column; its children are in flow, so heights add
    // up and no two boxes intersect.
    var all = BASE + OVERLAY + DIAGNOSTICS + NOTIFICATIONS;
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-stack", "position", width), "fixed", "stack position " + at);
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-stack", "display", width), "flex", "stack display " + at);
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-stack", "flex-direction", width), "column", "stack direction " + at);
    assert.ok(cssRules.valueAt(OVERLAY, ".overlay-stack", "gap", width), "cards are separated by a gap " + at);
    cards.forEach(function (card) {
      card.className.split(/\s+/).forEach(function (cls) {
        var position = cssRules.valueAt(all, "." + cls, "position", width);
        assert.ok(position === null || position === "relative", "." + cls + " is in flow " + at + ", got " + position);
      });
    });
  }
});

test("the stack spans the phone and is a fixed-width corner column on a desktop", function () {
  assert.equal(cssRules.valueAt(OVERLAY, ".overlay-stack", "left", PHONE), "var(--overlay-stack-inset)");
  assert.equal(cssRules.valueAt(OVERLAY, ".overlay-stack", "width", PHONE), "auto");
  assert.equal(cssRules.valueAt(OVERLAY, ".overlay-stack", "left", DESKTOP), null, "a desktop stack hangs from the right edge");
  assert.match(cssRules.valueAt(OVERLAY, ".overlay-stack", "width", DESKTOP), /--overlay-width/);
  assert.match(cssRules.valueAt(OVERLAY, ".overlay-stack", "top", PHONE), /--safe-top/, "below the notch on a phone");
});

test("the manager replaces by source, clears a group, and a card leaves once however it is closed", async function (t) {
  var b = await browser(t);
  var stackMod = await import(dom.moduleUrl("overlay-stack.js"));
  var overlay = await import(dom.moduleUrl("overlay.js"));
  var removed = [];
  var a = overlay.showOverlay({ kind: "toast", source: "s1", group: "g", content: "x", onRemove: function () { removed.push("a"); } });
  overlay.showOverlay({ kind: "toast", source: "s2", group: "g", content: "y" });
  assert.equal(stackMod.cardsBySource("s1").length, 1);
  assert.equal(stackMod.cardsBySource().length, 2);

  a.close();
  a.close();
  assert.deepEqual(removed, ["a"], "the removal hook runs once");
  stackMod.clearGroup("g");
  assert.equal(b.stack().querySelectorAll(".overlay").length, 0, "the group is gone at once");
  assert.throws(function () { overlay.showOverlay({ kind: "modal", content: "z" }); }, /kind must be toast or banner/);
});

// ---------------------------------------------------------------------------
// Close control: same element, same corner, always visible, Escape dismisses
// ---------------------------------------------------------------------------

test("close control: each surface has the shared control and Escape dismisses it, or has none and ignores Escape", async function (t) {
  for (var i = 0; i < SURFACES.length; i++) {
    var row = SURFACES[i];
    t.mock.timers.reset(); // each row is a fresh browser
    var b = await browser(t);
    row.raise(b);
    var card = b.stack().querySelector(row.find);
    assert.ok(card, row.name + ": drawn in the stack");
    var closes = card.querySelectorAll(".overlay-close");
    if (!row.dismissible) {
      assert.equal(closes.length, 0, row.name + ": no close control");
      escapeKey(card);
      assert.equal(card.classList.contains("hide"), false, row.name + ": Escape leaves it");
      continue;
    }
    assert.equal(closes.length, 1, row.name + ": one close control");
    assert.equal(closes[0].tagName, "BUTTON", row.name + ": the control is a button");
    assert.ok(closes[0].getAttribute("aria-label"), row.name + ": it is named for assistive tech");
    assert.equal(closes[0]._parent, card, row.name + ": it is the card's own child, at the card's corner");
    escapeKey(card);
    assert.equal(card.classList.contains("hide"), true, row.name + ": Escape dismisses");
  }
});

test("close control css: top-right, always visible, one rule at each width", function () {
  WIDTHS.forEach(function (width) {
    var at = "at " + width + "px";
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-close", "position", width), "absolute", "position " + at);
    assert.ok(cssRules.valueAt(OVERLAY, ".overlay-close", "top", width), "top " + at);
    assert.ok(cssRules.valueAt(OVERLAY, ".overlay-close", "right", width), "right " + at);
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-close", "left", width), null, "never the top-left corner " + at);
    [OVERLAY, BASE, DIAGNOSTICS, NOTIFICATIONS].forEach(function (sheet) {
      cssRules.rules(sheet).filter(function (r) { return /(close|dismiss)/.test(r.selector) && /overlay|toast|banner/.test(r.selector); })
        .forEach(function (r) {
          assert.ok(!/opacity\s*:\s*0\s*(;|$)/.test(r.body), r.selector + " must not hide the control until hover " + at);
        });
    });
  });
});

test("a leaving card passes clicks through while it fades", function () {
  [
    { name: "hide state", selector: ".overlay.hide", prop: "pointer-events", want: "none" },
  ].forEach(function (row) {
    assert.equal(cssRules.valueAt(OVERLAY, row.selector, row.prop, DESKTOP), row.want, row.name + ": " + row.selector + " sets " + row.prop);
  });
});

// ---------------------------------------------------------------------------
// Stylesheets: no overlay look outside the shared component
// ---------------------------------------------------------------------------

// What a component stylesheet may still say about a card: nothing but that a
// banner is clickable.
var CARD_SELECTORS = [
  ".toast", ".toast-diagnostic", ".sw-update-banner", ".notif-banner", ".notif-banner-container",
  "#diagnostic-toast-container", ".notif-banner-close", ".toast-diagnostic-dismiss", ".sw-update-banner-dismiss",
  ".notif-banner.show", ".notif-banner.hide", ".toast.visible", ".sw-update-banner.visible",
];

[["base.css", BASE], ["diagnostics.css", DIAGNOSTICS], ["notifications-center.css", NOTIFICATIONS]].forEach(function (sheet) {
  test("stylesheet: " + sheet[0] + " keeps no card position, layer or chrome for a moved surface", function () {
    cssRules.rules(sheet[1]).forEach(function (r) {
      var selectors = r.selector.split(",").map(function (s) { return s.trim(); });
      selectors.filter(function (s) { return CARD_SELECTORS.indexOf(s) !== -1; }).forEach(function (s) {
        var props = r.body.split(";").map(function (d) { return d.split(":")[0].trim(); }).filter(Boolean);
        assert.deepEqual(props.filter(function (p) { return p !== "cursor"; }), [], s + " styles the card; that belongs to overlay.css");
      });
    });
    var z = sheet[1].match(/z-index\s*:\s*[^;]+/g) || [];
    z.forEach(function (decl) {
      assert.match(decl, /var\(--z-(base|menu|modal|toast|tooltip)\)/, sheet[0] + " takes every z-index from the token scale: " + decl);
    });
  });
});

test("stylesheet: the layer scale is ordered and the stack and the menus take their layer from it", function () {
  var root = cssRules.rules(BASE).filter(function (r) { return r.selector === ":root" && /--z-base/.test(r.body); })[0];
  assert.ok(root, "the scale is declared on :root");
  // A menu opens from the surface under it (the full-screen mobile sheet, the
  // terminal panel, a modal), so it sits above modals and panels.
  var names = ["base", "modal", "menu", "toast", "tooltip"];
  var order = names.map(function (name) {
    return Number(new RegExp("--z-" + name + ":\\s*(\\d+)").exec(root.body)[1]);
  });
  for (var i = 1; i < names.length; i++) {
    assert.ok(order[i] > order[i - 1], "--z-" + names[i - 1] + " (" + order[i - 1] + ") < --z-" + names[i] + " (" + order[i] + ")");
  }
  assert.equal(cssRules.valueAt(OVERLAY, ".overlay-stack", "z-index", DESKTOP), "var(--z-toast)");
  assert.equal(cssRules.valueAt(OVERLAY, ".overlay-menu", "z-index", DESKTOP), "var(--z-menu)");
  assert.equal(cssRules.valueAt(OVERLAY, ".overlay-menu", "position", DESKTOP), "fixed");
});

test("stylesheet: overlay.css reads sizes from tokens; the only literals are the named ones", function () {
  var allowed = ["1px", "2px", "8px", "24px"]; // border, focus ring, shadow offset and blur
  cssRules.rules(OVERLAY).forEach(function (r) {
    var literals = r.body.replace(/var\([^)]*\)/g, "").match(/\b\d+(\.\d+)?px\b/g) || [];
    literals.forEach(function (px) {
      assert.ok(allowed.indexOf(px) !== -1, r.selector + " carries the unnamed literal " + px);
    });
  });
});

// ---------------------------------------------------------------------------
// Behaviour kept by the move
// ---------------------------------------------------------------------------

var TOAST_WINDOWS = [
  { name: "a plain toast keeps its 1500 ms window", level: undefined, ms: 1500 },
  { name: "a warn toast keeps its 5000 ms window", level: "warn", ms: 5000 },
  { name: "an error toast keeps its 5000 ms window", level: "error", ms: 5000 },
];

test("showToast keeps its signature and its timeout per level", async function (t) {
  for (var i = 0; i < TOAST_WINDOWS.length; i++) {
    var row = TOAST_WINDOWS[i];
    t.mock.timers.reset(); // each row is a fresh browser
    var b = await browser(t);
    assert.equal(b.utils.showToast.length, 3, row.name + ": the signature is (message, level, detail)");
    b.utils.showToast("Saved", row.level, "first line\nsecond line");
    var card = b.stack().querySelector(".overlay-toast");
    assert.equal(card.getAttribute("data-severity"), row.level || null, row.name + ": severity");
    assert.equal(card.querySelector(".overlay-detail").textContent, "first line", row.name + ": detail is the first line");
    assert.deepEqual(Object.keys(card.querySelector(".overlay-detail").style), [], row.name + ": the detail line has no inline style");
    t.mock.timers.tick(row.ms - 1);
    assert.equal(card.classList.contains("hide"), false, row.name + ": still shown just before the window");
    t.mock.timers.tick(1);
    assert.equal(card.classList.contains("hide"), true, row.name + ": hidden at the window");
    t.mock.timers.tick(300);
    assert.equal(b.stack().querySelectorAll(".overlay-toast").length, 0, row.name + ": removed after the exit");
  }
});

test("a diagnostic toast keeps its 6 s window, and one with an action or a persistent state stays", async function (t) {
  var b = await browser(t);
  b.diagnostics.addDiagnostic({ type: "diagnostic", severity: "error", source: "plain", message: "m" });
  b.diagnostics.addDiagnostic({ type: "diagnostic", severity: "error", source: "persistent", message: "m", persistent: true });
  b.diagnostics.addDiagnostic({
    type: "diagnostic", severity: "warning", source: "build-update", message: "m",
    actionable: { label: "Restart to apply update", action: "restart_for_build_update" },
  });
  var cardOf = function (source) { return b.stack().querySelector('[data-overlay-source="' + source + '"]'); };
  t.mock.timers.tick(5999);
  assert.equal(cardOf("plain").classList.contains("hide"), false);
  t.mock.timers.tick(1);
  assert.equal(cardOf("plain").classList.contains("hide"), true);
  t.mock.timers.tick(60000);
  assert.equal(cardOf("persistent").classList.contains("hide"), false);
  assert.equal(cardOf("build-update").classList.contains("hide"), false);
});

test("the diagnostics clear-all removes diagnostic cards only, not another surface's card with a source key", async function (t) {
  var b = await browser(t);
  var overlay = await import(dom.moduleUrl("overlay.js"));
  var panel = new dom.FakeElement("div");
  panel.id = "diagnostics-panel";
  var list = new dom.FakeElement("div");
  list.id = "diagnostics-panel-list";
  var clearAll = new dom.FakeElement("button");
  clearAll.className = "diagnostics-panel-clear-all";
  panel.appendChild(clearAll);
  global.document.body.appendChild(panel);
  global.document.body.appendChild(list);
  ["diagnostics-panel-btn", "diagnostics-panel-badge"].forEach(function (id) {
    var el = new dom.FakeElement("span");
    el.id = id;
    global.document.body.appendChild(el);
  });
  b.diagnostics.initDiagnostics();
  b.diagnostics.addDiagnostic({ type: "diagnostic", severity: "error", source: "d", message: "m" });
  overlay.showOverlay({ kind: "toast", source: "other-surface", content: "x" });
  assert.equal(b.stack().querySelectorAll("[data-overlay-source]").length, 2, "both cards carry a source key");

  clearAll.click();
  t.mock.timers.tick(300);
  assert.equal(b.stack().querySelectorAll('[data-overlay-source="d"]').length, 0, "the diagnostic card goes");
  assert.equal(b.stack().querySelectorAll('[data-overlay-source="other-surface"]').length, 1, "the other surface's card stays");
});

test("the notification banners redraw and clear in their own group, leaving toasts alone", async function (t) {
  var b = await browser(t);
  b.utils.showToast("Saved");
  b.diagnostics.addDiagnostic({ type: "diagnostic", severity: "error", source: "d", message: "m" });
  b.notif.handleNotificationCreated(banner("b1"));
  b.notif.handleNotificationCreated(banner("b2"));
  assert.equal(b.stack().querySelectorAll(".notif-banner-clear-all").length, 1, "two banners offer Clear all");

  b.notif.handleNotificationDismissedAll({ kept: [], unreadCount: 0 });
  assert.equal(b.stack().querySelectorAll(".notif-banner").length, 0, "the banners are gone");
  assert.equal(b.stack().querySelectorAll(".notif-banner-clear-all").length, 0, "and so is the Clear all pill");
  assert.equal(b.stack().querySelectorAll(".overlay-toast").length, 2, "the toasts stay");
});

// ---------------------------------------------------------------------------
// Menus and popovers: the anchored kinds and the one open-menu registry
// ---------------------------------------------------------------------------

// A document of its own, so its click and Escape handlers can be fired by hand:
// the registry wires one capture click handler and one keydown handler per
// document, never one per menu.
async function menuBrowser(t) {
  var b = await browser(t);
  var overlay = await import(dom.moduleUrl("overlay.js"));
  var registry = await import(dom.moduleUrl("overlay-registry.js"));
  registry.closeOpenMenu();
  var listeners = {};
  var doc = {
    body: new dom.FakeElement("body"),
    createElement: function (tag) { return sized(new dom.FakeElement(tag), { width: 50, height: 30 }); },
    addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  return {
    b: b, overlay: overlay, registry: registry, doc: doc,
    handlerCount: function (type) { return (listeners[type] || []).length; },
    click: function (target) { (listeners.click || []).forEach(function (fn) { fn({ target: target }); }); },
    escape: function () { (listeners.keydown || []).forEach(function (fn) { fn({ key: "Escape" }); }); },
  };
}

function sized(el, box) {
  var rect = { top: 100, left: 100, width: box.width, height: box.height, right: 100 + box.width, bottom: 100 + box.height };
  el.getBoundingClientRect = function () { return rect; };
  return el;
}

// An anchor control in the page, 40 x 20 at (100, 100).
function anchorEl(m) {
  var el = sized(m.doc.createElement("button"), { width: 40, height: 20 });
  m.doc.body.appendChild(el);
  return el;
}

// Each B1 surface with the options its module passes. `node` says how it gets
// its card: built by the module and adopted ("built"), a node index.html already
// has ("page", retained hidden), or created by the component ("new"). `at` is
// where popover-position.js must put it for an anchor at (100,100) 40x20 and a
// 50x30 card on a 1280 x 800 viewport.
var MENU_SURFACES = [
  { name: "session-info", kind: "popover", node: "new", opener: true, place: { placement: "below" }, at: { left: "100px", top: "126px" } },
  { name: "project context menu", kind: "menu", node: "built", place: { placement: "right" }, at: { left: "146px", top: "100px" } },
  { name: "project context menu, below", kind: "menu", node: "built", opener: true, place: { placement: "below", gap: 4 }, at: { left: "100px", top: "124px" } },
  { name: "project access popover", kind: "popover", node: "new", closeButton: true, place: { placement: "right", gap: 8 }, at: { left: "148px", top: "100px" } },
  { name: "emoji picker", kind: "popover", node: "built", place: { placement: "right" }, at: { left: "146px", top: "100px" } },
  { name: "session context menu", kind: "menu", node: "built", place: { placement: "below-right-aligned", gap: 2 }, at: { left: "90px", top: "122px" } },
  { name: "terminal context menu", kind: "menu", node: "built", point: { x: 300, y: 200 }, at: { left: "300px", top: "200px" } },
  { name: "sticky-note colour picker", kind: "popover", node: "built", place: { placement: "below", gap: 4 }, at: { left: "100px", top: "124px" } },
  { name: "schedule popover", kind: "popover", node: "page", place: { placement: "below" }, at: { left: "100px", top: "126px" } },
  { name: "schedule end-type list", kind: "menu", node: "page", opener: true, place: { placement: "below", gap: 4 }, at: { left: "100px", top: "124px" } },
  { name: "loop pending popover", kind: "popover", node: "new", opener: true, id: "loop-pending-popover", place: { placement: "below-right-aligned" }, at: { left: "90px", top: "126px" } },
];

function openSurface(m, row) {
  var anchor = row.point || anchorEl(m);
  var opts = Object.assign({ kind: row.kind, anchor: anchor, doc: m.doc, id: row.id, closeButton: row.closeButton }, row.place);
  if (row.opener) opts.opener = anchor;
  if (row.node === "new") opts.content = "<span>x</span>";
  else {
    opts.el = sized(m.doc.createElement("div"), { width: 50, height: 30 });
    if (row.node === "page") {
      opts.retain = true;
      opts.el.className = "hidden";
      m.doc.body.appendChild(opts.el);
    }
  }
  var handle = m.overlay.showOverlay(opts);
  return { handle: handle, anchor: anchor, inside: handle.el.appendChild(m.doc.createElement("span")) };
}

function gone(handle) {
  return !handle.isOpen() && (!handle.el.parentNode || handle.el.classList.contains("hidden"));
}

test("menu: each B1 surface opens as the shared menu, placed by popover-position.js, on the menu layer's class", async function (t) {
  for (var i = 0; i < MENU_SURFACES.length; i++) {
    var row = MENU_SURFACES[i];
    t.mock.timers.reset();
    var m = await menuBrowser(t);
    var open = openSurface(m, row);
    var el = open.handle.el;
    assert.ok(el.classList.contains("overlay-menu"), row.name + ": the shared card");
    assert.equal(el.classList.contains("overlay-popover"), row.kind === "popover", row.name + ": the kind is a class");
    assert.equal(el.getAttribute("data-overlay-kind"), row.kind, row.name + ": the kind is an attribute");
    assert.equal(el.classList.contains("hidden"), false, row.name + ": an adopted page node is shown");
    assert.ok(el.parentNode, row.name + ": in the page");
    assert.deepEqual({ left: el.style.left, top: el.style.top, position: el.style.position },
      { left: row.at.left, top: row.at.top, position: "fixed" }, row.name + ": placed by popover-position.js");
    assert.equal(open.handle.isOpen(), true, row.name + ": tracked by the registry");
    assert.equal(el.querySelectorAll(".overlay-close").length, row.closeButton ? 1 : 0, row.name + ": the close control only where asked");
  }
});

test("menu: one open: a second menu closes the first, for element-then-element and element-then-point", async function (t) {
  var PAIRS = [
    { name: "element anchored, then element anchored", first: "session context menu", second: "project context menu" },
    { name: "element anchored, then point anchored", first: "sticky-note colour picker", second: "terminal context menu" },
    { name: "point anchored, then element anchored", first: "terminal context menu", second: "emoji picker" },
    { name: "a retained page node, then a built one", first: "schedule popover", second: "project access popover" },
  ];
  for (var i = 0; i < PAIRS.length; i++) {
    var pair = PAIRS[i];
    t.mock.timers.reset();
    var m = await menuBrowser(t);
    var row = function (name) { return MENU_SURFACES.filter(function (s) { return s.name === name; })[0]; };
    var first = openSurface(m, row(pair.first)).handle;
    var second = openSurface(m, row(pair.second)).handle;
    assert.equal(gone(first), true, pair.name + ": the first is closed");
    assert.equal(second.isOpen(), true, pair.name + ": the second is open");
    assert.equal(m.registry.getOpenMenu(), second.el, pair.name + ": the registry holds the second");
    assert.equal(m.handlerCount("click"), 1, pair.name + ": one outside-click handler");
    assert.equal(m.handlerCount("keydown"), 1, pair.name + ": one Escape handler");
  }
});

test("menu: Escape and an outside click close each B1 surface; its opener and its own content do not", async function (t) {
  for (var i = 0; i < MENU_SURFACES.length; i++) {
    var row = MENU_SURFACES[i];
    t.mock.timers.reset();
    var m = await menuBrowser(t);
    var open = openSurface(m, row);
    var handle = open.handle;

    m.click(open.inside);
    assert.equal(handle.isOpen(), true, row.name + ": a click on its own content leaves it");
    if (row.opener) {
      m.click(open.anchor);
      assert.equal(handle.isOpen(), true, row.name + ": a click on its opener is the opener's to handle");
    }
    m.escape();
    assert.equal(gone(handle), true, row.name + ": Escape closes it");

    var again = openSurface(m, row).handle;
    m.click(m.doc.body);
    assert.equal(gone(again), true, row.name + ": a click outside closes it");
    if (row.node === "page") {
      assert.equal(again.el.classList.contains("hidden"), true, row.name + ": a page node is hidden, not removed (data-tip-suppress-when-open reads it)");
    } else {
      assert.equal(again.el.parentNode, null, row.name + ": a built card is removed");
    }
  }
});

test("menu: closing reports once, however it closes, and a stale handle cannot close a newer menu", async function (t) {
  var m = await menuBrowser(t);
  var calls = [];
  var a = m.overlay.showOverlay({ kind: "menu", content: "a", doc: m.doc, onRemove: function () { calls.push("a"); } });
  a.close();
  a.close();
  var b = m.overlay.showOverlay({ kind: "menu", content: "b", doc: m.doc, onRemove: function () { calls.push("b"); } });
  a.close();
  assert.equal(b.isOpen(), true, "the first handle does not close the second menu");
  m.escape();
  m.escape();
  assert.deepEqual(calls, ["a", "b"], "each close hook runs once");
});

test("menu: Escape closes the open menu and never a toast; a toast alone is left", async function (t) {
  var m = await menuBrowser(t);
  m.b.utils.showToast("Saved", "error", "detail");
  var toast = m.b.stack().querySelector(".overlay-toast");
  var card = m.overlay.showOverlay({ kind: "toast", content: "x", dismissible: true });

  var menu = m.overlay.showOverlay({ kind: "menu", content: "m", doc: m.doc });
  m.escape();
  assert.equal(menu.isOpen(), false, "the menu closed");
  assert.equal(toast.classList.contains("hide"), false, "the plain toast stayed");
  assert.equal(card.el.classList.contains("hide"), false, "the dismissible toast stayed");

  m.escape();
  assert.equal(card.el.classList.contains("hide"), false, "with no menu open Escape on the document leaves the toast");
});

test("menu: the shared close control is the card's own top-right button and closes it", async function (t) {
  var m = await menuBrowser(t);
  var dismissed = 0;
  var handle = m.overlay.showOverlay({
    kind: "popover", content: "x", doc: m.doc, closeButton: true, closeLabel: "Close project access",
    onDismiss: function () { dismissed++; },
  });
  var closes = handle.el.querySelectorAll(".overlay-close");
  assert.equal(closes.length, 1, "one close control");
  assert.equal(closes[0].tagName, "BUTTON");
  assert.equal(closes[0].getAttribute("aria-label"), "Close project access");
  assert.equal(closes[0]._parent, handle.el, "the card's own child, at the card's corner");
  closes[0].click();
  assert.equal(handle.isOpen(), false, "using it closes the card");
  assert.equal(dismissed, 1);

  // Reopening a node that already carries the control does not add a second.
  var node = m.doc.createElement("div");
  m.overlay.showOverlay({ kind: "popover", el: node, doc: m.doc, closeButton: true });
  m.overlay.showOverlay({ kind: "popover", el: node, doc: m.doc, closeButton: true });
  assert.equal(node.querySelectorAll(".overlay-close").length, 1);
});

// The stylesheets of the B1 surfaces keep content styling only. Position, layer
// and card chrome come from overlay.css.
var B1_SHEETS = [
  { file: "menus.css", selectors: [".session-info-popover"] },
  { file: "icon-strip.css", selectors: [".project-ctx-menu", ".project-access-popover", ".emoji-picker"] },
  { file: "sidebar.css", selectors: [".session-ctx-menu"] },
  { file: "filebrowser.css", selectors: [".term-ctx-menu", ".terminal-tab-ctx"] },
  { file: "sticky-notes.css", selectors: [".sticky-note-color-picker"] },
  { file: "scheduler.css", selectors: [".schedule-popover"] },
  { file: "scheduler-modal.css", selectors: [".sched-custom-end-list"] },
  { file: "loop.css", selectors: [".loop-pending-popover"] },
];
var CHROME_PROPS = /^(position|z-index|top|left|right|bottom|background|background-color|border|border-radius|box-shadow)$/;

test("stylesheet: no B1 menu keeps its own position, layer or card chrome", function () {
  B1_SHEETS.forEach(function (sheet) {
    var rules = cssRules.rules(css(sheet.file));
    sheet.selectors.forEach(function (selector) {
      var hits = rules.filter(function (r) { return r.selector.split(",").map(function (s) { return s.trim(); }).indexOf(selector) !== -1; });
      assert.ok(hits.length > 0, sheet.file + ": " + selector + " still styles its content");
      hits.forEach(function (r) {
        var props = r.body.split(";").map(function (d) { return d.split(":")[0].trim(); }).filter(Boolean);
        assert.deepEqual(props.filter(function (p) { return CHROME_PROPS.test(p); }), [],
          sheet.file + ": " + selector + " must leave position, layer and chrome to overlay.css");
      });
    });
  });
});

test("stylesheet: the menu chrome is one rule shared with the cards, from tokens", function () {
  ["background", "border", "border-radius", "box-shadow"].forEach(function (prop) {
    assert.ok(cssRules.valueAt(OVERLAY, ".overlay-menu", prop, DESKTOP), ".overlay-menu has " + prop);
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-menu", prop, DESKTOP), cssRules.valueAt(OVERLAY, ".overlay", prop, DESKTOP),
      "a menu and a toast share " + prop);
  });
  assert.equal(cssRules.valueAt(OVERLAY, ".overlay-menu", "border-radius", DESKTOP), "var(--overlay-radius)");
});

// sticky-notes.js layers the notes themselves by an inline z-index; only its
// colour picker is a menu, so that module is checked for hand placement alone.
var B1_MODULES = [
  { file: "app-header.js", layer: true }, { file: "sidebar-projects.js", layer: true },
  { file: "sidebar-sessions.js", layer: true }, { file: "terminal.js", layer: true },
  { file: "sticky-notes.js", layer: false }, { file: "scheduler.js", layer: true },
  { file: "scheduler-config.js", layer: true }, { file: "app-loop-ui.js", layer: true },
];

test("modules: no B1 module sets a menu's z-index or places a menu by hand", function () {
  B1_MODULES.forEach(function (row) {
    var src = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", row.file), "utf8");
    if (row.layer) assert.ok(!/zIndex/.test(src), row.file + " must take its layer from the token");
    assert.ok(!/\bpositionPopover\b|\bpositionAtPoint\b/.test(src), row.file + " places menus through showOverlay, not directly");
  });
});

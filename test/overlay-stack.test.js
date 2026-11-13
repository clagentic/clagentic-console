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
  assert.throws(function () { overlay.showOverlay({ kind: "dialog", content: "z" }); }, /kind must be toast or banner/);
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
  // B2: the static and bespoke panels and popovers. An `inline` panel stays in
  // the column its container lays out: no anchor, so popover-position.js leaves it.
  { name: "usage panel", b2: true, kind: "popover", node: "page", inline: true, closeButton: true, at: {} },
  { name: "status panel", b2: true, kind: "popover", node: "page", inline: true, opener: true, closeButton: true, at: {} },
  { name: "diagnostics panel", b2: true, kind: "popover", node: "page", inline: true, opener: true, closeButton: true, at: {} },
  { name: "notification menu", b2: true, kind: "menu", node: "page", opener: true, place: { placement: "below-right-aligned", gap: 6 }, at: { left: "90px", top: "126px" } },
  { name: "update popover", b2: true, kind: "popover", node: "page", opener: true, place: { placement: "below-right-aligned", gap: 6 }, at: { left: "90px", top: "126px" } },
  { name: "extension popover", b2: true, kind: "popover", node: "page", opener: true, place: { placement: "below", gap: 8 }, at: { left: "100px", top: "128px" } },
  { name: "rate-limit popover", b2: true, passive: true, kind: "popover", node: "new", place: { placement: "below-center", gap: 8 }, at: { left: "95px", top: "128px" } },
  { name: "tool-palette menu", b2: true, kind: "menu", node: "new", point: { x: 300, y: 200 }, at: { left: "300px", top: "200px" } },
  { name: "profile popover", b2: true, kind: "popover", node: "built", opener: true, closeButton: true, place: { placement: "above", gap: 8 }, at: { left: "100px", top: "62px" } },
  { name: "speech-to-text language popover", b2: true, kind: "popover", node: "new", opener: true, place: { placement: "above", gap: 8 }, at: { left: "100px", top: "62px" } },
  { name: "scheduler create popover", b2: true, kind: "popover", node: "page", opener: true, closeButton: true, place: { placement: "right", gap: 8, margin: 10 }, at: { left: "148px", top: "100px" } },
  { name: "scheduler task list", b2: true, kind: "menu", node: "page", opener: true, place: { placement: "below", gap: 6 }, at: { left: "100px", top: "126px" } },
  { name: "scheduler colour palette", b2: true, kind: "menu", node: "page", opener: true, place: { placement: "below", gap: 6 }, at: { left: "100px", top: "126px" } },
];

function rowNamed(name) { return MENU_SURFACES.filter(function (s) { return s.name === name; })[0]; }

function openSurface(m, row) {
  // The control the surface hangs from, or is opened by; a point has none.
  var control = row.point ? null : anchorEl(m);
  var anchor = row.point || control;
  var opts = Object.assign({ kind: row.kind, doc: m.doc, id: row.id, closeButton: row.closeButton }, row.place);
  if (row.inline) opts.inline = true;
  else opts.anchor = anchor;
  if (row.passive) opts.passive = true;
  if (row.opener) opts.opener = control;
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
      { left: row.at.left, top: row.at.top, position: row.inline ? undefined : "fixed" },
      row.name + (row.inline ? ": left in its container's flow" : ": placed by popover-position.js"));
    assert.equal(el.classList.contains("overlay-menu-inline"), !!row.inline, row.name + ": the inline option is a class");
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
  // B2.
  // The three adopted info panels set their layer on their own node (the column
  // sits below modals); the stylesheet row above asserts it is the menu token.
  { file: "menus.css", selectors: ["#notif-menu", "#usage-panel", "#status-panel", "#diagnostics-panel"], ownLayer: ["#usage-panel", "#status-panel", "#diagnostics-panel"] },
  { file: "overlays.css", selectors: [".ext-popover", ".top-bar-popover"] },
  { file: "title-bar.css", selectors: [".rate-limit-popover"] },
  { file: "sidebar.css", selectors: [".tool-palette-ctx-menu"] },
  { file: "profile.css", selectors: [".profile-popover"] },
  { file: "stt.css", selectors: [".stt-lang-popover"] },
  { file: "scheduler-modal.css", selectors: [".sched-create-popover", ".sched-create-color-palette", ".sched-create-task-list"] },
];
var CHROME_PROPS = /^(position|z-index|top|left|right|bottom|background|background-color|border|border-radius|box-shadow)$/;

test("stylesheet: no B1 or B2 menu keeps its own position, layer or card chrome", function () {
  B1_SHEETS.forEach(function (sheet) {
    var rules = cssRules.rules(css(sheet.file));
    sheet.selectors.forEach(function (selector) {
      var hits = rules.filter(function (r) { return r.selector.split(",").map(function (s) { return s.trim(); }).indexOf(selector) !== -1; });
      assert.ok(hits.length > 0, sheet.file + ": " + selector + " still styles its content");
      hits.forEach(function (r) {
        var props = r.body.split(";").map(function (d) { return d.split(":")[0].trim(); }).filter(Boolean);
        var allowed = (sheet.ownLayer || []).indexOf(selector) !== -1 ? "z-index" : null;
        assert.deepEqual(props.filter(function (p) { return CHROME_PROPS.test(p) && p !== allowed; }), [],
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
  // B2. `clicks` and `keys` are the document listeners the module may still add:
  // none dismisses a menu (the registry does); tool-palette.js keeps the two of
  // its hotkey-pick mode.
  { file: "notifications.js", layer: true, clicks: 0, keys: 0 }, { file: "diagnostics.js", layer: true, clicks: 0, keys: 0 },
  { file: "app-panels.js", layer: true }, { file: "info-panel.js", layer: true, clicks: 0, keys: 0 },
  { file: "app-rate-limit.js", layer: true, clicks: 0, keys: 0 }, { file: "tool-palette.js", layer: true, clicks: 1, keys: 1 },
  { file: "profile.js", layer: true, clicks: 0, keys: 0 }, { file: "stt.js", layer: true, clicks: 0, keys: 0 },
];

test("modules: no B1 or B2 module sets a menu's z-index or places a menu by hand", function () {
  B1_MODULES.forEach(function (row) {
    var src = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", row.file), "utf8");
    if (row.layer) assert.ok(!/zIndex/.test(src), row.file + " must take its layer from the token");
    assert.ok(!/\bpositionPopover\b|\bpositionAtPoint\b/.test(src), row.file + " places menus through showOverlay, not directly");
    if (typeof row.clicks === "number") {
      var clicks = src.match(/document\.addEventListener\(\s*["']click["']/g) || [];
      var keys = src.match(/document\.addEventListener\(\s*["']keydown["']/g) || [];
      assert.equal(clicks.length, row.clicks, row.file + ": document click listeners (the registry closes menus on an outside click)");
      assert.equal(keys.length, row.keys, row.file + ": document keydown listeners (the registry closes menus on Escape)");
    }
  });
  // The scheduler's dropdowns and create popover have no listener of their own either.
  var sched = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "scheduler-config.js"), "utf8");
  assert.ok(!/document\.addEventListener\(\s*["'](click|keydown)["']/.test(sched), "scheduler-config.js: outside click and Escape are the registry's");
});

test("stylesheet: the info-panels column sits below modals, each adopted panel takes the menu layer; an inline panel adds no layer or float", function () {
  var MENUS = css("menus.css");
  // --z-base is below --z-modal (the layer-scale test above asserts the order).
  assert.equal(cssRules.valueAt(MENUS, "#info-panels", "z-index", DESKTOP), "var(--z-base)", "the column is below --z-modal");
  ["#usage-panel", "#status-panel", "#diagnostics-panel"].forEach(function (id) {
    assert.equal(cssRules.valueAt(MENUS, id, "z-index", DESKTOP), "var(--z-menu)", id + " takes the menu layer on its own node");
  });
  assert.notEqual(cssRules.valueAt(MENUS, "#context-panel", "z-index", DESKTOP), "var(--z-menu)", "the context panel is not a menu");
  assert.equal(cssRules.valueAt(OVERLAY, ".overlay-menu-inline", "position", DESKTOP), "relative");
  assert.equal(cssRules.valueAt(OVERLAY, ".overlay-menu-inline", "z-index", DESKTOP), "auto");
});

// ---------------------------------------------------------------------------
// B2: one open across both groups, Escape beside a toast, owned dropdowns
// ---------------------------------------------------------------------------

test("menu: B2 one open: a B2 pair and a B1 and B2 pair close each other, in both directions", async function (t) {
  var PAIRS = [
    { name: "B2 and B2", a: "notification menu", b: "profile popover" },
    { name: "B2 and B2, page node and built", a: "update popover", b: "tool-palette menu" },
    { name: "an info panel and an anchored B2 popover", a: "diagnostics panel", b: "extension popover" },
    { name: "B1 and B2", a: "session context menu", b: "scheduler create popover" },
    { name: "B1 page node and B2 inline panel", a: "schedule popover", b: "usage panel" },
  ];
  for (var i = 0; i < PAIRS.length; i++) {
    var pair = PAIRS[i];
    for (var d = 0; d < 2; d++) {
      var first = d === 0 ? pair.a : pair.b;
      var second = d === 0 ? pair.b : pair.a;
      t.mock.timers.reset();
      var m = await menuBrowser(t);
      var one = openSurface(m, rowNamed(first)).handle;
      var two = openSurface(m, rowNamed(second)).handle;
      assert.equal(gone(one), true, pair.name + ": " + first + " closed when " + second + " opened");
      assert.equal(two.isOpen(), true, pair.name + ": " + second + " is the open one");
      assert.equal(m.registry.getOpenMenu(), two.el, pair.name + ": the registry holds " + second);
      assert.equal(m.handlerCount("click"), 1, pair.name + ": one outside-click handler");
      assert.equal(m.handlerCount("keydown"), 1, pair.name + ": one Escape handler");
    }
  }
});

test("menu: a passive notice opens beside a menu the user has open and closes nothing; Escape takes the menu first", async function (t) {
  var ROWS = [
    { name: "B1 menu", open: "session context menu" },
    { name: "B2 menu", open: "notification menu" },
  ];
  for (var i = 0; i < ROWS.length; i++) {
    t.mock.timers.reset();
    var m = await menuBrowser(t);
    var menu = openSurface(m, rowNamed(ROWS[i].open)).handle;
    var notice = openSurface(m, rowNamed("rate-limit popover")).handle;
    assert.equal(menu.isOpen(), true, ROWS[i].name + ": the notice leaves the open menu open");
    assert.equal(notice.isOpen(), true, ROWS[i].name + ": the notice is shown");
    assert.equal(m.registry.getOpenMenu(), menu.el, ROWS[i].name + ": the registry still holds the menu");
    m.escape();
    assert.equal(gone(menu), true, ROWS[i].name + ": Escape closes the menu first");
    assert.equal(notice.isOpen(), true, ROWS[i].name + ": and leaves the notice");
    m.escape();
    assert.equal(gone(notice), true, ROWS[i].name + ": a second Escape closes the notice");
  }
});

test("menu: Escape closes each B2 surface and leaves a toast; with no menu open it leaves the toast too", async function (t) {
  var rows = MENU_SURFACES.filter(function (s) { return s.b2; });
  for (var i = 0; i < rows.length; i++) {
    t.mock.timers.reset();
    var m = await menuBrowser(t);
    m.b.utils.showToast("Saved", "error", "detail");
    var toast = m.b.stack().querySelector(".overlay-toast");
    var card = m.overlay.showOverlay({ kind: "toast", content: "x", dismissible: true });
    var handle = openSurface(m, rows[i]).handle;
    m.escape();
    assert.equal(gone(handle), true, rows[i].name + ": Escape closes it");
    assert.equal(toast.classList.contains("hide"), false, rows[i].name + ": the plain toast stays");
    assert.equal(card.el.classList.contains("hide"), false, rows[i].name + ": the dismissible toast stays");
    m.escape();
    assert.equal(card.el.classList.contains("hide"), false, rows[i].name + ": with no menu open Escape leaves the toast");
  }
});

test("menu: a dropdown a popover owns leaves the popover open; a click inside the popover closes the dropdown alone; Escape peels one at a time", async function (t) {
  var m = await menuBrowser(t);
  var pop = openSurface(m, rowNamed("scheduler create popover"));
  // The dropdown belongs to `owner` (the current popover unless one is given).
  var dropdown = function (owner) {
    return m.overlay.showOverlay({
      kind: "menu", el: sized(m.doc.createElement("div"), { width: 50, height: 30 }), retain: true,
      parent: (owner || pop.handle).el, anchor: anchorEl(m), doc: m.doc,
    });
  };

  var dd = dropdown();
  assert.equal(dd.isOpen() && pop.handle.isOpen(), true, "opening a dropdown leaves its popover open");
  assert.equal(m.registry.getOpenMenu(), dd.el, "the innermost menu is the dropdown");

  m.click(dd.el);
  assert.equal(dd.isOpen() && pop.handle.isOpen(), true, "a click inside the dropdown leaves both");
  m.click(pop.inside);
  assert.equal(dd.isOpen(), false, "a click inside the popover closes the dropdown");
  assert.equal(pop.handle.isOpen(), true, "and leaves the popover");

  dd = dropdown();
  m.escape();
  assert.equal(dd.isOpen(), false, "the first Escape closes the dropdown");
  assert.equal(pop.handle.isOpen(), true, "and leaves the popover");
  m.escape();
  assert.equal(pop.handle.isOpen(), false, "the second Escape closes the popover");

  pop = openSurface(m, rowNamed("scheduler create popover"));
  dd = dropdown();
  m.click(m.doc.body);
  assert.equal(dd.isOpen() || pop.handle.isOpen(), false, "a click outside closes both");

  pop = openSurface(m, rowNamed("scheduler create popover"));
  dd = dropdown();
  pop.handle.close();
  assert.equal(dd.isOpen(), false, "closing the popover closes the dropdown it owns");

  var other = openSurface(m, rowNamed("scheduler create popover"));
  dd = dropdown(other.handle);
  assert.equal(dd.isOpen() && other.handle.isOpen(), true, "the dropdown is open inside the popover it belongs to");
  var menu = openSurface(m, rowNamed("notification menu")).handle;
  assert.equal(dd.isOpen() || other.handle.isOpen(), false, "another menu opening closes the popover and its dropdown");
  assert.equal(menu.isOpen(), true, "and is the open one");

  // A named parent that is not open counts as no parent: the dropdown is
  // top-level and closes the other open menu (one-open).
  var closedParent = openSurface(m, rowNamed("scheduler create popover")).handle;
  closedParent.close();
  menu = openSurface(m, rowNamed("notification menu")).handle;
  dd = dropdown(closedParent);
  assert.equal(menu.isOpen(), false, "a dropdown whose parent is not open closes the open menu");
  assert.equal(dd.isOpen(), true, "and is open itself");
});

test("registry: a menu opened from a close hook stays open, whether the close came from closeMenu or Escape", async function (t) {
  var ROWS = [
    { name: "closeMenu", close: function (m, first) { first.close(); } },
    { name: "Escape", close: function (m) { m.escape(); } },
  ];
  for (var i = 0; i < ROWS.length; i++) {
    t.mock.timers.reset();
    var m = await menuBrowser(t);
    var opened = null;
    var first = m.overlay.showOverlay({
      kind: "popover", content: "x", doc: m.doc,
      onRemove: function () { opened = m.overlay.showOverlay({ kind: "popover", content: "y", doc: m.doc }); },
    });
    ROWS[i].close(m, first);
    assert.equal(first.isOpen(), false, ROWS[i].name + ": the first menu closed");
    assert.ok(opened && opened.isOpen(), ROWS[i].name + ": the menu its close hook opened is still open");
    assert.equal(m.registry.getOpenMenu(), opened.el, ROWS[i].name + ": the registry holds it");
  }
});

test("diagnostics panel: focus returns to its toggle on Escape or its close control, not when another menu opens or a click lands elsewhere", async function (t) {
  var b = await browser(t);
  var overlay = await import(dom.moduleUrl("overlay.js"));
  var registry = await import(dom.moduleUrl("overlay-registry.js"));
  // The page's document does not fire events by itself; collect the registry's.
  var listeners = {};
  global.document.addEventListener = function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); };
  var panel = new dom.FakeElement("div");
  panel.id = "diagnostics-panel";
  panel.className = "hidden";
  var list = new dom.FakeElement("div");
  list.id = "diagnostics-panel-list";
  var toggle = new dom.FakeElement("button");
  toggle.id = "diagnostics-panel-btn";
  var focused = 0;
  toggle.focus = function () { focused++; };
  [panel, list, toggle].forEach(function (el) { global.document.body.appendChild(el); });
  b.diagnostics.initDiagnostics();

  var ROWS = [
    { name: "Escape", restores: true, act: function () { listeners.keydown.forEach(function (fn) { fn({ key: "Escape" }); }); } },
    { name: "its close control", restores: true, act: function () { panel.querySelector(".overlay-close").click(); } },
    { name: "another menu opening", restores: false, act: function () { overlay.showOverlay({ kind: "popover", content: "x" }); } },
    { name: "a click on another control", restores: false, act: function () {
      listeners.click.forEach(function (fn) { fn({ target: global.document.body }); });
    } },
  ];
  ROWS.forEach(function (row) {
    registry.closeOpenMenu();
    toggle.click();
    assert.equal(registry.isMenuOpen(panel), true, row.name + ": the panel is open");
    focused = 0;
    row.act();
    assert.equal(registry.isMenuOpen(panel), false, row.name + ": the panel closed");
    assert.equal(focused, row.restores ? 1 : 0, row.name + (row.restores ? ": focus returns to the toggle" : ": focus is not moved to the toggle"));
  });
});

test("menu: Escape is offered to the innermost menu first, and true keeps it open", async function (t) {
  var m = await menuBrowser(t);
  var offered = 0;
  var handle = m.overlay.showOverlay({
    kind: "popover", content: "x", doc: m.doc,
    onEscape: function () { offered++; return offered === 1; },
  });
  m.escape();
  assert.equal(handle.isOpen(), true, "a spent Escape leaves it open");
  m.escape();
  assert.equal(handle.isOpen(), false, "the next Escape closes it");
  assert.equal(offered, 2);
});

test("profile popover: its close control is the shared one, and the module keeps no own close button", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "profile.js"), "utf8");
  assert.match(src, /closeButton:\s*true/, "the popover asks for the shared close control");
  assert.ok(!/profile-close-btn/.test(src) && !/profile-close-btn/.test(css("profile.css")), "no .profile-close-btn is left");
});

test("B2 close controls: the surfaces that showed their own now use the shared one", function () {
  var html = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "index.html"), "utf8");
  ["usage-panel-close", "status-panel-close", "diagnostics-panel-close", "sched-create-cancel"].forEach(function (id) {
    assert.ok(html.indexOf(id) === -1, id + " is gone from index.html");
  });
  var panels = ["usage panel", "status panel", "diagnostics panel", "scheduler create popover", "profile popover"];
  panels.forEach(function (name) { assert.equal(rowNamed(name).closeButton, true, name + " draws the shared close control"); });
});

// ---------------------------------------------------------------------------
// C1: modals and sheets. The confirm, paste and image modals, the project action
// sheet and the bottom-nav sheet all open through showOverlay as kind "modal" or
// "sheet". The rows below drive the real modules (app-modals.js,
// mobile-action-sheet.js, mobile-nav-sheet.js) over the fake DOM.
// ---------------------------------------------------------------------------

var MOBILE_NAV = css("mobile-nav.css");

// One browser whose document collects the registry's Escape listener, and a
// #mobile-sheet as index.html draws it (its own scrim and dialog, hidden).
async function modalBrowser(t) {
  t.mock.timers.reset();
  var b = await browser(t);
  var listeners = {};
  global.document.addEventListener = function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); };
  var registry = await import(dom.moduleUrl("overlay-registry.js"));
  // A modal a failed row left open belongs to no later row.
  while (registry.getTopModal()) registry.closeModal(registry.getTopModal(), { immediate: true });
  registry.closeOpenMenu();

  var sheet = new dom.FakeElement("div");
  sheet.id = "mobile-sheet";
  sheet.className = "hidden";
  var scrim = new dom.FakeElement("div");
  scrim.className = "overlay-modal-backdrop";
  var content = new dom.FakeElement("div");
  content.className = "mobile-sheet-content overlay-modal-dialog";
  sheet.appendChild(scrim);
  sheet.appendChild(content);
  global.document.body.appendChild(sheet);

  return {
    b: b, t: t, registry: registry, sheet: sheet, confirmed: 0, acted: 0,
    overlay: await import(dom.moduleUrl("overlay.js")),
    modals: await import(dom.moduleUrl("app-modals.js")),
    actionSheet: await import(dom.moduleUrl("mobile-action-sheet.js")),
    navSheet: await import(dom.moduleUrl("mobile-nav-sheet.js")),
    top: function () { return registry.getTopModal(); },
    escape: function () { (listeners.keydown || []).forEach(function (fn) { fn({ key: "Escape" }); }); },
    tick: function (ms) { t.mock.timers.tick(ms); },
  };
}

// Closed: not in the registry, and removed (built) or hidden (the page's own node).
function modalGone(m, el, adopted) {
  return !m.registry.isModalOpen(el) && (adopted ? el.classList.contains("hidden") : el.parentNode === null);
}

// Each C1 surface, opened through its own module.
var MODAL_SURFACES = [
  { name: "confirm", kind: "modal", open: function (m) { m.modals.showConfirm("Delete it?", function () { m.confirmed++; }); } },
  { name: "paste", kind: "modal", open: function (m) { m.modals.showPasteModal("pasted text"); } },
  { name: "image", kind: "modal", card: false, open: function (m) { m.modals.showImageModal("pic.png"); } },
  { name: "action sheet", kind: "sheet", open: function (m) {
    m.actionSheet.showActionSheet({ actions: [{ icon: "settings", label: "Project Settings", handler: function () { m.acted++; } }] });
  } },
  { name: "nav sheet", kind: "sheet", adopted: true, nav: true, open: function (m) { m.navSheet.showNavSheet("projects"); } },
];

test("modal: each C1 surface opens as the shared modal or sheet, with the shared top-right close control", async function (t) {
  for (var i = 0; i < MODAL_SURFACES.length; i++) {
    var row = MODAL_SURFACES[i];
    var m = await modalBrowser(t);
    row.open(m);
    var el = m.top();
    assert.ok(el, row.name + ": open in the registry");
    assert.ok(el.classList.contains("overlay-modal"), row.name + ": the shared modal");
    assert.equal(el.classList.contains("overlay-sheet"), row.kind === "sheet", row.name + ": a sheet is an option");
    assert.equal(el.classList.contains("overlay-nav-sheet"), !!row.nav, row.name + ": the nav rule is an option");
    assert.equal(el.getAttribute("data-overlay-kind"), row.kind, row.name + ": the kind is an attribute");
    assert.equal(el.classList.contains("hidden"), false, row.name + ": shown");
    var dialog = el.querySelector(".overlay-modal-dialog");
    assert.ok(dialog && el.querySelector(".overlay-modal-backdrop"), row.name + ": the shared scrim and dialog");
    assert.equal(dialog.classList.contains("overlay-modal-bare"), row.card === false, row.name + ": the card is an option");
    var closes = el.querySelectorAll(".overlay-close");
    assert.equal(closes.length, 1, row.name + ": one close control");
    assert.equal(closes[0].tagName, "BUTTON", row.name + ": a button");
    assert.ok(closes[0].getAttribute("aria-label"), row.name + ": named for assistive tech");
    assert.equal(closes[0]._parent, dialog, row.name + ": the dialog's own child, at its corner");
    assert.equal(el.querySelectorAll(".confirm-backdrop, .confirm-dialog, .paste-modal-close, .image-modal-close, .mobile-sheet-close, .mobile-sheet-backdrop").length, 0,
      row.name + ": no surface-owned scrim, card or close control");
  }
});

var DISMISS_WAYS = [
  { name: "Escape", act: function (m) { m.escape(); } },
  { name: "a click on the scrim", act: function (m, el) { el.querySelector(".overlay-modal-backdrop").click(); } },
  { name: "the close control", act: function (m, el) { el.querySelector(".overlay-close").click(); } },
];

test("modal: Escape, the scrim and the close control each close every C1 surface and run no action", async function (t) {
  for (var i = 0; i < MODAL_SURFACES.length; i++) {
    for (var w = 0; w < DISMISS_WAYS.length; w++) {
      var row = MODAL_SURFACES[i];
      var m = await modalBrowser(t);
      row.open(m);
      var el = m.top();
      DISMISS_WAYS[w].act(m, el);
      m.tick(300);
      assert.equal(modalGone(m, el, row.adopted), true, row.name + ": closed by " + DISMISS_WAYS[w].name);
      assert.equal(m.confirmed + m.acted, 0, row.name + ": " + DISMISS_WAYS[w].name + " is a cancel: nothing ran");
    }
  }
});

test("modal: a modal that cannot be dismissed has no close control and neither Escape nor the scrim closes it", async function (t) {
  var m = await modalBrowser(t);
  var handle = m.overlay.showOverlay({ kind: "modal", content: "x", dismissible: false });
  assert.equal(handle.el.querySelectorAll(".overlay-close").length, 0);
  m.escape();
  handle.el.querySelector(".overlay-modal-backdrop").click();
  assert.equal(handle.isOpen(), true);
  handle.close();
  assert.equal(handle.isOpen(), false, "the surface itself can still close it");
});

// What each way out of the confirm does with the caller's callback.
var CONFIRM_WAYS = [
  { name: "OK", act: function (m, el) { el.querySelector(".confirm-delete").click(); }, runs: 1 },
  { name: "Cancel", act: function (m, el) { el.querySelector(".confirm-cancel").click(); }, runs: 0 },
  { name: "Escape", act: function (m) { m.escape(); }, runs: 0 },
  { name: "the scrim", act: function (m, el) { el.querySelector(".overlay-modal-backdrop").click(); }, runs: 0 },
  { name: "the close control", act: function (m, el) { el.querySelector(".overlay-close").click(); }, runs: 0 },
];

test("confirm: only OK runs the callback, once, after the modal has closed; the rest cancel", async function (t) {
  for (var i = 0; i < CONFIRM_WAYS.length; i++) {
    var m = await modalBrowser(t);
    var wasOpenInCallback = null;
    var el = null;
    m.modals.showConfirm("Sure?", function () { m.confirmed++; wasOpenInCallback = m.registry.isModalOpen(el); });
    el = m.top();
    CONFIRM_WAYS[i].act(m, el);
    assert.equal(m.confirmed, CONFIRM_WAYS[i].runs, CONFIRM_WAYS[i].name + ": callback runs");
    assert.equal(m.registry.isModalOpen(el), false, CONFIRM_WAYS[i].name + ": closed");
    if (CONFIRM_WAYS[i].runs) assert.equal(wasOpenInCallback, false, "the callback runs after the modal closed");
  }
});

test("confirm: labels, the plain-text message, the destructive option, replacement, and a confirmation opened by a confirmation", async function (t) {
  var m = await modalBrowser(t);
  m.modals.showConfirm("<b>Delete</b> it?", function () {});
  var el = m.top();
  assert.equal(el.querySelector(".confirm-text").textContent, "<b>Delete</b> it?", "the message is text, never markup");
  assert.equal(el.querySelector(".confirm-text")._children.length, 0);
  assert.equal(el.querySelector(".confirm-delete").textContent, "Delete", "the default label");

  m.modals.showConfirm("Stop it?", function () {}, "Stop", false);
  assert.equal(m.registry.isModalOpen(el), false, "a second confirmation replaces the first");
  var second = m.top();
  assert.equal(second.querySelector(".confirm-ok").textContent, "Stop", "a plain accent button with its own label");
  assert.equal(second.querySelectorAll(".confirm-delete").length, 0);
  assert.equal(global.document.body.querySelectorAll(".overlay-modal").filter(function (n) { return n.getAttribute("data-overlay-kind") === "modal"; }).length, 1, "one confirmation in the page");

  var chained = null;
  m.modals.showConfirm("First?", function () { m.modals.showConfirm("Second?", function () {}); });
  m.top().querySelector(".confirm-delete").click();
  chained = m.top();
  assert.equal(chained.querySelector(".confirm-text").textContent, "Second?", "the confirmation its callback opened stays open");
});

test("modal: paste shows the text as text and offers Copy; the image shows the picture with no card", async function (t) {
  var m = await modalBrowser(t);
  m.modals.showPasteModal("<i>raw</i>");
  var paste = m.top();
  assert.equal(paste.querySelector(".paste-modal-body").textContent, "<i>raw</i>");
  assert.equal(paste.querySelectorAll(".paste-modal-copy").length, 1, "Copy stays");
  assert.ok(paste.querySelector(".overlay-modal-dialog").classList.contains("paste-modal-dialog"));
  m.modals.showImageModal("pic.png");
  var image = m.top();
  assert.equal(image.querySelector(".image-modal-img").getAttribute("src"), "pic.png");
  assert.ok(image.classList.contains("overlay-scrim-dark"), "the lightbox scrim is the dark option");
  assert.equal(m.registry.isModalOpen(paste), true, "an image opened over a paste leaves it open beneath");
});

test("action sheet: a row closes the sheet and then runs its action; Cancel only closes", async function (t) {
  var m = await modalBrowser(t);
  var seen = [];
  var open = function () {
    m.actionSheet.showActionSheet({ actions: [
      { icon: "settings", label: "<b>Settings</b>", handler: function () { seen.push(m.registry.isModalOpen(el)); } },
      { icon: "smile", label: "Set Icon", handler: function () {} },
    ] });
    return m.top();
  };
  var el = open();
  var rows = el.querySelectorAll(".mobile-action-sheet-item");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector("span").textContent, "<b>Settings</b>", "a label is text");
  rows[0].click();
  assert.deepEqual(seen, [false], "the action runs after the sheet closed");
  assert.equal(m.registry.isModalOpen(el), false);

  el = open();
  el.querySelector(".mobile-action-sheet-cancel").click();
  assert.equal(m.registry.isModalOpen(el), false, "Cancel closes it");
  assert.deepEqual(seen, [false], "and ran nothing");
});

// ---------------------------------------------------------------------------
// C1 stacking: layers from tokens, a later modal over an earlier one
// ---------------------------------------------------------------------------

function layer(name) { return Number(new RegExp("--z-" + name + ":\\s*(\\d+)").exec(BASE)[1]); }

test("stacking css: a modal sits under the toast stack and the menus, over the nav, at each width", function () {
  WIDTHS.forEach(function (width) {
    var at = "at " + width + "px";
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-modal", "z-index", width), "calc(var(--z-modal) + var(--overlay-order, 0))", "the modal layer plus its place in the order " + at);
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-stack", "z-index", width), "var(--z-toast)", "toasts " + at);
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-menu", "z-index", width), "var(--z-menu)", "menus " + at);
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-modal", "position", width), "fixed", "the modal covers the viewport " + at);
  });
  assert.ok(layer("nav") < layer("modal"), "the nav is under every modal");
  // The order is a count of open modals; any plausible count stays under the next layer.
  assert.ok(layer("modal") + 99 < layer("menu"), "the first 100 open modals stay under the menu layer");
  assert.ok(layer("menu") < layer("toast"));
});

test("stacking: a later modal sits over an earlier one, wherever its node lives; Escape closes the top first; a toast and a menu stay beside it", async function (t) {
  var m = await modalBrowser(t);
  var order = function (el) { return Number(el.style["--overlay-order"]); };

  m.navSheet.showNavSheet("projects");
  var sheet = m.sheet;
  m.modals.showConfirm("Sure?", function () {});
  var confirm = m.top();
  assert.ok(order(confirm) > order(sheet), "a confirmation opened over the nav sheet sits over it");
  m.modals.showPasteModal("x");
  var paste = m.top();
  assert.ok(order(paste) > order(confirm), "a third sits over the second");

  m.b.utils.showToast("Saved", "error", "detail");
  var toast = m.b.stack().querySelector(".overlay-toast");
  m.escape();
  assert.equal(m.registry.isModalOpen(paste), false, "Escape closed the top modal");
  assert.equal(m.registry.isModalOpen(confirm) && m.registry.isModalOpen(sheet), true, "and left the others");
  assert.equal(toast.classList.contains("hide"), false, "and the toast");

  var menu = m.overlay.showOverlay({ kind: "menu", content: "m" });
  m.escape();
  assert.equal(menu.isOpen(), false, "a menu opened over a modal closes first");
  assert.equal(m.registry.isModalOpen(confirm), true, "and the modal stays");
  m.escape();
  assert.equal(m.registry.isModalOpen(confirm), false);
  assert.equal(order(sheet), 0, "the nav sheet is the only modal left, at the bottom of the order");
  m.escape();
  m.tick(300);
  assert.equal(modalGone(m, sheet, true), true, "the last Escape closes the nav sheet");
});

// ---------------------------------------------------------------------------
// C1 nav sheets: the bottom nav stays in view; the same button closes, another switches
// ---------------------------------------------------------------------------

var NAV_TABS = ["projects", "chat", "team", "more"];

test("nav sheet css: at phone width the sheet stops above the nav, which stays on its own layer under it", function () {
  assert.equal(cssRules.valueAt(OVERLAY, ".overlay-nav-sheet", "bottom", PHONE), "var(--mobile-nav-height)", "the sheet ends where the nav begins");
  assert.equal(cssRules.valueAt(MOBILE_NAV, "#mobile-tab-bar", "height", PHONE), "var(--mobile-nav-height)", "the nav is that tall");
  assert.equal(cssRules.valueAt(MOBILE_NAV, "#mobile-tab-bar", "z-index", PHONE), "var(--z-nav)");
  assert.equal(cssRules.valueAt(MOBILE_NAV, "#mobile-tab-bar", "position", PHONE), "fixed");
  assert.equal(cssRules.valueAt(MOBILE_NAV, "#mobile-tab-bar", "bottom", PHONE), "0", "the nav sits on the bottom edge the sheet clears");
  assert.equal(cssRules.valueAt(MOBILE_NAV, "#mobile-sheet", "display", DESKTOP), "none", "no nav sheet on a wide viewport");
  assert.equal(cssRules.valueAt(MOBILE_NAV, "#mobile-sheet", "display", PHONE), "flex");
  assert.match(BASE, /--mobile-nav-height:\s*calc\(56px \+ var\(--safe-bottom\)\)/);
  ["position", "z-index", "inset", "background"].forEach(function (prop) {
    assert.equal(cssRules.valueAt(MOBILE_NAV, "#mobile-sheet", prop, PHONE), null, "#mobile-sheet keeps no own " + prop);
    assert.equal(cssRules.valueAt(MOBILE_NAV, ".mobile-sheet-content", prop, PHONE), null, ".mobile-sheet-content keeps no own " + prop);
  });
});

test("nav sheet: the same nav button closes the sheet, another switches it, the close control, Escape and a quick second tap behave", async function (t) {
  var m = await modalBrowser(t);
  var bar = new dom.FakeElement("div");
  bar.id = "mobile-tab-bar";
  var tabs = NAV_TABS.map(function (name) {
    var tab = new dom.FakeElement("button");
    tab.dataset.tab = name;
    bar.appendChild(tab);
    return tab;
  });
  global.document.body.appendChild(bar);
  var opened = [];
  m.navSheet.wireNavTabs(tabs, {
    open: function (type, name) { opened.push(name); m.navSheet.showNavSheet(type); },
    close: function () { m.navSheet.closeNavSheet(); },
  });
  var tab = function (name) { return tabs[NAV_TABS.indexOf(name)]; };
  var sheetOpen = function () { return m.registry.isModalOpen(m.sheet) && !m.sheet.classList.contains("hidden") && !m.sheet.classList.contains("closing"); };
  var nowShowing = function () { return m.navSheet.navSheetType(); };

  var STEPS = [
    { name: "a nav button opens its sheet", act: function () { tab("projects").click(); }, shows: "projects" },
    { name: "the same button closes it", act: function () { tab("projects").click(); m.tick(300); }, shows: null },
    { name: "a nav button opens Chat", act: function () { tab("chat").click(); }, shows: "sessions" },
    { name: "another button switches to its sheet, which stays open", act: function () { tab("team").click(); }, shows: "team" },
    { name: "and another", act: function () { tab("more").click(); }, shows: "more" },
    { name: "the sheet the Files list opens (a More entry) is switched away from by any nav button", act: function () { m.navSheet.showNavSheet("files"); tab("more").click(); }, shows: "more" },
    { name: "the close control closes it", act: function () { m.sheet.querySelector(".overlay-close").click(); m.tick(300); }, shows: null },
    { name: "a closed sheet opens again from any button", act: function () { tab("team").click(); }, shows: "team" },
    { name: "Escape closes it", act: function () { m.escape(); m.tick(300); }, shows: null },
    { name: "a second tap while it slides down opens it again", act: function () { tab("chat").click(); tab("chat").click(); tab("chat").click(); m.tick(300); }, shows: "sessions" },
    { name: "the scrim closes it", act: function () { m.sheet.querySelector(".overlay-modal-backdrop").click(); m.tick(300); }, shows: null },
  ];
  STEPS.forEach(function (step) {
    step.act();
    assert.equal(nowShowing(), step.shows, step.name + ": what the sheet shows");
    assert.equal(sheetOpen(), step.shows !== null, step.name + ": " + (step.shows ? "open and not sliding away" : "closed"));
    assert.equal(bar.classList.contains("hidden") || bar.contains(m.sheet) || m.sheet.contains(bar), false, step.name + ": the nav is neither hidden nor inside the sheet");
  });
  assert.deepEqual(opened, ["projects", "chat", "team", "more", "more", "team", "chat", "chat"], "each tap that did not close the sheet opened its own");

  // A button that opens no nav sheet (the middle button's full-screen view).
  assert.equal(m.navSheet.navTabAction("home"), null);
  assert.deepEqual(m.navSheet.navTabAction("projects"), { action: "open", type: "projects" });
});

test("nav sheet: sidebar-mobile.js routes every nav button, its close and its action sheet through the shared modules", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "sidebar-mobile.js"), "utf8");
  assert.match(src, /wireNavTabs\(mobileTabs,/, "the nav buttons use the one rule");
  assert.match(src, /showNavSheet\(type,/, "every sheet type opens through it");
  assert.match(src, /showActionSheet\(\{ actions: actions \}\)/, "the project actions use the shared sheet");
  assert.doesNotMatch(src, /mobile-action-sheet-overlay|mobile-sheet-close|mobile-sheet-backdrop/, "no surface-owned scrim or close control");
  assert.doesNotMatch(src, /mobile-sheet"\)[^;]*classList\.add\("hidden"\)|sheet\.classList\.add\("hidden"\)/, "nothing hides the sheet by hand");
  assert.match(src, /mobileHomeBtn\.addEventListener\("click", function \(\) \{\s*\/\/[^\n]*\n\s*closeMobileSheet\(\);/, "the middle button closes an open nav sheet before its full-screen view");
});

// ---------------------------------------------------------------------------
// C1 guard: no overlay-band literal z-index in the files C1 touches
// ---------------------------------------------------------------------------

// A z-index from 100 up is an overlay layer and comes from the scale in base.css;
// -1 to 99 is local stacking inside a component and stays a literal. What is left
// below belongs to surfaces C1 and C2 did not move: the panels, menus and other
// layers (C3). That task removes its rows; the guard fails on a new literal and on
// a row whose literal is gone. The files the C2 modals lived in are listed with no
// rows left.
// TODO(lr-5ebc02): the other rows go with the repo-wide sweep.
var OVERLAY_BAND_MIN = 100;
var UNMOVED_LITERALS = {
  "overlays.css": ["#connect-overlay|999"],
  "messages.css": [".remote-cursor|9999", "#todo-sticky .todo-sticky-items|200"],
  "input.css": ["#context-sources-picker|200", "#sidebar|1000", "#sidebar-overlay|999"],
  "mobile-nav.css": [], "overlay.css": [], "base.css": [],
  "admin.css": [], "profile.css": [], "skills.css": [],
};
var UNMOVED_JS_LITERALS = {};
var C1_MODULES = ["overlay.js", "overlay-modal.js", "overlay-registry.js", "app-modals.js", "mobile-nav-sheet.js", "mobile-action-sheet.js", "sidebar-mobile.js", "app-misc.js"];
var C2_MODULES = [
  "admin.js", "sidebar-projects.js", "app-projects.js", "app-loop-ui.js", "qrcode.js", "profile.js", "notifications.js", "rewind.js",
  "sidebar-sessions.js", "app-skills-install.js", "session-grants.js", "skills.js", "mcp-ui.js", "markdown.js", "input.js", "context-sources.js",
];

test("guard: the files C1 touches hold no overlay-band literal z-index but the named unmoved ones", function () {
  Object.keys(UNMOVED_LITERALS).forEach(function (file) {
    var found = [];
    cssRules.rules(css(file)).forEach(function (r) {
      var m = /(?:^|[;\s])z-index\s*:\s*(-?\d+)\s*(?:;|$)/.exec(r.body);
      if (m && Number(m[1]) >= OVERLAY_BAND_MIN) found.push(r.selector + "|" + m[1]);
    });
    assert.deepEqual(found.sort(), UNMOVED_LITERALS[file].slice().sort(), file + ": overlay-band literal z-index values");
  });
  C1_MODULES.concat(C2_MODULES).forEach(function (file) {
    var src = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", file), "utf8");
    var hits = src.match(/z-index\s*:\s*\d{3,}|zIndex\s*=\s*["']?\d{3,}/g) || [];
    assert.equal(hits.length, UNMOVED_JS_LITERALS[file] || 0, file + ": overlay-band literal z-index in script");
  });
  // The moved surfaces' own scrim, card and close rules are gone from their stylesheets.
  var html = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "index.html"), "utf8");
  ["paste-modal", "image-modal", "confirm-modal", "mobile-sheet-backdrop", "mobile-sheet-close"].forEach(function (name) {
    assert.ok(html.indexOf(name) === -1, name + " is gone from index.html");
  });
  var sheets = ["overlays.css", "input.css", "messages.css", "mobile-nav.css"].map(css).join("\n");
  [/#confirm-modal/, /#paste-modal\b/, /#image-modal\b/, /\.image-modal-close/, /\.paste-modal-close/, /\.mobile-action-sheet-overlay/, /\.mobile-sheet-backdrop/, /\.mobile-sheet-close/]
    .forEach(function (re) { assert.doesNotMatch(sheets, re, String(re) + " is gone from the stylesheets"); });
});

// ---------------------------------------------------------------------------
// C2: the remaining modals and the input more-sheet
// ---------------------------------------------------------------------------

var PUBLIC_DIR = path.join(__dirname, "..", "lib", "public");
function publicFile(rel) { return fs.readFileSync(path.join(PUBLIC_DIR, rel), "utf8"); }
var INDEX_HTML = publicFile("index.html");

// A static modal as index.html draws it: the page's own node, hidden, with the
// shared scrim and dialog in it.
function staticModal(id, dialogClass) {
  var root = new dom.FakeElement("div");
  root.id = id;
  root.className = "hidden";
  var scrim = new dom.FakeElement("div");
  scrim.className = "overlay-modal-backdrop";
  var dialog = new dom.FakeElement("div");
  dialog.className = "overlay-modal-dialog " + dialogClass;
  root.appendChild(scrim);
  root.appendChild(dialog);
  global.document.body.appendChild(root);
  return { root: root, dialog: dialog };
}

// Real modules that can be imported under node:test, each opened as the page does.
// A JS-built one draws its own node; a static one adopts the page's.
var C2_RUNTIME = [
  { name: "session grants (JS-built)", adopted: false, dialogClass: "session-grants-dialog",
    open: async function (m) {
      var mod = await import(dom.moduleUrl("session-grants.js"));
      mod.openSessionGrants(7);
    } },
  { name: "skills (static)", adopted: true, dialogClass: "skills-dialog",
    open: async function (m) {
      var skills = await import(dom.moduleUrl("skills.js"));
      var page = staticModal("skills-modal", "skills-dialog");
      var content = new dom.FakeElement("div");
      content.id = "skills-content";
      page.dialog.appendChild(content);
      var btn = new dom.FakeElement("button");
      btn.id = "skills-btn";
      global.document.body.appendChild(btn);
      global.fetch = function () { return Promise.reject(new Error("offline")); };
      skills.initSkills();
      btn.click();
    } },
];

test("C2 modal: a real JS-built module and a real static modal open as the shared modal with the shared top-right close, and Escape, the scrim and the close control close each", async function (t) {
  for (var i = 0; i < C2_RUNTIME.length; i++) {
    var row = C2_RUNTIME[i];
    for (var w = 0; w < DISMISS_WAYS.length; w++) {
      var m = await modalBrowser(t);
      await row.open(m);
      var el = m.top();
      assert.ok(el, row.name + ": open in the registry");
      assert.ok(el.classList.contains("overlay-modal"), row.name + ": the shared modal");
      assert.equal(el.getAttribute("data-overlay-kind"), "modal", row.name + ": a modal, not a sheet");
      assert.equal(el.classList.contains("hidden"), false, row.name + ": shown");
      var dialog = el.querySelector(".overlay-modal-dialog");
      assert.ok(dialog && el.querySelector(".overlay-modal-backdrop"), row.name + ": the shared scrim and dialog");
      assert.ok(dialog.classList.contains(row.dialogClass), row.name + ": the surface's own class only sizes and fills the dialog");
      var closes = el.querySelectorAll(".overlay-close");
      assert.equal(closes.length, 1, row.name + ": one close control");
      assert.equal(closes[0]._parent, dialog, row.name + ": the dialog's own child, at its corner");
      assert.equal(el.querySelectorAll(".confirm-backdrop, .confirm-dialog, .skills-close").length, 0, row.name + ": no surface-owned scrim, card or close control");
      DISMISS_WAYS[w].act(m, el);
      m.tick(300);
      assert.equal(modalGone(m, el, row.adopted), true, row.name + ": closed by " + DISMISS_WAYS[w].name);
      if (row.adopted) assert.equal(el.parentNode, global.document.body, row.name + ": the page's node stays where it was");
    }
  }
});

test("C2 modal: the session grants list is replaced by a second open and redrawn for its own session only", async function (t) {
  var m = await modalBrowser(t);
  var mod = await import(dom.moduleUrl("session-grants.js"));
  mod.openSessionGrants(7);
  var first = m.top();
  assert.equal(first.getAttribute("data-session-id"), "7");
  mod.openSessionGrants(8);
  var second = m.top();
  assert.equal(m.registry.isModalOpen(first), false, "a second open replaces the first");
  assert.equal(global.document.body.querySelectorAll(".session-grants-dialog").length, 1, "one list in the page");
  mod.handleSessionGrants({ sessionId: 7, grants: [{ key: "a", text: "A", wholeTool: false }] });
  assert.equal(second.querySelectorAll(".session-grants-row").length, 0, "a list for another session does not redraw it");
  mod.handleSessionGrants({ sessionId: 8, grants: [{ key: "a", text: "A", wholeTool: false }] });
  assert.equal(second.querySelectorAll(".session-grants-row").length, 1);
  second.querySelector(".confirm-cancel").click();
  assert.equal(m.registry.isModalOpen(second), false, "its Close button closes it");
});

test("C2 modal: a modal that spends Escape on something inside stays open; the next Escape closes it", async function (t) {
  var m = await modalBrowser(t);
  var spent = 0;
  var handle = m.overlay.showOverlay({ kind: "modal", content: "x", onEscape: function () { spent++; return spent === 1; } });
  m.escape();
  assert.equal(handle.isOpen(), true, "the detail view stepped back and the modal stayed");
  m.escape();
  assert.equal(handle.isOpen(), false);
  assert.equal(spent, 2);
});

test("C2 stacking: two C2 modals sit in token order, Escape closes the top one first, and a toast and a menu stay readable over them", async function (t) {
  var m = await modalBrowser(t);
  var order = function (el) { return Number(el.style["--overlay-order"]); };
  var mod = await import(dom.moduleUrl("session-grants.js"));
  mod.openSessionGrants(7);
  var grants = m.top();
  var skills = staticModal("skills-modal", "skills-dialog");
  m.overlay.showOverlay({ kind: "modal", el: skills.root });
  assert.ok(order(skills.root) > order(grants), "a second C2 modal sits over the first");
  m.b.utils.showToast("Saved", "error", "detail");
  var toast = m.b.stack().querySelector(".overlay-toast");
  m.escape();
  assert.equal(m.registry.isModalOpen(skills.root), false, "Escape closed the top modal");
  assert.equal(m.registry.isModalOpen(grants), true, "and left the one beneath");
  assert.equal(toast.classList.contains("hide"), false, "and the toast");
  WIDTHS.forEach(function (width) {
    var at = " at " + width + "px";
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-modal", "z-index", width), "calc(var(--z-modal) + var(--overlay-order, 0))", "both modals share the one modal layer" + at);
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-stack", "z-index", width), "var(--z-toast)", "a toast is above them" + at);
  });
  assert.ok(layer("panel") < layer("modal"), "a dialog a settings panel opens shows over the panel");
});

// Each moved surface's own dialog rule sizes and fills it; it keeps no scrim, card
// chrome, position or layer, at either width.
var C2_DIALOG_RULES = [
  [".admin-modal", "admin.css"], [".wt-modal", "icon-strip.css"], [".remove-project-task-dialog", "overlays.css"],
  [".loop-status-dialog", "loop.css"], [".mermaid-modal-dialog", "messages.css"], [".skills-dialog", "skills.css"],
  [".mcp-dialog", "filebrowser.css"], [".session-grants-dialog", "overlays.css"], [".skill-install-dialog", "overlays.css"],
  [".rewind-dialog", "overlays.css"], [".resume-picker-dialog", "overlays.css"], [".notif-help-dialog", "overlays.css"],
  [".add-project-dialog", "overlays.css"], [".pwa-modal-card", "overlays.css"], ["#qr-overlay-inner", "menus.css"],
  [".avatar-positioner-container", "profile.css"], [".input-more-content", "input.css"], [".fcp-card", "overlays.css"],
];
// Rules the moved surfaces used to carry for their own scrim, card or close control.
var C2_GONE_SELECTORS = [
  "#skills-modal", "#mcp-modal", "#mermaid-modal", "#resume-modal", "#rewind-modal", "#notif-help-modal", "#add-project-modal",
  "#skill-install-modal", "#session-grants-modal", "#qr-overlay", ".pwa-modal", ".pwa-modal-backdrop", ".wt-modal-overlay",
  ".admin-modal-overlay", ".admin-modal-close", ".loop-status-modal", ".loop-status-backdrop", ".loop-status-dialog-close",
  ".remove-project-task-modal", ".remove-project-task-backdrop", ".avatar-positioner-overlay", ".avatar-positioner-close",
  "#input-more-sheet", ".input-more-backdrop", ".confirm-dialog", ".skills-close", "#mermaid-modal .confirm-backdrop",
];

test("C2 css: no moved dialog keeps its own scrim, card chrome, position or layer, and no rule for a removed scrim or close control is left", function () {
  WIDTHS.forEach(function (width) {
    C2_DIALOG_RULES.forEach(function (row) {
      ["position", "z-index", "background", "box-shadow", "inset"].forEach(function (prop) {
        var own = cssRules.valueAt(css(row[1]), row[0], prop, width);
        assert.equal(own, null, row[0] + " keeps no own " + prop + " at " + width + "px");
      });
    });
  });
  var all = fs.readdirSync(CSS_DIR).filter(function (f) { return /\.css$/.test(f); });
  all.forEach(function (file) {
    cssRules.rules(css(file)).forEach(function (r) {
      r.selector.split(",").map(function (s) { return s.trim(); }).forEach(function (sel) {
        assert.equal(C2_GONE_SELECTORS.indexOf(sel), -1, file + ": " + sel + " is gone");
      });
    });
  });
  assert.equal(cssRules.valueAt(OVERLAY, ".overlay-scrim-solid .overlay-modal-backdrop", "background", DESKTOP), "var(--bg)", "the solid scrim is an option of the shared modal");
  assert.equal(cssRules.valueAt(css("user-settings.css"), "#user-settings", "z-index", DESKTOP), "var(--z-panel)");
  assert.equal(cssRules.valueAt(css("server-settings.css"), "#server-settings", "z-index", DESKTOP), "var(--z-panel)");
});

// The page's static modals: the shared scrim and dialog, no close control of their own.
var C2_STATIC_IDS = ["mermaid-modal", "notif-help-modal", "resume-modal", "rewind-modal", "skill-install-modal", "add-project-modal", "skills-modal", "mcp-modal", "pwa-install-modal", "qr-overlay", "input-more-sheet"];

test("C2 html: every static modal is the shared scrim and dialog, with no scrim, card or close control of its own", function () {
  C2_STATIC_IDS.forEach(function (id) {
    var re = new RegExp('id="' + id + '"[^>]*>\\s*<div class="overlay-modal-backdrop"></div>\\s*<div [^>]*class="[^"]*overlay-modal-dialog');
    assert.match(INDEX_HTML, re, id + " is the shared scrim and dialog");
  });
  assert.doesNotMatch(INDEX_HTML, /confirm-dialog|skills-close|pwa-modal-backdrop|input-more-backdrop|mermaid-modal-btn" title="Close"/, "no own card or close control is left in the page");
  assert.doesNotMatch(INDEX_HTML, /id="notif-help-modal"[\s\S]{0,200}style="/, "the notification help dialog keeps no inline style");
});

// Surfaces whose module cannot be imported under node:test (module-private builders,
// or a page node the module reads at start): pinned by source. Each opens through
// showOverlay as a modal or sheet, and no longer builds a scrim, a card or its own
// close and Escape handling.
var C2_SOURCE_ROWS = [
  { name: "admin dialogs", file: "admin.js", has: [/showOverlay\(\{ kind: "modal", content: html, dialogClass: "admin-modal" \}\)/], gone: [/admin-modal-overlay|admin-modal-close|e\.target === modal/] },
  { name: "worktree modal", file: "sidebar-projects.js", has: [/kind: "modal",\s*id: "wt-modal-container",\s*dialogClass: "wt-modal"/], gone: [/wt-modal-overlay|e\.key === "Escape"\) closeModal/] },
  { name: "remove-project-task dialog", file: "app-projects.js", has: [/kind: "modal", dialogClass: "remove-project-task-dialog"/], gone: [/remove-project-task-backdrop|remove-project-task-modal/] },
  { name: "add-project modal", file: "app-projects.js", has: [/kind: "modal", el: addProjectModal, onRemove: resetAddProjectModal/], gone: [/\.confirm-backdrop|e\.key === "Escape"\) \{ e\.preventDefault\(\); closeAddProjectModal/] },
  { name: "loop status dialog", file: "app-loop-ui.js", has: [/kind: "modal", id: "loop-status-modal", dialogClass: "loop-status-dialog"/], gone: [/loop-status-backdrop|loop-status-dialog-close/] },
  { name: "force change PIN", file: "app-misc.js", has: [/id: "force-change-pin-overlay"[^}]*dismissible: false[^}]*card: false[^}]*scrim: "solid"/], gone: [/style\.cssText|style="|z-index|fcp-style|style\.opacity/] },
  { name: "PWA install", file: "app-misc.js", has: [/showOverlay\(\{ kind: "modal", el: modal \}\)/], gone: [/pwa-modal-backdrop/] },
  { name: "QR", file: "qrcode.js", has: [/showOverlay\(\{ kind: "modal", el: qrOverlay \}\)/], gone: [/e\.key === "Escape"|qr-overlay-inner"\)\.addEventListener/] },
  { name: "avatar positioner", file: "profile.js", has: [/dialogClass: 'avatar-positioner-container'/, /onDismiss: function\(\) \{ URL\.revokeObjectURL\(objectUrl\); \}/], gone: [/avatar-positioner-overlay|avatar-positioner-close/] },
  { name: "mermaid viewer", file: "markdown.js", has: [/showOverlay\(\{ kind: "modal", el: modal \}\)/], gone: [/closeMermaidModal/] },
  { name: "notification help", file: "notifications.js", has: [/showOverlay\(\{ kind: "modal", el: notifHelpModal \}\)/], gone: [/notifHelpModal\.classList/] },
  { name: "resume picker", file: "sidebar-sessions.js", has: [/showOverlay\(\{ kind: "modal", el: resumeModal \}\)/], gone: [/resume-modal"\);\s*if \(modal\) modal\.classList/] },
  { name: "rewind", file: "rewind.js", has: [/kind: "modal", el: rewindModal, onRemove: resetRewindState/], gone: [/rewindModal\.classList/] },
  { name: "skill install", file: "app-skills-install.js", has: [/kind: "modal", el: skillInstallModal, onDismiss: onSkillInstallDismiss/], gone: [/skillInstallModal\.classList/] },
  { name: "skills", file: "skills.js", has: [/kind: "modal", el: modal, onEscape: onSkillsEscape/], gone: [/skills-modal-close|e\.key === "Escape"/] },
  { name: "MCP servers", file: "mcp-ui.js", has: [/kind: "modal", el: modal \}/], gone: [/mcp-modal-close|e\.key === "Escape"/] },
  { name: "input more-sheet", file: "input.js", has: [/kind: "sheet", el: moreSheet, exit: \{ className: "closing", ms: INPUT_MORE_EXIT_MS \}/], gone: [/input-more-backdrop|classList\.add\("open"\)/] },
  { name: "context sources reads the sheet from the registry", file: "context-sources.js", has: [/isModalOpen\(moreSheet\)/], gone: [/classList\.contains\("open"\)/] },
];

test("C2 source: the surfaces that cannot be imported under node:test open through the shared modal or sheet and keep no scrim, card or handler of their own", function () {
  C2_SOURCE_ROWS.forEach(function (row) {
    var src = publicFile(path.join("modules", row.file));
    row.has.forEach(function (re) { assert.match(src, re, row.name + " (" + row.file + "): opens through the shared overlay"); });
    row.gone.forEach(function (re) { assert.doesNotMatch(src, re, row.name + " (" + row.file + "): " + String(re) + " is gone"); });
  });
});

test("C2 force change PIN: a modal that cannot be dismissed on a solid scrim has no close control, and neither Escape nor the scrim gets past it", async function (t) {
  var m = await modalBrowser(t);
  // The options the module passes (pinned by the source row above).
  var handle = m.overlay.showOverlay({ kind: "modal", id: "force-change-pin-overlay", content: "x", dismissible: false, card: false, scrim: "solid" });
  var el = handle.el;
  assert.ok(el.classList.contains("overlay-scrim-solid"), "the solid scrim is an option");
  assert.ok(el.querySelector(".overlay-modal-dialog").classList.contains("overlay-modal-bare"), "no card");
  assert.equal(el.querySelectorAll(".overlay-close").length, 0, "no close control");
  m.escape();
  el.querySelector(".overlay-modal-backdrop").click();
  assert.equal(handle.isOpen(), true, "Escape and the scrim leave it");
  handle.close();
  assert.equal(handle.isOpen(), false, "the surface itself closes it once the PIN is saved");
});

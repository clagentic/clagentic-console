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
  // The move list hangs from the control still in the page, so it lands beside it; a
  // detached control (empty rect) would put it in the top-left corner, clamped to the margin.
  { name: "schedule move popover", kind: "popover", node: "page", place: { placement: "below" }, at: { left: "100px", top: "126px" },
    detachedAt: { left: "8px", top: "8px" },
    // Below the 768px breakpoint popover-position.js centres the card in the viewport
    // for any anchor (live or detached); the row proves it lands there and inside the margin.
    phone: { innerWidth: 390, innerHeight: 844, at: { left: "170px", top: "407px" } },
    callSite: { file: "scheduler.js",
      has: [/showMovePopover\(id, anchorEl\)/, /openCreateModalWithRecord\(rec, anchorEl\)/],
      gone: [/showMovePopover\(id, btn\)/, /openCreateModalWithRecord\(rec, btn\)/] } },
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

function openSurface(m, row, detached, viewport) {
  if (viewport) {
    global.window.innerWidth = viewport.innerWidth;
    global.window.innerHeight = viewport.innerHeight;
  }
  // The control the surface hangs from, or is opened by; a point has none. A
  // detached control is one removed from the page: it measures as an empty rect.
  var control = row.point ? null : anchorEl(m);
  if (detached) {
    control = m.doc.createElement("button");
    control.getBoundingClientRect = function () { return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }; };
  }
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
    if (row.detachedAt) {
      var stale = openSurface(m, row, true).handle.el;
      assert.deepEqual({ left: stale.style.left, top: stale.style.top }, row.detachedAt, row.name + ": a detached anchor places it in the corner");
      assert.notDeepEqual(row.detachedAt, row.at, row.name + ": the live anchor places it elsewhere");
      var src = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", row.callSite.file), "utf8");
      row.callSite.has.forEach(function (re) { assert.match(src, re, row.name + ": opened from the live anchor"); });
      row.callSite.gone.forEach(function (re) { assert.doesNotMatch(src, re, row.name + ": not from the popover's own button"); });
    }
    if (row.phone) {
      [false, true].forEach(function (detached) {
        var st = openSurface(m, row, detached, row.phone).handle.el.style;
        assert.deepEqual({ left: st.left, top: st.top }, row.phone.at, row.name + ": centred at the phone width (" + (detached ? "detached" : "live") + " anchor)");
        var left = parseFloat(st.left);
        var top = parseFloat(st.top);
        assert.ok(left >= 8 && left + 50 <= row.phone.innerWidth - 8 && top >= 8 && top + 30 <= row.phone.innerHeight - 8, row.name + ": inside the viewport margin at the phone width");
      });
    }
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

// sticky-notes.js layers the notes themselves through --note-order (a note's own
// counter, clamped by note-order.js), and reads the server's zIndex counter, so it
// is not checked for the word; only its colour picker is a menu, so that module is
// checked for hand placement alone.
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

// ---------------------------------------------------------------------------
// B3: the input autocomplete lists are one-open members, and only that
// ---------------------------------------------------------------------------

var listInstance = 0;

// The real list modules over the hand-built page, each behind the same four
// operations. The page's document collects the registry's click and Escape
// listeners, so a row can fire them as the browser would.
function pageListeners() {
  var heard = {};
  global.document.addEventListener = function (type, fn) { (heard[type] = heard[type] || []).push(fn); };
  return {
    click: function (target) { (heard.click || []).forEach(function (fn) { fn({ target: target }); }); },
    escape: function () { (heard.keydown || []).forEach(function (fn) { fn({ key: "Escape", preventDefault: function () {} }); }); },
  };
}

// The fake elements have no closest(); the lists' own click handlers ask for it.
function plain(el) { el.closest = function () { return null; }; return el; }

function keyEvent(key) { return { key: key, shiftKey: false, ctrlKey: false, metaKey: false, preventDefault: function () {} }; }

var INPUT_LISTS = [
  { name: "mention list", file: "mention.css", selector: "#mention-menu", token: "var(--z-base)",
    build: async function (n) {
      var el = plain(new dom.FakeElement("div"));
      el.id = "mention-menu";
      global.document.body.appendChild(el);
      var mod = await import(dom.moduleUrl("mention.js") + "?b3=" + n);
      var input = plain(new dom.FakeElement("textarea"));
      mod.initMention({ inputEl: input, allUsers: function () { return []; }, myUserId: function () { return null; } });
      return {
        el: el, input: input,
        open: function () { mod.showMentionMenu(""); },
        visible: function () { return mod.isMentionMenuVisible() && el.classList.contains("visible"); },
        own: function (key) { return mod.mentionMenuKeydown(keyEvent(key)); },
      };
    } },
  { name: "slash command list", file: "input.css", selector: "#slash-menu", token: "var(--z-base)",
    build: async function (n) {
      var el = plain(new dom.FakeElement("div"));
      var input = plain(new dom.FakeElement("textarea"));
      var mod = await import(dom.moduleUrl("input.js") + "?b3=" + n);
      mod.initInput({
        ws: { readyState: 1, send: function () {} }, connected: true, inputEl: input, sendBtn: new dom.FakeElement("button"),
        slashMenu: el, imagePreviewBar: new dom.FakeElement("div"), slashCommands: function () { return []; },
      });
      return {
        el: el, input: input,
        open: function () { dom.typeInto(input, "/"); },
        visible: function () { return el.classList.contains("visible"); },
        own: function (key) {
          var ev = keyEvent(key);
          (input._listeners.keydown || []).forEach(function (fn) { fn(ev); });
          return ev;
        },
      };
    } },
  { name: "@agent list", file: "at-agents.css", selector: ".at-agents-menu", token: "calc(var(--z-base) + 1)", ownClickHides: true,
    build: async function (n) {
      var input = plain(new dom.FakeElement("textarea"));
      var mod = await import(dom.moduleUrl("at-agents.js") + "?b3=" + n);
      mod.initAtAgents({ inputEl: input });
      mod.handleProjectAgentsList({ agents: [{ name: "Scout", slug: "scout", description: "looks around" }] });
      var el = global.document.body.querySelector(".at-agents-menu");
      return {
        el: el, input: input,
        open: function () { mod.showAgentMenu(""); },
        visible: function () { return mod.isAgentMenuActive() && el.classList.contains("visible"); },
        own: function (key) { return mod.agentMenuKeydown(keyEvent(key)); },
      };
    } },
];

// A menu of each kind: an element-anchored built card and a retained page node.
var LIST_MENUS = ["session context menu", "schedule popover"];

async function listBrowser(t, width, list) {
  var m = await menuBrowser(t);
  global.window.innerWidth = width;
  m.page = pageListeners();
  m.list = await list.build(++listInstance);
  m.list.input.focus = function () { m.focusCalls = (m.focusCalls || 0) + 1; };
  m.list.open();
  return m;
}

test("B3 one open: a menu opening closes an open input list, and a list opening closes an open menu, for each list, menu and width", async function (t) {
  for (var l = 0; l < INPUT_LISTS.length; l++) {
    for (var w = 0; w < WIDTHS.length; w++) {
      for (var k = 0; k < LIST_MENUS.length; k++) {
        var list = INPUT_LISTS[l];
        var at = list.name + " with the " + LIST_MENUS[k] + " at " + WIDTHS[w] + "px";

        t.mock.timers.reset();
        var a = await listBrowser(t, WIDTHS[w], list);
        assert.equal(a.list.visible(), true, at + ": the list opens");
        assert.equal(a.registry.getOpenMenu(), a.list.el, at + ": the registry holds the list");
        var menu = openSurface(a, rowNamed(LIST_MENUS[k])).handle;
        assert.equal(a.list.visible(), false, at + ", list then menu: the list closed");
        assert.equal(menu.isOpen(), true, at + ", list then menu: the menu is open");
        assert.equal(a.registry.getOpenMenu(), menu.el, at + ", list then menu: the registry holds the menu");

        t.mock.timers.reset();
        var b = await listBrowser(t, WIDTHS[w], list);
        b.list.own("Escape");
        var first = openSurface(b, rowNamed(LIST_MENUS[k])).handle;
        assert.equal(b.list.visible(), false, at + ", menu then list: the list is closed to start");
        b.list.open();
        assert.equal(gone(first), true, at + ", menu then list: the menu closed");
        assert.equal(b.list.visible(), true, at + ", menu then list: the list stays open");
        assert.equal(b.registry.getOpenMenu(), b.list.el, at + ", menu then list: the registry holds the list");
        assert.equal(b.focusCalls || 0, 0, at + ", menu then list: nothing moved focus off the text box");
      }
    }
  }
});

test("B3 a list keeps its own Escape; the registry's Escape and a click in the text box leave it; an outside click closes it", async function (t) {
  for (var l = 0; l < INPUT_LISTS.length; l++) {
    for (var w = 0; w < WIDTHS.length; w++) {
      var list = INPUT_LISTS[l];
      var at = list.name + " at " + WIDTHS[w] + "px";
      t.mock.timers.reset();
      var m = await listBrowser(t, WIDTHS[w], list);

      m.page.click(m.list.input);
      // The @agent list has always hidden itself on any click outside the list,
      // its text box included (at-agents.js); that is its own handler, unchanged.
      assert.equal(m.list.visible(), !list.ownClickHides, at + ": the registry does not take a click in the text box as outside" + (list.ownClickHides ? " (this list's own handler does)" : ""));
      if (list.ownClickHides) m.list.open();
      m.page.click(plain(m.list.el));
      assert.equal(m.list.visible(), true, at + ": nor is a click in the list");
      m.page.escape();
      assert.equal(m.list.visible(), true, at + ": the registry's Escape does not close it from under the text box");

      m.list.own("Escape");
      assert.equal(m.list.visible(), false, at + ": its own Escape closes it");
      assert.equal(m.registry.getOpenMenu(), null, at + ": and the registry lets it go");

      m.list.open();
      assert.equal(m.list.visible(), true, at + ": it opens again after its own Escape");
      m.page.click(plain(m.doc.body));
      assert.equal(m.list.visible(), false, at + ": an outside click closes it, clearing its own state");
      assert.equal(m.registry.getOpenMenu(), null, at + ": and the registry lets it go");
    }
  }
});

test("B3 css: each list's layer is a token at each width", function () {
  INPUT_LISTS.forEach(function (list) {
    WIDTHS.forEach(function (width) {
      assert.equal(cssRules.valueAt(css(list.file), list.selector, "z-index", width), list.token, list.name + " at " + width + "px");
    });
  });
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
// Repo-wide z-index guard: every stylesheet, script and page under lib/public
// (this folds in the C1 modal-file guard and the C3a panel-file guard)
// ---------------------------------------------------------------------------

// A z-index from 100 up is a layer and comes from the scale in base.css (var(--z-*)).
// Only these sub-100 bands may stay as a literal, each named by what it is for; no
// file is exempt. A value that is a token, or a calc over tokens, may add or take
// an offset inside the same bands (the panel order, the note order, the sidebar
// scrim at one below the sidebar).
var LOCAL_Z_BANDS = [
  { name: "behind: -1, a decorative label that must sit under its own row", min: -1, max: -1 },
  { name: "local: 0 to 99, stacking between siblings inside one component", min: 0, max: 99 },
];
var LOCAL_Z_KEYWORDS = ["auto", "inherit", "initial", "unset"];
var ZSCAN_EXT = /\.(css|js|html)$/;

function publicFilesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce(function (all, e) {
    var full = path.join(dir, e.name);
    if (e.isDirectory()) return all.concat(publicFilesUnder(full));
    return ZSCAN_EXT.test(e.name) ? all.concat(full) : all;
  }, []);
}

// Why a z-index value is not allowed, or "" when it is: a token, a keyword, a
// literal in a named band, or a calc whose bare numbers are all offsets under 100.
function zValueProblem(value) {
  var v = String(value).trim().replace(/\s*!important$/, "");
  if (LOCAL_Z_KEYWORDS.indexOf(v) !== -1) return "";
  // A var() fallback is a value the browser can use, so it is read like any other:
  // 100 or more is a layer and has to be a token; a fallback under 100 is an offset.
  var fallbacks = v.match(/var\(--[a-z-]+\s*,[^)]*\)/g) || [];
  var bigFallback = fallbacks.some(function (f) {
    var fb = f.replace(/^var\(--[a-z-]+\s*,/, "").replace(/var\(--z-[a-z]+\)/g, "");
    return (fb.match(/\d+/g) || []).some(function (d) { return Number(d) >= 100; });
  });
  if (bigFallback) return "a var() fallback of 100 or more: " + v;
  var bare = v.replace(/var\(--z-[a-z]+\)/g, "").replace(/var\(--[a-z-]+(?:,[^)]*)?\)/g, "");
  if (/^-?\d+$/.test(v)) {
    var n = Number(v);
    return LOCAL_Z_BANDS.some(function (b) { return n >= b.min && n <= b.max; }) ? "" : "literal " + v + " is in no named band";
  }
  if (!/var\(--z-[a-z]+\)/.test(v)) return "not a layer token: " + v;
  var nums = bare.match(/\d+/g) || [];
  return nums.every(function (d) { return Number(d) < 100; }) ? "" : "an offset of 100 or more: " + v;
}

// Every z-index declaration in a source: CSS, a cssText string, an inline style
// attribute, a style.zIndex assignment, an object-literal zIndex, a
// setProperty("z-index", v) call, or a string built as "z-index:" + v (its first
// operand is the value). Comments are not read.
var Z_DECLARATION = new RegExp([
  "z-index\\s*:\\s*([^;}\"'`\\n]+)",
  "\\bzIndex\\s*=(?!=)\\s*([^;\\n]+)",
  // Only a literal value: a plain data field such as { el: el, zIndex: zIndex } is not a style.
  "\\bzIndex\\s*:\\s*(\"[^\"]*\"|'[^']*'|`[^`]*`|-?\\d[^,;}\\n]*)",
  "setProperty\\(\\s*[\"']z-index[\"']\\s*,\\s*(\"[^\"]*\"|'[^']*'|`[^`]*`|[^,)\\n]+)",
  "z-index\\s*:\\s*[\"'`]\\s*\\+\\s*(\"[^\"]*\"|'[^']*'|[^\\s+;,)]+)",
].join("|"), "g");

function zDeclarations(src, file) {
  var text = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
  var found = [];
  var re = new RegExp(Z_DECLARATION.source, "g");
  var m;
  while ((m = re.exec(text))) {
    var raw = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
    var value = raw.trim().replace(/^["'`]|["'`]$/g, "");
    found.push({ file: file, value: value, where: text.slice(0, m.index).split("\n").length });
  }
  return found;
}

test("guard: no z-index in lib/public is a literal at or above 100, with no exempt file; each allowed literal sits in a named band", function () {
  var files = publicFilesUnder(PUBLIC_DIR);
  assert.ok(files.some(function (f) { return /base\.css$/.test(f); }) && files.some(function (f) { return /sticky-notes\.js$/.test(f); }), "the scan reaches the stylesheets and the modules");
  var declared = Object.create(null);
  (BASE.match(/--z-[a-z]+(?=:)/g) || []).forEach(function (n) { declared[n] = true; });
  var bad = [];
  var used = 0;
  files.forEach(function (file) {
    var src = fs.readFileSync(file, "utf8");
    zDeclarations(src, path.relative(PUBLIC_DIR, file)).forEach(function (d) {
      used++;
      var why = zValueProblem(d.value);
      if (why) bad.push(d.file + ":" + d.where + " " + why);
      (d.value.match(/var\((--z-[a-z]+)\)/g) || []).forEach(function (ref) {
        var name = /var\((--z-[a-z]+)\)/.exec(ref)[1];
        if (!declared[name]) bad.push(d.file + ":" + d.where + " uses " + name + ", which base.css does not declare");
      });
    });
  });
  assert.ok(used > 50, "the guard reads the declarations (" + used + ")");
  assert.deepEqual(bad, [], "z-index values outside the scale and the named bands");

  // The guard fails on a new overlay-band literal, in a stylesheet and in a script.
  ["z-index: 100;", "z-index: 9999 !important;", "z-index: calc(var(--z-panel) + 100);", "el.style.zIndex = 100 + order;", 'el.style.zIndex = "10000";', "a{z-index:1000}",
    "Object.assign(el.style, { zIndex: 9999 });", 'Object.assign(el.style, { zIndex: "9999", top: 0 });',
    'el.style.setProperty("z-index", 9999);', 'el.style.setProperty("z-index", "500", "important");',
    'el.style.cssText = "z-index:" + 9999;', 'el.style.cssText = "z-index:" + n + ";";', "el.style.cssText = `top: 0; z-index: 9999;`;",
    "a{z-index: var(--x, 9999)}", "a{z-index: calc(var(--z-panel) + var(--x, 100))}"]
    .forEach(function (src) {
      var hits = zDeclarations(src, "x").filter(function (d) { return zValueProblem(d.value); });
      assert.equal(hits.length, 1, src + " is refused");
    });
  ["z-index: 99;", "z-index: -1;", "z-index: var(--z-menu);", "z-index: calc(var(--z-modal) + var(--overlay-order, 0));", "z-index: calc(var(--z-sidebar) - 1);", "z-index: auto;",
    'el.style.zIndex = "var(--z-tooltip)";', "/* z-index: 5000 */",
    "Object.assign(el.style, { zIndex: 5, top: 0 });", 'el.style.setProperty("z-index", "var(--z-menu)");',
    'el.style.cssText = "z-index:" + "var(--z-menu)";', "a{z-index: calc(var(--z-note) + var(--note-order, 0))}", "a{z-index: var(--x, var(--z-menu))}"]
    .forEach(function (src) {
      var hits = zDeclarations(src, "x").filter(function (d) { return zValueProblem(d.value); });
      assert.equal(hits.length, 0, src + " is allowed");
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
  var menu = m.overlay.showOverlay({ kind: "menu", content: "m" });
  assert.equal(menu.isOpen(), true, "a menu opens over the C2 modals");
  assert.equal(m.registry.isModalOpen(skills.root), true, "and does not close the modal beneath it");
  menu.close();
  m.escape();
  assert.equal(m.registry.isModalOpen(skills.root), false, "Escape closed the top modal");
  assert.equal(m.registry.isModalOpen(grants), true, "and left the one beneath");
  assert.equal(toast.classList.contains("hide"), false, "and the toast");
  WIDTHS.forEach(function (width) {
    var at = " at " + width + "px";
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-modal", "z-index", width), "calc(var(--z-modal) + var(--overlay-order, 0))", "both modals share the one modal layer" + at);
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-menu", "z-index", width), "var(--z-menu)", "a menu is above the modals and under a toast" + at);
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-stack", "z-index", width), "var(--z-toast)", "a toast is above them" + at);
  });
  assert.ok(layer("modal") + 99 < layer("menu") && layer("menu") < layer("toast"), "modal < menu < toast");
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
  // C3a: the panels' layer is the shared panel option's, no longer a rule on their own node.
  assert.equal(cssRules.valueAt(css("user-settings.css"), "#user-settings", "z-index", DESKTOP), null);
  assert.equal(cssRules.valueAt(css("server-settings.css"), "#server-settings", "z-index", DESKTOP), null);
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
  { name: "remove-project-task dialog", file: "app-projects.js", has: [/kind: "modal", dialogClass: "remove-project-task-dialog"/, /Remove project "' \+ escapeHtml\(name \|\| slug\) \+ '"/, /<option value="' \+ escapeHtml\(p\.slug\) \+ '">' \+ escapeHtml\(p\.title \|\| p\.project \|\| p\.slug\) \+ '<\/option>/], gone: [/remove-project-task-backdrop|remove-project-task-modal/, /\+ \(name \|\| slug\) \+|\+ p\.slug \+ '"|\+ \(p\.title \|\| p\.project \|\| p\.slug\) \+/] },
  { name: "add-project modal", file: "app-projects.js", has: [/kind: "modal", el: addProjectModal, onRemove: resetAddProjectModal/], gone: [/\.confirm-backdrop|e\.key === "Escape"\) \{ e\.preventDefault\(\); closeAddProjectModal/] },
  { name: "loop status dialog", file: "app-loop-ui.js", has: [/kind: "modal", id: "loop-status-modal", dialogClass: "loop-status-dialog"/], gone: [/loop-status-backdrop|loop-status-dialog-close/] },
  { name: "force change PIN", file: "app-misc.js", has: [/id: "force-change-pin-overlay"[^}]*dismissible: false[^}]*card: false[^}]*scrim: "solid"/], gone: [/style\.cssText|style="|z-index|fcp-style|style\.opacity/] },
  { name: "PWA install", file: "app-misc.js", has: [/showOverlay\(\{ kind: "modal", el: modal \}\)/], gone: [/pwa-modal-backdrop/] },
  { name: "QR", file: "qrcode.js", has: [/showOverlay\(\{ kind: "modal", el: qrOverlay \}\)/, /escapeHtml\(url\) \+ '<span class="qr-hint">/], gone: [/innerHTML = url \+/, /e\.key === "Escape"|qr-overlay-inner"\)\.addEventListener/] },
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

// ---------------------------------------------------------------------------
// C3a: the panel option, the panels on it, the dialogs moved off .confirm-backdrop
// ---------------------------------------------------------------------------

// modalBrowser plus the browser's history, which the panel option holds an entry
// in, and the phone breakpoint the settings panel asks about.
async function panelBrowser(t, phone) {
  var m = await modalBrowser(t);
  var calls = { push: 0, back: 0 };
  global.history = { pushState: function () { calls.push++; }, back: function () { calls.back++; } };
  global.window.matchMedia = function () { return { matches: !!phone }; };
  m.history = calls;
  m.historyMod = await import(dom.moduleUrl("overlay-history.js"));
  // The popstate of each back an earlier row issued has arrived by now.
  while (m.historyMod.consumeOwnPopstate()) { /* delivered */ }
  return m;
}

// user-settings.js as the page has it: the page's own panel node (the shared scrim
// and a dialog, hidden) and the gear button that opens it.
function userSettingsPage() {
  var root = new dom.FakeElement("div");
  root.id = "user-settings";
  root.className = "hidden";
  var scrim = new dom.FakeElement("div");
  scrim.className = "overlay-modal-backdrop";
  var dialog = new dom.FakeElement("div");
  dialog.className = "overlay-modal-dialog us-modal";
  root.appendChild(scrim);
  root.appendChild(dialog);
  var btn = new dom.FakeElement("button");
  btn.id = "user-settings-btn";
  global.document.body.appendChild(root);
  global.document.body.appendChild(btn);
  return { root: root, dialog: dialog, btn: btn };
}

// How a panel is dismissed: the ways every panel shares (Escape, the scrim, the
// shared close control) and the phone's back swipe, which is the browser's
// popstate (app.js consumes it, then closes the top panel that holds an entry).
var PANEL_WAYS = [
  { name: "Escape", act: function (m) { m.escape(); } },
  { name: "a click on the scrim", act: function (m, el) { el.querySelector(".overlay-modal-backdrop").click(); } },
  { name: "the shared close control", act: function (m, el) { el.querySelector(".overlay-close").click(); } },
  { name: "the back swipe", phoneOnly: true, act: function (m) {
    assert.equal(backGesture(m), "panel", "the panel that owns the newest entry closes itself");
  } },
];

// The popstate routing of app.js, over the same exports: the echo of our own back
// closes nothing; else an open menu or dialog closes first and the entry the
// browser popped is put back; else the owner of the newest entry closes (a panel
// by its node, or an overlay that keeps its own anonymous entry, which app.js
// routes to that overlay's close function).
function backGesture(m) {
  var h = m.historyMod;
  if (h.consumeOwnPopstate()) return "own";
  if (!h.hasOverlayState()) return "none";
  if (m.registry.closeTopBlockingOverlay()) { h.restoreOverlayState(); return "blocking"; }
  var owner = h.topOverlayOwner();
  h.consumeOverlayPopstate();
  if (!owner) return "legacy";
  if (m.registry.closeHeldPanel(owner)) return "panel";
  h.restoreOverlayState();
  return "kept";
}

test("C3a panel: the real user settings module opens as the panel option, closes by each way, and holds its history entry on a phone only", async function (t) {
  global.fetch = function () { return Promise.reject(new Error("offline")); };
  for (var p = 0; p < 2; p++) {
    var phone = p === 1;
    for (var w = 0; w < PANEL_WAYS.length; w++) {
      var way = PANEL_WAYS[w];
      if (way.phoneOnly && !phone) continue;
      var m = await panelBrowser(t, phone);
      var page = userSettingsPage();
      var mod = await import(dom.moduleUrl("user-settings.js") + "?c3a=" + (++instance));
      mod.initUserSettings({});
      var at = (phone ? "phone" : "desktop") + ", " + way.name;
      page.btn.click();
      var el = m.top();
      assert.equal(el, page.root, at + ": the page's own panel is the one in the registry");
      assert.equal(mod.isUserSettingsOpen(), true, at + ": open");
      assert.ok(el.classList.contains("overlay-modal") && el.classList.contains("overlay-panel"), at + ": the shared modal with the panel option");
      assert.equal(el.getAttribute("data-overlay-kind"), "modal", at + ": a modal, not a sheet");
      assert.equal(el.classList.contains("hidden"), false, at + ": shown");
      assert.ok(page.dialog.classList.contains("overlay-panel-dialog"), at + ": the dialog is the panel's");
      var closes = el.querySelectorAll(".overlay-close");
      assert.equal(closes.length, 1, at + ": one close control");
      assert.equal(closes[0]._parent, page.dialog, at + ": the dialog's own child, at its corner");
      assert.equal(m.history.push, phone ? 1 : 0, at + ": a history entry only where the panel is a page of the phone list");
      assert.equal(m.historyMod.hasOverlayState(), phone, at + ": and the history module knows it");
      page.btn.click();
      assert.equal(m.history.push, phone ? 1 : 0, at + ": opened again while open, it holds one entry, not two");
      assert.ok(page.btn.classList.contains("active"), at + ": its gear shows it open");

      way.act(m, el);
      m.tick(300);
      assert.equal(mod.isUserSettingsOpen(), false, at + ": closed");
      assert.equal(modalGone(m, el, true), true, at + ": hidden and kept in the page");
      assert.equal(page.btn.classList.contains("active"), false, at + ": its gear shows it closed");
      assert.equal(m.history.back, phone && !way.phoneOnly ? 1 : 0, at + ": the entry is released once, and the swipe's own pop issues no second back");
      assert.equal(m.historyMod.hasOverlayState(), false, at + ": no entry is left");
    }
  }
});

test("C3a panel: the history option, a re-opened panel, and the back swipe closing the panel opened last that holds an entry", async function (t) {
  var HISTORY_ROWS = [
    { name: "a panel holds an entry by default", history: undefined, held: true },
    { name: "history: false holds none", history: false, held: false },
    { name: "a function answering true holds one", history: function () { return true; }, held: true },
    { name: "a function answering false holds none", history: function () { return false; }, held: false },
  ];
  for (var i = 0; i < HISTORY_ROWS.length; i++) {
    var row = HISTORY_ROWS[i];
    var m = await panelBrowser(t, false);
    var handle = m.overlay.showOverlay({ kind: "modal", panel: true, content: "x", history: row.history });
    assert.equal(m.history.push, row.held ? 1 : 0, row.name + ": entries pushed");
    handle.close();
    assert.equal(m.history.back, row.held ? 1 : 0, row.name + ": released on close");
    assert.equal(m.historyMod.hasOverlayState(), false, row.name + ": none left");
  }

  var n = await panelBrowser(t, false);
  var first = n.overlay.showOverlay({ kind: "modal", panel: true, content: "a" });
  var unheld = n.overlay.showOverlay({ kind: "modal", panel: true, content: "b", history: false });
  var second = n.overlay.showOverlay({ kind: "modal", panel: true, content: "c" });
  assert.equal(n.history.push, 2, "two panels hold an entry");
  assert.equal(backGesture(n), "panel");
  assert.deepEqual([first.isOpen(), unheld.isOpen(), second.isOpen()], [true, true, false], "the panel that owns the newest entry closed; a panel with no entry stays");
  assert.equal(backGesture(n), "panel");
  assert.deepEqual([first.isOpen(), unheld.isOpen()], [false, true], "then the earlier one");
  assert.equal(backGesture(n), "none", "no entry is held now; the router falls through to the others");
  assert.equal(n.history.back, 0, "a swipe's pops issue no back of their own");
  unheld.close();
});

// What one back closes over a panel, in open order: a dialog or a menu opened over
// it closes first and the panel stays, with its entry put back; a legacy overlay's
// entry pushed after the panel is that overlay's to close; the panel closes only
// when it owns the newest entry.
var BACK_ROWS = [
  { name: "a dialog over a panel", over: function (m) { return m.overlay.showOverlay({ kind: "modal", content: "d" }); } },
  { name: "a menu over a panel", over: function (m) { return m.overlay.showOverlay({ kind: "menu", content: "m" }); } },
];

test("C3a panel: one back closes the topmost overlay in open order and keeps the history stack consistent", async function (t) {
  for (var i = 0; i < BACK_ROWS.length; i++) {
    var row = BACK_ROWS[i];
    var m = await panelBrowser(t, false);
    var panel = m.overlay.showOverlay({ kind: "modal", panel: true, content: "p" });
    var over = row.over(m);
    assert.equal(m.history.push, 1, row.name + ": the panel holds one entry");
    assert.equal(backGesture(m), "blocking", row.name + ": the first back closes what is on top");
    assert.equal(over.isOpen(), false, row.name + ": it closed");
    assert.equal(panel.isOpen(), true, row.name + ": the panel stays");
    assert.equal(m.history.push, 2, row.name + ": the entry the browser popped is put back");
    assert.equal(m.historyMod.hasOverlayState(), true, row.name + ": the panel still holds it");
    assert.equal(backGesture(m), "panel", row.name + ": the next back closes the panel");
    assert.equal(panel.isOpen(), false, row.name + ": closed");
    assert.equal(m.history.back, 0, row.name + ": no back of our own, so no double pop");
    assert.equal(m.historyMod.hasOverlayState(), false, row.name + ": no entry is orphaned");
  }

  // Only the topmost modal is looked at: back never reaches a dialog under it.
  var TOP_ROWS = [
    { name: "a non-dismissible dialog over a dismissible one", build: function (m) {
      var below = m.overlay.showOverlay({ kind: "modal", content: "d" });
      var top = m.overlay.showOverlay({ kind: "modal", content: "f", dismissible: false });
      m.historyMod.pushOverlayState(); // an entry for the back to pop, held by neither dialog
      return { handles: [below, top] };
    }, first: "blocking", open: [true, true] },
    // C3b: a panel opened over a dialog is refused, so it holds no history entry and
    // there is nothing for a back to reach but the dialog's own routing (no entry: "none").
    { name: "a panel refused over a dialog", build: function (m) {
      var below = m.overlay.showOverlay({ kind: "modal", content: "d" });
      var top = m.overlay.showOverlay({ kind: "modal", panel: true, content: "p" });
      return { handles: [below, top] };
    }, first: "none", open: [true, false] },
  ];
  for (var k = 0; k < TOP_ROWS.length; k++) {
    var tr = TOP_ROWS[k];
    var q = await panelBrowser(t, false);
    var made = tr.build(q);
    assert.equal(backGesture(q), tr.first, tr.name + ": the back is taken by the topmost modal's rule");
    assert.deepEqual(made.handles.map(function (h) { return h.isOpen(); }), tr.open, tr.name + ": nothing under the top modal closes");
    made.handles.forEach(function (h) { if (h.isOpen()) h.close(); });
    while (q.historyMod.hasOverlayState()) q.historyMod.popOverlayState();
    while (q.historyMod.consumeOwnPopstate()) { /* delivered */ }
  }

  var n = await panelBrowser(t, false);
  var lower = n.overlay.showOverlay({ kind: "modal", panel: true, content: "a" });
  n.historyMod.pushOverlayState(); // a legacy overlay opened after the panel (the session search)
  assert.equal(backGesture(n), "legacy", "the entry opened last is the legacy overlay's to close");
  n.historyMod.popOverlayState(); // its close function
  assert.equal(lower.isOpen(), true, "the panel under it stays");
  assert.equal(n.history.back, 0, "and the swipe's pop issues no back of its own");
  assert.equal(backGesture(n), "panel", "then the panel closes");
  assert.equal(lower.isOpen(), false);
});

test("C3a panel: a panel opened later sits over an earlier one, and the legacy panels sit between", async function (t) {
  var m = await panelBrowser(t, false);
  var order = function (el) { return Number(el.style["--overlay-order"]); };
  var a = m.overlay.showOverlay({ kind: "modal", panel: true, content: "a" });
  var b = m.overlay.showOverlay({ kind: "modal", panel: true, content: "b" });
  var dialog = m.overlay.showOverlay({ kind: "modal", content: "d" });
  assert.ok(order(b.el) > order(a.el), "a panel opened from another is numbered above it");
  assert.ok(order(dialog.el) > order(b.el), "a dialog is numbered over the panels");
  for (var i = 0; i < 60; i++) m.overlay.showOverlay({ kind: "modal", panel: true, content: "p" + i });
  assert.ok(order(m.top()) <= 40, "panel numbers are clamped, so the band stays under the modal layer");
  assert.ok(layer("panel") + 2 + 40 < layer("modal"), "the whole panel band is under the modal layer");
  assert.ok(layer("panel") > layer("nav"), "and over the nav");
  // The phone Settings list (+0), then project settings opened from it (+1), then a registry panel (+2 and up): each above the last (the layers are rows of the token table).
  var hub = cssRules.valueAt(css("settings-nav.css"), "#settings-hub", "z-index", PHONE);
  var ps = cssRules.valueAt(css("filebrowser.css"), "#project-settings", "z-index", PHONE);
  assert.equal(hub, "var(--z-panel)");
  assert.match(ps, /\+ 1\)$/, "project settings is one above the list that opens it");
});

test("C3a panel: releasing a panel's entry before the page navigates issues no back, and a panel kept open by a navigation keeps its own", async function (t) {
  var m = await panelBrowser(t, false);
  var palette = m.overlay.showOverlay({ kind: "modal", panel: true, content: "p" });
  assert.equal(m.history.push, 1);
  palette.close({ keepHistory: true });
  assert.equal(m.history.back, 0, "no queued back to land on the old sentinel after the navigation's push");
  assert.equal(m.historyMod.hasOverlayState(), false, "the entry is released");
  assert.equal(palette.isOpen(), false, "and the panel closed");
  var plain = m.overlay.showOverlay({ kind: "modal", panel: true, content: "q" });
  plain.close();
  assert.equal(m.history.back, 1, "a close with no navigation still releases its entry with a back");
});

test("C3a panel: a dialog opened from a panel sits over it and takes Escape first, whichever opened last", async function (t) {
  var m = await panelBrowser(t, false);
  var panel = m.overlay.showOverlay({ kind: "modal", panel: true, content: "panel" });
  m.modals.showConfirm("Sure?", function () {});
  var confirm = m.top();
  m.escape();
  assert.equal(m.registry.isModalOpen(confirm), false, "Escape closed the dialog opened from the panel");
  assert.equal(panel.isOpen(), true, "and left the panel");
  m.escape();
  assert.equal(panel.isOpen(), false, "the next Escape closes the panel");

  // A panel opened while a dialog is up (the palette over a confirmation) is
  // refused (C3b), so the dialog is the only thing there and takes the key. The
  // row that held a panel under a dialog is replaced: that order no longer exists.
  var dialog = m.overlay.showOverlay({ kind: "modal", content: "d" });
  var later = m.overlay.showOverlay({ kind: "modal", panel: true, content: "later" });
  assert.equal(later.isOpen(), false, "the later panel was refused");
  m.escape();
  assert.equal(dialog.isOpen(), false, "the dialog closed");
  assert.equal(m.registry.getTopModal(), null, "and no hidden panel is left to close");

  WIDTHS.forEach(function (width) {
    var at = " at " + width + "px";
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-modal", "z-index", width), "calc(var(--z-modal) + var(--overlay-order, 0))", "a dialog on the modal layer" + at);
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-panel-dialog", "width", width), "100%", "the panel dialog fills the page" + at);
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-panel-dialog > .overlay-close", "top", width), "calc(var(--safe-top) + var(--overlay-close-inset))", "its close control clears the notch" + at);
  });
  assert.ok(layer("nav") < layer("panel") && layer("panel") < layer("modal"), "base < nav < panel < modal");
});

// The page's static panels and dialogs: the shared scrim and dialog, no scrim,
// close control or backdrop of their own.
var C3A_STATIC_IDS = ["user-settings", "ralph-wizard", "ralph-preview-modal", "sched-delete-dialog"];

// Surfaces whose module cannot be imported and driven under node:test (the palette
// and the picker build their markup through innerHTML, which the fake DOM drops;
// server settings and the ralph and scheduler modules read dozens of page nodes at
// start): pinned by source. Each opens through showOverlay and keeps no scrim,
// close control, Escape or history handling of its own.
var C3A_SOURCE_ROWS = [
  { name: "command palette", file: "command-palette.js",
    has: [/showOverlay\(\{ kind: "modal", panel: true, el: paletteEl, closeLabel: "Close search", onRemove: resetPalette \}\)/, /overlay-modal-backdrop"><\/div>' \+\s*'<div class="overlay-modal-dialog cmd-palette-dialog">/,
      // the builders the file keeps escape what the server or a user supplies (P6)
      /escapeHtml\("v" \+ cachedVersion\)/, /'<img src="' \+ escapeHtml\(uAvatarUrl\) \+ '"/, /escapeHtml\(proj\.sessions \+ " sessions"\)/,
      // a choice that switches project releases the panel's history entry before the navigation pushes its own
      /closeCommandPalette\(leavesProject\(entry\.data\.slug\)\);\s*ctx\.switchProject/, /closeCommandPalette\(leavesProject\(item\.projectSlug\)\);/],
    gone: [/overlay-history|pushOverlayState|popOverlayState/, /cmd-palette-backdrop|cmd-palette-close|cmd-palette-kbd/, /"v" \+ cachedVersion : ""/, /e\.key === "Escape"/, /paletteEl\.classList/] },
  { name: "agent picker", file: "agent-picker.js",
    has: [/showOverlay\(\{ kind: "modal", panel: true, el: paletteEl, closeLabel: "Close agents", onRemove: resetPicker \}\)/, /overlay-modal-backdrop"><\/div>' \+\s*'<div class="overlay-modal-dialog cmd-palette-dialog">/],
    gone: [/cmd-palette-backdrop|agent-picker-close|cmd-palette-kbd/, /e\.key === "Escape"/, /paletteEl\.classList\.(add|remove)\("hidden"\)/] },
  { name: "server settings", file: "server-settings.js",
    has: [/showOverlay\(\{ kind: "modal", panel: true, el: settingsEl, onEscape: onSettingsEscape, onRemove: onSettingsClosed \}\)/, /if \(!paletteOpen\) return false;\s*closeSettingsPalette\(\);\s*return true;/,
      // the PIN input spends its Escape, so one key does not also close the panel; a second open clears the first stats timer
      /pinInput\.addEventListener\("keydown", function \(e\) \{[^}]*?e\.stopPropagation\(\);\s*if \(e\.key === "Enter"\)/,
      /stopStatsTimer\(\);\s*requestStats\(\);\s*statsTimer = setInterval\(requestStats, 5000\);/, /function onSettingsClosed\(\) \{[^}]*stopStatsTimer\(\);/],
    gone: [/overlay-history|pushOverlayState|popOverlayState/, /server-settings-close|closeBtn/, /e\.key === "Escape" && !settingsEl/, /settingsEl\.classList\.(add|remove)\("hidden"\)/] },
  { name: "user settings", file: "user-settings.js",
    has: [/kind: 'modal', panel: true, el: settingsEl, history: isPhoneSettingsLayout,/],
    gone: [/overlay-history|pushOverlayState|popOverlayState|holdsHistoryEntry/, /user-settings-close|user-settings-backdrop|closeBtn|backdrop/, /e\.key === 'Escape' && isUserSettingsOpen/] },
  { name: "ralph wizard", file: "app-loop-wizard.js",
    has: [/showOverlay\(\{ kind: "modal", el: el \}\)/],
    gone: [/ralph-wizard-close|ralph-wizard-backdrop/, /(^|[^\w])el\.classList\.(add|remove)\("hidden"\)/] },
  { name: "ralph preview", file: "app-loop-ui.js",
    has: [/previewHandle = showOverlay\(\{ kind: "modal", el: modal \}\)/],
    gone: [/modal\.classList\.(add|remove)\("hidden"\)/, /Backdrop click intentionally does NOT close/] },
  { name: "scheduler delete dialog", file: "scheduler-config.js",
    has: [/deleteHandle = showOverlay\(\{ kind: "modal", el: dialog, onRemove: forgetDeleteTarget \}\)/],
    gone: [/e\.target === deleteDialog/, /dialog\.classList\.(add|remove)\("hidden"\)/] },
];

test("C3a html: the user settings, ralph and scheduler dialogs are the shared scrim and dialog, and server settings is the panel dialog, with no close control of their own", function () {
  C3A_STATIC_IDS.forEach(function (id) {
    var re = new RegExp('id="' + id + '"[^>]*>\\s*<div class="overlay-modal-backdrop"></div>\\s*<div [^>]*class="[^"]*overlay-modal-dialog');
    assert.match(INDEX_HTML, re, id + " is the shared scrim and dialog");
  });
  assert.match(INDEX_HTML, /id="server-settings"[^>]*>\s*<div class="overlay-modal-dialog server-settings-layout">/, "server settings is a full-page panel dialog");
  assert.doesNotMatch(INDEX_HTML, /id="user-settings-close"|id="server-settings-close"|us-modal-close|id="ralph-wizard-close"|ralph-wizard-backdrop|server-settings-close-col|sched-delete-dialog-backdrop/, "no own close control, backdrop or column is left");
});

test("C3a source: the palette, the picker, server settings and the ralph and scheduler dialogs open through the shared overlay and keep no handler of their own", function () {
  C3A_SOURCE_ROWS.forEach(function (row) {
    var src = publicFile(path.join("modules", row.file));
    row.has.forEach(function (re) { assert.match(src, re, row.name + " (" + row.file + "): opens through the shared overlay"); });
    row.gone.forEach(function (re) { assert.doesNotMatch(src, re, row.name + " (" + row.file + "): " + String(re) + " is gone"); });
  });
  var app = publicFile("app.js");
  var cm = "(?:\\s*\\/\\/[^\\n]*)*\\s*";
  var routing = new RegExp(
    "if \\(consumeOwnPopstate\\(\\)\\) return;" + cm +
    "if \\(hasOverlayState\\(\\)\\) \\{" + cm +
    "if \\(closeTopBlockingOverlay\\(\\)\\) \\{ restoreOverlayState\\(\\); return; \\}\\s*" +
    "var owner = topOverlayOwner\\(\\);\\s*consumeOverlayPopstate\\(\\);" + cm +
    "if \\(owner\\) \\{\\s*if \\(!closeHeldPanel\\(owner\\)\\) restoreOverlayState\\(\\);\\s*return;\\s*\\}" + cm +
    "if \\(isProjectSettingsOpen\\(\\)\\) \\{ closeProjectSettings\\(\\); return; \\}\\s*" +
    "if \\(isSettingsHubOpen\\(\\)\\) \\{ closeSettingsHub\\(\\); return; \\}\\s*" +
    "if \\(isSearchOpen\\(\\)\\) \\{ closeSearch\\(\\); return; \\}\\s*" +
    "if \\(isArchiveOpen\\(\\)\\) \\{ closeArchive\\(\\); return; \\}\\s*" +
    "if \\(isSchedulerOpen\\(\\)\\) \\{ closeScheduler\\(\\); return; \\}\\s*return;\\s*\\}");
  assert.match(app, routing, "the whole popstate routing: own echo, the entry guard, a menu or the top dialog, the owner of the newest entry, then the legacy overlays (backGesture mirrors it)");
  assert.doesNotMatch(app, /isCommandPaletteOpen|isUserSettingsOpen|closeUserSettings|isSettingsOpen\(\)|closeSettings\(\)/, "and no longer names the panels it moved");
});

test("C3a css: .confirm-backdrop and .confirm-dialog exist in no stylesheet, markup or module, and the moved dialogs keep no scrim, card, position or layer of their own", function () {
  var gone = /confirm-backdrop|confirm-dialog/;
  fs.readdirSync(CSS_DIR).filter(function (f) { return /\.css$/.test(f); }).forEach(function (f) {
    assert.doesNotMatch(css(f), gone, f);
  });
  assert.doesNotMatch(INDEX_HTML, gone, "index.html");
  assert.doesNotMatch(publicFile("app.js"), gone, "app.js");
  fs.readdirSync(path.join(PUBLIC_DIR, "modules")).filter(function (f) { return /\.js$/.test(f); }).forEach(function (f) {
    assert.doesNotMatch(publicFile(path.join("modules", f)), gone, f);
  });
  // (user settings' .us-modal keeps its own look, sized for the panel; it is the panel's dialog)
  var DIALOGS = [
    [".ralph-wizard-card", "loop.css"], [".ralph-preview-dialog", "loop.css"], [".sched-delete-dialog", "scheduler-modal.css"],
  ];
  WIDTHS.forEach(function (width) {
    DIALOGS.forEach(function (row) {
      ["position", "z-index", "box-shadow", "inset"].forEach(function (prop) {
        assert.equal(cssRules.valueAt(css(row[1]), row[0], prop, width), null, row[0] + " keeps no own " + prop + " at " + width + "px");
      });
    });
    ["#user-settings", "#ralph-wizard", "#ralph-preview-modal", "#sched-delete-dialog"].forEach(function (id) {
      ["position", "z-index", "inset"].forEach(function (prop) {
        ["user-settings.css", "loop.css", "scheduler-modal.css"].forEach(function (file) {
          assert.equal(cssRules.valueAt(css(file), id, prop, width), null, id + " keeps no own " + prop + " in " + file);
        });
      });
    });
  });
  var GONE_SELECTORS = [".ralph-wizard-backdrop", "#ralph-wizard", "#ralph-preview-modal", ".sched-delete-dialog-backdrop", ".us-modal-close", ".server-settings-close-col", ".cmd-palette-kbd", ".cmd-palette", ".cmd-palette.hidden"];
  fs.readdirSync(CSS_DIR).filter(function (f) { return /\.css$/.test(f); }).forEach(function (file) {
    cssRules.rules(css(file)).forEach(function (r) {
      r.selector.split(",").map(function (s) { return s.trim(); }).forEach(function (sel) {
        assert.equal(GONE_SELECTORS.indexOf(sel), -1, file + ": " + sel + " is gone");
      });
    });
  });
});

// The literals the C3a surfaces owned, and the token each took (400 is --z-modal;
// the Settings list is a panel's layer; the dropdown and the panel's own Jump to
// setting palette are menu-like popups).
var C3A_TOKENS = [
  { file: "command-palette.css", selector: ".project-switcher", was: 400, want: "var(--z-modal)" },
  { file: "playbook.css", selector: ".playbook-overlay", was: 400, want: "var(--z-modal)" },
  { file: "loop.css", selector: "#ralph-exec-modal", was: 310, want: "var(--z-modal)" },
  { file: "server-settings.css", selector: ".settings-palette", was: 650, want: "var(--z-menu)" },
  { file: "settings-nav.css", selector: "#settings-hub", was: 260, want: "var(--z-panel)", width: PHONE },
  // Project settings is opened from the list and stays under nothing it opens: one above it.
  { file: "filebrowser.css", selector: "#project-settings", was: 300, want: "calc(var(--z-panel) + 1)", width: PHONE },
  // The panel option's layer, the one assertion of it: numbered like the modals, over both legacy panels.
  { file: "overlay.css", selector: ".overlay-modal.overlay-panel", was: 399, want: "calc(var(--z-panel) + 2 + var(--overlay-order, 0))" },
];

test("C3a tokens: each literal the C3a surfaces owned is a layer token, and its scale value is where the literal sat or the surface moved onto the shared layer", function () {
  C3A_TOKENS.forEach(function (row) {
    assert.equal(cssRules.valueAt(css(row.file), row.selector, "z-index", row.width || DESKTOP), row.want, row.file + ": " + row.selector + " (was " + row.was + ")");
  });
  // Where the value is kept it is kept exactly: 400 is the modal layer.
  assert.equal(layer("modal"), 400);
  // The moved ralph and scheduler dialogs, and the panels, are on the shared layers (overlay.css).
  assert.equal(cssRules.valueAt(OVERLAY, ".overlay-modal", "z-index", DESKTOP), "calc(var(--z-modal) + var(--overlay-order, 0))");
  // The scheduler's create-interval dropdown (was 1200) was unreferenced and is removed, not mapped.
  fs.readdirSync(CSS_DIR).filter(function (f) { return /\.css$/.test(f); }).forEach(function (f) {
    assert.doesNotMatch(css(f), /sched-create-interval-dropdown/, f);
  });
});

// ---------------------------------------------------------------------------
// C3b: the remaining literals take tokens, two new layers, and a panel is never
// opened over a dialog
// ---------------------------------------------------------------------------

// The literal each C3b surface owned and the token it took. `width` is where the
// rule applies (a phone-only rule); `desktop: null` asserts it sets none above it.
var C3B_TOKENS = [
  { file: "tooltip.css", selector: ".tooltip", was: 10000, want: "var(--z-tooltip)" },
  { file: "icon-strip.css", selector: ".icon-strip-tooltip", was: 1000, want: "var(--z-tooltip)" },
  { file: "icon-strip.css", selector: ".dust-particle", was: 10000, want: "var(--z-tooltip)" },
  { file: "icon-strip.css", selector: ".dm-user-picker", was: 10001, want: "var(--z-menu)" },
  { file: "title-bar.css", selector: ".context-usage-popover", was: 200, want: "var(--z-menu)" },
  { file: "menus.css", selector: "#config-popover", was: 200, want: "var(--z-float)" },
  { file: "input.css", selector: "#context-sources-picker", was: 200, want: "var(--z-float)" },
  { file: "messages.css", selector: "#todo-sticky .todo-sticky-items", was: 200, want: "var(--z-float)" },
  { file: "sticky-notes.css", selector: ".sn-format-toolbar", was: 300, want: "var(--z-float)" },
  { file: "sticky-notes.css", selector: ".sticky-note", was: "100 + order", want: "calc(var(--z-note) + var(--note-order, 0))" },
  { file: "home-hub.css", selector: "#home-hub", was: 200, want: "var(--z-nav)" },
  { file: "filebrowser.css", selector: "#file-viewer", was: 300, want: "var(--z-screen)", width: PHONE, desktop: null },
  { file: "filebrowser.css", selector: "#terminal-container", was: 300, want: "var(--z-screen)", width: PHONE, desktop: null },
  { file: "input.css", selector: "#sidebar", was: 1000, want: "var(--z-sidebar)", width: PHONE, desktop: null },
  { file: "input.css", selector: "#sidebar-overlay", was: 999, want: "calc(var(--z-sidebar) - 1)", width: PHONE, desktop: null },
  { file: "overlays.css", selector: "#connect-overlay", was: 999, want: "var(--z-connect)" },
  { file: "messages.css", selector: ".remote-cursor", was: 9999, want: "var(--z-cursor)" },
];

test("C3b tokens: each remaining literal is a layer token at the width it applies, and a phone-only rule sets nothing above it", function () {
  C3B_TOKENS.forEach(function (row) {
    var at = row.file + ": " + row.selector + " (was " + row.was + ")";
    assert.equal(cssRules.valueAt(css(row.file), row.selector, "z-index", row.width || DESKTOP), row.want, at);
    if (row.desktop === null) assert.equal(cssRules.valueAt(css(row.file), row.selector, "z-index", DESKTOP), null, at + " sets none at desktop width");
  });
});

test("C3b scale: the layers are in order, each new one sits where it is named, at each width", function () {
  // base < note band < nav < float < full-screen views < sidebar < panels < dialogs < connect < menus < toasts < tooltips
  var names = ["base", "note", "nav", "float", "screen", "sidebar", "panel", "modal", "connect", "menu", "toast", "tooltip"];
  for (var i = 1; i < names.length; i++) {
    assert.ok(layer(names[i - 1]) < layer(names[i]), "--z-" + names[i - 1] + " (" + layer(names[i - 1]) + ") < --z-" + names[i] + " (" + layer(names[i]) + ")");
  }
  assert.ok(layer("note") >= 100 && layer("note") + NOTE_ORDER_MAX_FOR_TEST < layer("nav"), "the whole note band is under the nav");
  assert.ok(layer("screen") < layer("sidebar") - 1, "the sidebar's scrim (one below it) is over the full-screen views");
  assert.ok(layer("sidebar") < layer("panel"), "a panel opened from the sidebar shows over it");
  assert.ok(layer("panel") + 2 + 40 < layer("modal") && layer("modal") + 99 < layer("connect"), "panels < dialogs < the connection cover");
  assert.ok(layer("cursor") < 100, "the cursor layer is local to #messages and outside the global order");
  // The new layers against the nav and the layers above, as the sheets draw them.
  WIDTHS.forEach(function (width) {
    var at = " at " + width + "px";
    var phone = width === PHONE;
    assert.equal(cssRules.valueAt(MOBILE_NAV, "#mobile-tab-bar", "z-index", width), phone ? "var(--z-nav)" : null, "the nav is on its layer on a phone only" + at);
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-modal.overlay-panel", "z-index", width), "calc(var(--z-panel) + 2 + var(--overlay-order, 0))", "panels" + at);
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-modal", "z-index", width), "calc(var(--z-modal) + var(--overlay-order, 0))", "dialogs" + at);
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-menu", "z-index", width), "var(--z-menu)", "menus" + at);
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-stack", "z-index", width), "var(--z-toast)", "toasts" + at);
    assert.equal(cssRules.valueAt(css("tooltip.css"), ".tooltip", "z-index", width), "var(--z-tooltip)", "tooltips" + at);
    assert.equal(cssRules.valueAt(css("sticky-notes.css"), ".sticky-note", "z-index", width), "calc(var(--z-note) + var(--note-order, 0))", "notes" + at);
  });
});

var NOTE_ORDER_MAX_FOR_TEST = 99;

var NOTE_ORDERS = [
  { name: "a fresh note", zIndex: 1, order: 1 },
  { name: "no counter", zIndex: undefined, order: 0 },
  { name: "a negative counter", zIndex: -5, order: 0 },
  { name: "a counter past the band", zIndex: 10001, order: 99 },
  { name: "the last order inside the band", zIndex: 99, order: 99 },
  { name: "not a number", zIndex: "x", order: 0 },
  { name: "a numeric string", zIndex: "7", order: 7 },
  { name: "a fraction", zIndex: 3.9, order: 3 },
];

test("C3b notes: a note's order is a whole number from 0 to 99, so the band stays under the nav", async function () {
  var mod = await import(dom.moduleUrl("note-order.js"));
  assert.equal(mod.NOTE_ORDER_MAX, NOTE_ORDER_MAX_FOR_TEST);
  NOTE_ORDERS.forEach(function (row) {
    assert.equal(mod.noteLayerOrder(row.zIndex), row.order, row.name);
  });
  var src = publicFile(path.join("modules", "sticky-notes.js"));
  assert.match(src, /setNoteOrder\(el, data\.zIndex\)/, "a new note takes its order through the clamp");
  assert.match(src, /setNoteOrder\(entry\.el, msg\.note\.zIndex\)/, "an updated note does too");
});

// Each row is a run of bring-to-front clicks (the server raises the clicked note's
// counter to one past the highest) over some notes.
var NOTE_CLICK_RUNS = [
  { name: "120 clicks across 4 notes", notes: 4, clicks: 120 },
  { name: "150 clicks across 101 notes", notes: 101, clicks: 150 },
];

test("C3b notes: past 99 clicks the last-clicked note is strictly on top and every order stays 0 to 99", async function () {
  var mod = await import(dom.moduleUrl("note-order.js"));
  NOTE_CLICK_RUNS.forEach(function (row) {
    var counters = [];
    for (var i = 0; i < row.notes; i++) counters.push(i + 1);
    var last = 0;
    for (var c = 0; c < row.clicks; c++) {
      last = (c * 7) % row.notes;
      counters[last] = counters.reduce(function (a, b) { return Math.max(a, b); }, 0) + 1;
    }
    var orders = mod.noteLayerOrders(counters);
    orders.forEach(function (o) { assert.ok(Number.isInteger(o) && o >= 0 && o <= 99, row.name + ": " + o + " is in 0..99"); });
    orders.forEach(function (o, i) {
      if (i !== last) assert.ok(o < orders[last], row.name + ": note " + i + " (" + o + ") is under the last-clicked (" + orders[last] + ")");
    });
  });
});

// A page with one dialog open, the way a surface opens it, and the panels' openers.
async function dialogOverPage(t) {
  var m = await panelBrowser(t, false);
  // The registry's Escape listener is already collected by modalBrowser; this adds
  // the page's own (the palette's Ctrl+K) beside it and lets a row press a key.
  var listeners = {};
  var collect = global.document.addEventListener;
  global.document.addEventListener = function (type, fn) {
    collect(type, fn);
    (listeners[type] = listeners[type] || []).push(fn);
  };
  m.key = function (init) {
    (listeners.keydown || []).slice().forEach(function (fn) { fn(Object.assign({ preventDefault: function () {}, target: { tagName: "BODY" } }, init)); });
  };
  return m;
}

// The palette builds its markup through innerHTML, which the fake DOM keeps as
// text; the one node it builds is handed the parts the palette looks up.
function teachPaletteMarkup() {
  var create = global.document.createElement;
  global.document.createElement = function (tag) {
    var el = create(tag);
    Object.defineProperty(el, "innerHTML", {
      configurable: true,
      get: function () { return this._text; },
      set: function (v) {
        this._children = [];
        this._text = "";
        if (String(v).indexOf("cmd-palette-input") === -1) { this._text = String(v); return; }
        var part = function (cls, parent) { var n = create("div"); n.className = cls; parent.appendChild(n); return n; };
        part("overlay-modal-backdrop", this);
        var dialog = part("overlay-modal-dialog cmd-palette-dialog", this);
        var row = part("cmd-palette-input-row", dialog);
        var input = create("input");
        input.className = "cmd-palette-input";
        row.appendChild(input);
        part("cmd-palette-results", dialog);
        part("cmd-palette-footer", dialog);
      },
    });
    return el;
  };
}

test("C3b panel over a dialog: Ctrl+K with a dialog open opens nothing, and with none open opens the palette; back and Escape reach only the dialog", async function (t) {
  var m = await dialogOverPage(t);
  global.fetch = function () { return Promise.reject(new Error("offline")); };
  teachPaletteMarkup();
  var palette = await import(dom.moduleUrl("command-palette.js") + "?c3b=" + (++instance));
  palette.initCommandPalette({ currentSlug: function () { return "proj-a"; } });
  var ctrlK = { key: "k", ctrlKey: true };

  m.modals.showConfirm("Sure?", function () {});
  var dialog = m.top();
  m.key(ctrlK);
  assert.equal(palette.isCommandPaletteOpen(), false, "Ctrl+K opens no palette over a dialog");
  assert.equal(m.top(), dialog, "the dialog is still the top, and the only, modal");
  assert.equal(m.history.push, 0, "the refused palette holds no history entry for a back to find");
  assert.equal(m.historyMod.hasOverlayState(), false, "nothing is left for a back swipe to close behind the dialog");
  m.escape();
  assert.equal(m.registry.isModalOpen(dialog), false, "Escape closes the dialog, the thing on top");
  assert.equal(m.registry.getTopModal(), null, "and no hidden palette is left under it");

  m.key(ctrlK);
  assert.equal(palette.isCommandPaletteOpen(), true, "with no dialog open, Ctrl+K opens the palette");
  assert.equal(m.history.push, 1, "and it holds its entry");
  m.modals.showConfirm("Sure?", function () {});
  var over = m.top();
  assert.notEqual(over, undefined);
  assert.equal(backGesture(m), "blocking", "a dialog opened over the palette is what back closes first");
  assert.equal(palette.isCommandPaletteOpen(), true, "the palette stays");
  assert.equal(backGesture(m), "panel", "then back closes the palette");
});

test("C3b input list under a panel: the slash list open, then Ctrl+K, closes the list, opens the palette, and one Escape closes the palette", async function (t) {
  var m = await dialogOverPage(t);
  global.fetch = function () { return Promise.reject(new Error("offline")); };
  teachPaletteMarkup();
  var palette = await import(dom.moduleUrl("command-palette.js") + "?c3b=" + (++instance));
  palette.initCommandPalette({ currentSlug: function () { return "proj-a"; } });
  var list = await INPUT_LISTS[1].build(++listInstance);

  list.open();
  assert.equal(list.visible(), true, "the slash list is open");
  m.key({ key: "k", ctrlKey: true });
  assert.equal(list.visible(), false, "Ctrl+K closed the list");
  assert.equal(palette.isCommandPaletteOpen(), true, "and the palette is open");
  assert.equal(m.registry.getOpenMenu(), null, "no list is left in the registry above it");
  m.escape();
  assert.equal(palette.isCommandPaletteOpen(), false, "one Escape closes the palette");
  assert.equal(m.registry.getTopModal(), null, "and nothing is left open");
});

test("C3b panel over a dialog: the update_available route, by banner click or push, opens nothing over a dialog, and opens server settings with none", async function (t) {
  var m = await dialogOverPage(t);
  var page = { me: true };
  global.fetch = function (url) {
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve(url === "/api/me" ? { user: { role: page.me ? "admin" : "user" } } : {}); } });
  };
  var root = new dom.FakeElement("div");
  root.id = "server-settings";
  root.className = "hidden";
  var dlg = new dom.FakeElement("div");
  dlg.className = "overlay-modal-dialog";
  root.appendChild(dlg);
  var gear = new dom.FakeElement("button");
  gear.id = "server-settings-btn";
  global.document.body.appendChild(root);
  global.document.body.appendChild(gear);
  var settings = await import(dom.moduleUrl("server-settings.js") + "?c3b=" + (++instance));
  settings.initServerSettings({ ws: null });
  var notifyClient = await import(dom.moduleUrl("notify-client.js"));

  m.modals.showConfirm("Sure?", function () {});
  var dialog = m.top();
  assert.equal(await settings.openServerSettings(), false, "the one way into server settings resolves false over a dialog");
  m.b.notif.handleNotificationCreated(banner("u1", { type: "update_available", persistent: true, meta: { version: "9.9.9" } }));
  var card = m.b.stack().querySelector('.notif-banner[data-notif-id="u1"]');
  (card._listeners.click || []).forEach(function (fn) { fn({ target: { closest: function () { return null; } } }); });
  notifyClient.routeTo({ slug: null, sessionId: null }, "update_available");
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.equal(settings.isSettingsOpen(), false, "a click on the banner and a push tap open no panel under the scrim");
  assert.equal(root.classList.contains("hidden"), true, "its node stays hidden");
  assert.equal(m.top(), dialog, "the dialog is the only modal");
  assert.equal(gear.classList.contains("active"), false, "the gear does not show it open");
  assert.equal(m.history.push, 0, "and it holds no history entry");
  m.escape();
  assert.equal(m.registry.getTopModal(), null, "Escape closes the dialog and finds no hidden panel after it");
});

test("C3b panel over a dialog: a page opener reached by keyboard focus opens nothing over a dialog; the rule is the registry's, for each panel and for a sheet", async function (t) {
  global.fetch = function () { return Promise.reject(new Error("offline")); };
  var rows = [
    { name: "a dialog", open: function (m) { m.modals.showConfirm("Sure?", function () {}); } },
    { name: "a sheet", open: function (m) { m.actionSheet.showActionSheet({ actions: [{ icon: "settings", label: "x", handler: function () {} }] }); } },
    { name: "a dialog that cannot be dismissed", open: function (m) { m.overlay.showOverlay({ kind: "modal", content: "pin", dismissible: false }); } },
  ];
  for (var i = 0; i < rows.length; i++) {
    var m = await panelBrowser(t, true);
    var page = userSettingsPage();
    var mod = await import(dom.moduleUrl("user-settings.js") + "?c3b=" + (++instance));
    mod.initUserSettings({});
    rows[i].open(m);
    var below = m.top();
    page.btn.click();
    assert.equal(mod.isUserSettingsOpen(), false, rows[i].name + ": the gear opens nothing over it");
    assert.equal(page.btn.classList.contains("active"), false, rows[i].name + ": and does not show itself open");
    assert.equal(page.root.classList.contains("hidden"), true, rows[i].name + ": the panel stays hidden");
    assert.equal(m.history.push, 0, rows[i].name + ": a phone holds no entry for it");
    assert.equal(m.top(), below, rows[i].name + ": the dialog is still on top");
    var refused = m.overlay.showOverlay({ kind: "modal", panel: true, content: "p" });
    assert.equal(refused.refused, true, rows[i].name + ": the primitive says it refused");
    assert.equal(refused.isOpen(), false);
    assert.doesNotThrow(function () { refused.close(); });
    // A panel already open is not refused: opened again it is refreshed in place.
    m.registry.closeModal(below, { immediate: true });
    var panel = m.overlay.showOverlay({ kind: "modal", panel: true, content: "p" });
    assert.equal(panel.isOpen(), true, rows[i].name + ": with the dialog gone a panel opens");
    m.overlay.showOverlay({ kind: "modal", panel: true, el: panel.el });
    assert.equal(panel.isOpen(), true, rows[i].name + ": an open panel re-opened stays open");
    panel.close();
    while (m.historyMod.hasOverlayState()) m.historyMod.popOverlayState();
    while (m.historyMod.consumeOwnPopstate()) { /* delivered */ }
  }
});

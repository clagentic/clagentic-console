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

test("stylesheet: the layer scale is ordered and the stack takes its layer from it", function () {
  var root = cssRules.rules(BASE).filter(function (r) { return r.selector === ":root" && /--z-base/.test(r.body); })[0];
  assert.ok(root, "the scale is declared on :root");
  var order = ["base", "menu", "modal", "toast", "tooltip"].map(function (name) {
    return Number(new RegExp("--z-" + name + ":\\s*(\\d+)").exec(root.body)[1]);
  });
  assert.deepEqual(order.slice().sort(function (a, b) { return a - b; }), order, "base < menu < modal < toast < tooltip");
  assert.equal(cssRules.valueAt(OVERLAY, ".overlay-stack", "z-index", DESKTOP), "var(--z-toast)");
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

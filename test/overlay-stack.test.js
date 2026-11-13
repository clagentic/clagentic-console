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

WIDTHS.forEach(function (width) {
  test("a diagnostic toast, a banner, a plain toast and the reload banner share one in-flow column at " + width + "px", async function (t) {
    var b = await browser(t);
    ["diagnostic toast", "notification banner", "plain toast", "reload banner, build guard"].forEach(function (name) {
      SURFACES.filter(function (s) { return s.name === name; })[0].raise(b);
    });

    var cards = b.stack().children;
    assert.equal(cards.length, 4, "all four are children of the one stack");
    cards.forEach(function (card) {
      assert.ok(card.classList.contains("overlay"), "each is the shared card");
      assert.deepEqual(Object.keys(card.style), [], "no card places itself with an inline style");
    });
    assert.equal(global.document.body.querySelectorAll(".overlay-stack").length, 1, "one stack, not one per surface");

    // The stack is a fixed flex column; its children are in flow, so heights add
    // up and no two boxes intersect.
    var all = BASE + OVERLAY + DIAGNOSTICS + NOTIFICATIONS;
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-stack", "position", width), "fixed");
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-stack", "display", width), "flex");
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-stack", "flex-direction", width), "column");
    assert.ok(cssRules.valueAt(OVERLAY, ".overlay-stack", "gap", width), "cards are separated by a gap");
    cards.forEach(function (card) {
      card.className.split(/\s+/).forEach(function (cls) {
        var position = cssRules.valueAt(all, "." + cls, "position", width);
        assert.ok(position === null || position === "relative", "." + cls + " is in flow at " + width + "px, got " + position);
      });
    });
  });
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

SURFACES.forEach(function (row) {
  test("close control: " + row.name + (row.dismissible ? " has the shared control and Escape dismisses it" : " has none and ignores Escape"), async function (t) {
    var b = await browser(t);
    row.raise(b);
    var card = b.stack().querySelector(row.find);
    assert.ok(card, row.name + " is drawn in the stack");
    var closes = card.querySelectorAll(".overlay-close");
    if (!row.dismissible) {
      assert.equal(closes.length, 0, "no close control");
      escapeKey(card);
      assert.equal(card.classList.contains("hide"), false, "Escape leaves it");
      return;
    }
    assert.equal(closes.length, 1, "one close control");
    assert.equal(closes[0].tagName, "BUTTON");
    assert.ok(closes[0].getAttribute("aria-label"), "it is named for assistive tech");
    assert.equal(closes[0]._parent, card, "it is the card's own child, at the card's corner");
    escapeKey(card);
    assert.equal(card.classList.contains("hide"), true, "Escape dismisses");
  });
});

WIDTHS.forEach(function (width) {
  test("close control css: top-right, always visible, one rule at " + width + "px", function () {
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-close", "position", width), "absolute");
    assert.ok(cssRules.valueAt(OVERLAY, ".overlay-close", "top", width));
    assert.ok(cssRules.valueAt(OVERLAY, ".overlay-close", "right", width));
    assert.equal(cssRules.valueAt(OVERLAY, ".overlay-close", "left", width), null, "never the top-left corner");
    [OVERLAY, BASE, DIAGNOSTICS, NOTIFICATIONS].forEach(function (sheet) {
      cssRules.rules(sheet).filter(function (r) { return /(close|dismiss)/.test(r.selector) && /overlay|toast|banner/.test(r.selector); })
        .forEach(function (r) {
          assert.ok(!/opacity\s*:\s*0\s*(;|$)/.test(r.body), r.selector + " must not hide the control until hover");
        });
    });
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

[
  { name: "a plain toast keeps its 1500 ms window", level: undefined, ms: 1500 },
  { name: "a warn toast keeps its 5000 ms window", level: "warn", ms: 5000 },
  { name: "an error toast keeps its 5000 ms window", level: "error", ms: 5000 },
].forEach(function (row) {
  test("showToast: " + row.name, async function (t) {
    var b = await browser(t);
    assert.equal(b.utils.showToast.length, 3, "the signature is (message, level, detail)");
    b.utils.showToast("Saved", row.level, "first line\nsecond line");
    var card = b.stack().querySelector(".overlay-toast");
    assert.equal(card.getAttribute("data-severity"), row.level || null);
    assert.equal(card.querySelector(".overlay-detail").textContent, "first line");
    assert.deepEqual(Object.keys(card.querySelector(".overlay-detail").style), [], "the detail line has no inline style");
    t.mock.timers.tick(row.ms - 1);
    assert.equal(card.classList.contains("hide"), false);
    t.mock.timers.tick(1);
    assert.equal(card.classList.contains("hide"), true);
    t.mock.timers.tick(300);
    assert.equal(b.stack().querySelectorAll(".overlay-toast").length, 0);
  });
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

// boot-error-state.test.js
//
// A page whose module graph fails while loading or booting must show a
// distinct boot-error state (message plus a reload action), never the
// "Reconnecting to server…" overlay. The reconnect text belongs to an app that
// booted and whose socket then dropped.
//
// Two halves:
//   1. The watchdog (the classic inline script in lib/public/index.html) is
//      extracted and run in a vm with a small fake window/document, one table
//      row per failure shape: an import that throws, a module that fails to
//      parse, a missing module, an unhandled rejection, a graph that ends
//      without the boot-complete signal, and a normal boot.
//   2. The real app.js graph is loaded under Node's ESM loader with browser
//      stubs (same approach as app-boot-esm-graph-load-lr-4c58ae.test.js) to
//      prove it sets the boot-complete signal, that a socket drop after boot
//      still shows the reconnect text, and that app-connection.js never
//      overwrites a boot-error state.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var { pathToFileURL } = require("url");

var PUBLIC_DIR = path.join(__dirname, "..", "lib", "public");
var RECONNECT_TEXT = "Reconnecting to server";

function makeElement(id) {
  var attrs = {};
  var classes = new Set();
  var listeners = {};
  var el = {
    id: id,
    style: {},
    dataset: {},
    children: [],
    classes: classes,
    listeners: listeners,
    classList: {
      add: function () { for (var i = 0; i < arguments.length; i++) classes.add(arguments[i]); },
      remove: function () { for (var i = 0; i < arguments.length; i++) classes.delete(arguments[i]); },
      toggle: function (c, force) {
        var on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains: function (c) { return classes.has(c); },
    },
    getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    setAttribute: function (k, v) { attrs[k] = String(v); },
    removeAttribute: function (k) { delete attrs[k]; },
    hasAttribute: function (k) { return Object.prototype.hasOwnProperty.call(attrs, k); },
    addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: function () {},
    appendChild: function (c) { el.children.push(c); return c; },
    removeChild: function () {},
    insertBefore: function (c) { return c; },
    querySelector: function () { return makeElement(); },
    querySelectorAll: function () { return [makeElement()]; },
    closest: function () { return makeElement(); },
    focus: function () {}, blur: function () {}, click: function () {},
    scrollTo: function () {}, scrollIntoView: function () {}, remove: function () {},
    getBoundingClientRect: function () { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; },
    getContext: function () {
      return {
        clearRect: function () {}, drawImage: function () {}, fillRect: function () {},
        beginPath: function () {}, arc: function () {}, fill: function () {}, stroke: function () {},
        save: function () {}, restore: function () {}, translate: function () {},
        fillText: function () {}, measureText: function () { return { width: 0 }; },
      };
    },
    _text: "",
    _html: "",
  };
  Object.defineProperty(el, "textContent", {
    get: function () { return el._text; },
    set: function (v) { el._text = String(v); },
  });
  Object.defineProperty(el, "innerHTML", {
    get: function () { return el._html; },
    set: function (v) { el._html = v; },
  });
  Object.defineProperty(el, "parentElement", { get: function () { return el; } });
  return el;
}

function fire(target, type, event) {
  (target.listeners[type] || []).forEach(function (fn) { fn(event || {}); });
}

// Fake page for the watchdog: the overlay elements it touches, the module
// script element, and a window that records its own listeners.
function makeWatchdogPage() {
  var els = {};
  ["connect-overlay", "connect-overlay-msg", "connect-overlay-reload-btn",
   "connect-overlay-signin-btn", "app-module-script"].forEach(function (id) { els[id] = makeElement(id); });
  els["connect-overlay-msg"].textContent = "Loading Clagentic: Console…";
  els["connect-overlay-reload-btn"].classes.add("hidden");
  els["connect-overlay-signin-btn"].classes.add("hidden");
  var reloads = 0;
  var win = { listeners: {} };
  win.addEventListener = function (type, fn) { (win.listeners[type] = win.listeners[type] || []).push(fn); };
  var context = {
    document: { getElementById: function (id) { return els[id] || null; } },
    location: { reload: function () { reloads++; } },
  };
  context.window = Object.assign(win, context);
  vm.createContext(context);
  var html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  var m = /<script id="boot-watchdog">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "index.html must carry the boot-watchdog classic script");
  vm.runInContext(m[1], context);
  return { els: els, win: win, reloads: function () { return reloads; } };
}

var WATCHDOG_ROWS = [
  {
    name: "an import that throws during evaluation",
    run: function (p) {
      fire(p.win, "error", { message: "Uncaught Error: theme boom", error: new Error("theme boom") });
      fire(p.els["app-module-script"], "load");
    },
    shows: "theme boom",
  },
  {
    name: "a module that fails to parse",
    run: function (p) {
      fire(p.win, "error", { message: "x", error: new SyntaxError("Unexpected token '}'") });
      fire(p.els["app-module-script"], "load");
    },
    shows: "Unexpected token",
  },
  {
    name: "a missing module (404)",
    run: function (p) { fire(p.els["app-module-script"], "error"); },
    shows: "could not be loaded",
  },
  {
    name: "an unhandled rejection before boot completes",
    run: function (p) { fire(p.win, "unhandledrejection", { reason: new Error("init rejected") }); },
    shows: "init rejected",
  },
  {
    name: "a graph that ends without the boot-complete signal",
    run: function (p) { fire(p.els["app-module-script"], "load"); },
    shows: "did not finish starting",
  },
];

WATCHDOG_ROWS.forEach(function (row) {
  test("boot failure: " + row.name + " shows the boot-error state, not the reconnect overlay", function () {
    var p = makeWatchdogPage();
    row.run(p);
    var overlay = p.els["connect-overlay"];
    var msg = p.els["connect-overlay-msg"];
    var reload = p.els["connect-overlay-reload-btn"];
    assert.equal(overlay.getAttribute("data-state"), "boot-error");
    assert.equal(overlay.classList.contains("hidden"), false, "overlay must be visible");
    assert.ok(msg.textContent.indexOf("Clagentic: Console failed to start.") === 0, msg.textContent);
    assert.ok(msg.textContent.indexOf(row.shows) !== -1, "message names the failure: " + msg.textContent);
    assert.equal(msg.textContent.indexOf(RECONNECT_TEXT), -1, "no reconnect text");
    assert.equal(reload.classList.contains("hidden"), false, "reload action is shown");
    assert.equal(p.els["connect-overlay-signin-btn"].classList.contains("hidden"), true);
    fire(reload, "click");
    assert.equal(p.reloads(), 1, "the reload action reloads the page");
  });
});

test("normal boot: the signal set before the module load event leaves the overlay alone", function () {
  var p = makeWatchdogPage();
  p.win.__clagenticConsoleBooted = true;
  fire(p.els["app-module-script"], "load");
  // An error after boot is the app's own business, not a boot failure.
  fire(p.win, "error", { message: "late", error: new Error("late") });
  fire(p.win, "unhandledrejection", { reason: new Error("late") });
  assert.equal(p.els["connect-overlay"].getAttribute("data-state"), null);
  assert.equal(p.els["connect-overlay-msg"].textContent, "Loading Clagentic: Console…");
  assert.equal(p.els["connect-overlay-reload-btn"].classList.contains("hidden"), true);
});

test("the first boot failure wins; later events do not rewrite the message", function () {
  var p = makeWatchdogPage();
  fire(p.win, "error", { error: new Error("root cause") });
  fire(p.els["app-module-script"], "load");
  assert.ok(p.els["connect-overlay-msg"].textContent.indexOf("root cause") !== -1);
});

// --- Real module graph -------------------------------------------------

function installBrowserGlobals(els) {
  function byId(id) { return els[id] || (els[id] = makeElement(id)); }
  var fakeDocument = {
    getElementById: byId,
    querySelector: function () { return makeElement(); },
    querySelectorAll: function () { return [makeElement()]; },
    createElement: function () { return makeElement(); },
    addEventListener: function () {},
    removeEventListener: function () {},
    body: makeElement(),
    documentElement: makeElement(),
    head: makeElement(),
    visibilityState: "visible",
    cookie: "",
    title: "",
  };
  global.document = fakeDocument;
  global.window = global;
  global.addEventListener = function () {};
  global.removeEventListener = function () {};
  global.dispatchEvent = function () {};
  global.location = { pathname: "/", hash: "", href: "http://localhost/", search: "", reload: function () {} };
  Object.defineProperty(global, "navigator", {
    value: {
      userAgent: "boot-error-state-probe",
      platform: "boot-error-state-probe",
      serviceWorker: undefined,
      clipboard: { writeText: function () { return Promise.resolve(); } },
      vibrate: function () {},
    },
    configurable: true,
  });
  global.localStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
  global.sessionStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
  // Opens asynchronously, like a real handshake, so connect()'s own timers
  // settle instead of rescheduling forever.
  global.WebSocket = function () {
    var sock = { send: function () {}, close: function () {}, onopen: null, onclose: null, onerror: null, onmessage: null };
    setTimeout(function () { if (typeof sock.onopen === "function") sock.onopen(); }, 0);
    return sock;
  };
  global.lucide = { createIcons: function () {} };
  global.marked = { parse: function (s) { return s; }, setOptions: function () {}, use: function () {} };
  global.mermaid = { initialize: function () {}, run: function () {} };
  global.requestAnimationFrame = function (fn) { return setTimeout(fn, 0); };
  global.cancelAnimationFrame = function () {};
  global.matchMedia = function () { return { matches: false, addListener: function () {}, addEventListener: function () {} }; };
  global.ResizeObserver = function () { return { observe: function () {}, disconnect: function () {} }; };
  global.IntersectionObserver = function () { return { observe: function () {}, disconnect: function () {} }; };
  global.fetch = function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); }, text: function () { return Promise.resolve(""); } }); };
  global.history = { pushState: function () {}, replaceState: function () {}, state: null };
  global.CustomEvent = function (type, opts) { this.type = type; Object.assign(this, opts || {}); };
  global.Image = function () { this.onload = null; this.onerror = null; };
  Object.defineProperty(global.Image.prototype, "src", { set: function () {} });
}

function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

test("after a normal boot the signal is set and a socket drop shows the reconnect text; a boot-error state is never overwritten", { timeout: 20000 }, async function () {
  var els = {};
  installBrowserGlobals(els);
  await import(pathToFileURL(path.join(PUBLIC_DIR, "app.js")).href);
  var conn = await import(pathToFileURL(path.join(PUBLIC_DIR, "modules", "app-connection.js")).href);
  var logo = await import(pathToFileURL(path.join(PUBLIC_DIR, "modules", "console-logo.js")).href);
  var overlay = els["connect-overlay"];
  var msg = els["connect-overlay-msg"];
  try {
    assert.equal(global.__clagenticConsoleBooted, true, "app.js sets the boot-complete signal");

    await wait(50);
    assert.equal(overlay.classList.contains("hidden"), true, "connected: overlay hidden");

    conn.setStatus("disconnected");
    await wait(700);
    assert.equal(overlay.classList.contains("hidden"), false, "drop after boot shows the overlay");
    assert.ok(msg.textContent.indexOf(RECONNECT_TEXT) === 0, "reconnect text: " + msg.textContent);
    assert.equal(overlay.getAttribute("data-state"), null);

    // A boot-error state set by the watchdog survives connection changes.
    overlay.setAttribute("data-state", "boot-error");
    msg.textContent = "Clagentic: Console failed to start. boom";
    overlay.classList.remove("hidden");
    conn.setStatus("connected");
    conn.setStatus("disconnected");
    await wait(700);
    assert.equal(msg.textContent, "Clagentic: Console failed to start. boom");
    assert.equal(overlay.classList.contains("hidden"), false);
  } finally {
    logo.stopLogoAnimation();
  }
});

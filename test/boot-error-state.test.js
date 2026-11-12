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
//      without the boot-complete signal, and a normal boot; plus the shapes
//      that must NOT count (cross-origin and extension errors) and the
//      recovery when the signal arrives after an earlier error.
//   2. The real app.js graph is loaded under Node's ESM loader with the shared
//      browser stub (test/browser-stub.js) to prove it sets the boot-complete
//      signal, that a socket drop after boot still shows the reconnect text,
//      and that app-connection.js never overwrites a boot-error state.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var { pathToFileURL } = require("url");
var stub = require("./browser-stub");

var makeElement = stub.makeElement;
var fire = stub.fire;

var PUBLIC_DIR = path.join(__dirname, "..", "lib", "public");
var RECONNECT_TEXT = "Reconnecting to server";
var PAGE_URL = "http://localhost/";
var OWN_SCRIPT = PAGE_URL + "modules/theme-colors.js";

// Fake page for the watchdog, built in document order like the parser does:
// the overlay elements exist first (index.html declares them earlier), the
// watchdog classic script runs next, and only then does the module script
// element appear. Resource events on that element do not bubble, so they reach
// only capture-phase window listeners; the window load event reaches all of them.
function makeWatchdogPage() {
  var els = {};
  ["connect-overlay", "connect-overlay-msg", "connect-overlay-reload-btn",
   "connect-overlay-signin-btn"].forEach(function (id) { els[id] = makeElement(id); });
  els["connect-overlay-msg"].textContent = "Loading Clagentic: Console…";
  els["connect-overlay-reload-btn"].classes.add("hidden");
  els["connect-overlay-signin-btn"].classes.add("hidden");
  var reloads = 0;
  var win = { listeners: {}, captureListeners: {} };
  win.addEventListener = function (type, fn, capture) {
    (win.listeners[type] = win.listeners[type] || []).push(fn);
    if (capture === true || (capture && capture.capture)) {
      (win.captureListeners[type] = win.captureListeners[type] || []).push(fn);
    }
  };
  var context = {
    document: { getElementById: function (id) { return els[id] || null; } },
    location: { href: PAGE_URL, reload: function () { reloads++; } },
  };
  context.window = Object.assign(win, context);
  vm.createContext(context);
  var html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  var m = /<script id="boot-watchdog">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "index.html must carry the boot-watchdog classic script");
  vm.runInContext(m[1], context);
  // The module script is parsed after the watchdog has run.
  els["app-module-script"] = makeElement("app-module-script");
  var script = els["app-module-script"];
  function resourceError(target) {
    (win.captureListeners.error || []).forEach(function (fn) { fn({ type: "error", target: target }); });
  }
  return {
    els: els,
    win: win,
    reloads: function () { return reloads; },
    // A failed fetch or link of the entry or any import: error on the script element.
    moduleError: function () { resourceError(script); },
    // Same event shape for any other element (a CDN script, an image).
    otherResourceError: function (id) { resourceError(makeElement(id)); },
    // The deferred module graph has finished running (or failing): window load.
    graphDone: function () { fire(win, "load", { type: "load", target: win }); },
  };
}

function ownError(message, err) {
  return { message: message, filename: OWN_SCRIPT, error: err };
}

var WATCHDOG_ROWS = [
  {
    name: "an import that throws during evaluation",
    run: function (p) {
      fire(p.win, "error", ownError("Uncaught Error: theme boom", new Error("theme boom")));
      p.graphDone();
    },
    shows: "theme boom",
  },
  {
    name: "a module that fails to parse",
    run: function (p) {
      fire(p.win, "error", ownError("x", new SyntaxError("Unexpected token '}'")));
      p.graphDone();
    },
    shows: "Unexpected token",
  },
  {
    name: "a missing module (404)",
    run: function (p) { p.moduleError(); },
    shows: "could not be loaded",
  },
  {
    name: "an unhandled rejection from the app's own scripts before boot completes",
    run: function (p) {
      var reason = new Error("init rejected");
      reason.stack = "Error: init rejected\n    at init (" + OWN_SCRIPT + ":3:1)";
      fire(p.win, "unhandledrejection", { reason: reason });
    },
    shows: "init rejected",
  },
  {
    name: "a graph that ends without the boot-complete signal",
    run: function (p) { p.graphDone(); },
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

// Errors that are not the app's: a CDN script (cross-origin errors arrive with
// no filename), an extension, a rejection that never passed through app code.
var IGNORED_ROWS = [
  {
    name: "a cross-origin script error",
    run: function (p) { fire(p.win, "error", { message: "Script error.", filename: "" }); },
  },
  {
    name: "an error from a CDN script",
    run: function (p) {
      fire(p.win, "error", {
        message: "mermaid boom",
        filename: "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js",
        error: new Error("mermaid boom"),
      });
    },
  },
  {
    name: "a CDN script element that failed to load",
    run: function (p) { p.otherResourceError("cdn-mermaid-script"); },
  },
  {
    name: "an error from a browser extension",
    run: function (p) {
      fire(p.win, "error", { message: "ext", filename: "chrome-extension://abc/content.js", error: new Error("ext") });
    },
  },
  {
    name: "a rejection raised outside the app's scripts",
    run: function (p) {
      var reason = new Error("cdn rejected");
      reason.stack = "Error: cdn rejected\n    at x (https://cdn.jsdelivr.net/npm/lucide.min.js:1:1)";
      fire(p.win, "unhandledrejection", { reason: reason });
    },
  },
];

IGNORED_ROWS.forEach(function (row) {
  test("not a boot failure: " + row.name + " during boot does not show boot-error", function () {
    var p = makeWatchdogPage();
    row.run(p);
    p.win.__clagenticConsoleBooted = true;
    p.graphDone();
    assert.equal(p.els["connect-overlay"].getAttribute("data-state"), null);
    assert.equal(p.els["connect-overlay-msg"].textContent, "Loading Clagentic: Console…");
    assert.equal(p.els["connect-overlay-reload-btn"].classList.contains("hidden"), true);
  });
});

test("an ignored cross-origin error does not hide a real failure that follows", function () {
  var p = makeWatchdogPage();
  fire(p.win, "error", { message: "Script error.", filename: "" });
  p.graphDone();
  assert.equal(p.els["connect-overlay"].getAttribute("data-state"), "boot-error");
});

test("an app error followed by the boot signal ends in the booted state", function () {
  var p = makeWatchdogPage();
  fire(p.win, "error", ownError("early", new Error("early")));
  assert.equal(p.els["connect-overlay"].getAttribute("data-state"), "boot-error");
  p.win.__clagenticConsoleBooted = true;
  var overlay = p.els["connect-overlay"];
  assert.equal(overlay.getAttribute("data-state"), null, "boot-error state cleared");
  assert.equal(p.els["connect-overlay-msg"].textContent, "Reconnecting to server…");
  assert.equal(p.els["connect-overlay-reload-btn"].classList.contains("hidden"), true);
  // The window load event after the signal must not bring the error back.
  p.graphDone();
  assert.equal(overlay.getAttribute("data-state"), null);
});

test("normal boot: the signal set before the module load event leaves the overlay alone", function () {
  var p = makeWatchdogPage();
  p.win.__clagenticConsoleBooted = true;
  p.graphDone();
  // An error after boot is the app's own business, not a boot failure.
  fire(p.win, "error", ownError("late", new Error("late")));
  fire(p.win, "unhandledrejection", { reason: new Error("late") });
  assert.equal(p.els["connect-overlay"].getAttribute("data-state"), null);
  assert.equal(p.els["connect-overlay-msg"].textContent, "Loading Clagentic: Console…");
  assert.equal(p.els["connect-overlay-reload-btn"].classList.contains("hidden"), true);
});

test("the first boot failure wins; later events do not rewrite the message", function () {
  var p = makeWatchdogPage();
  fire(p.win, "error", ownError("x", new Error("root cause")));
  p.graphDone();
  assert.ok(p.els["connect-overlay-msg"].textContent.indexOf("root cause") !== -1);
});

// --- Real module graph -------------------------------------------------

function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

test("after a normal boot the signal is set and a socket drop shows the reconnect text; a boot-error state is never overwritten", { timeout: 20000 }, async function () {
  var els = {};
  stub.installBrowserGlobals({ els: els, label: "boot-error-state-probe" });
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

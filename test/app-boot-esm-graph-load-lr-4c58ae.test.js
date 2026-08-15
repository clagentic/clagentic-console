// app-boot-esm-graph-load-lr-4c58ae.test.js
//
// Regression test for lr-4c58ae comment #2 (MILLER, fresh-context
// re-investigation): both desktop and mobile hung on "reconnecting to
// server" after a successful login. Root cause was a class-2 boot-halt —
// the app.js ES-module import graph threw a fatal error DURING LOAD,
// before connect() (lib/public/app.js:1041) ever ran, so the WebSocket was
// never opened and the connect-overlay's default "reconnecting" text never
// cleared. Same failure class as lr-8657
// (retro-console-reconnecting-stale-esm-import).
//
// ROOT CAUSE (this incident): app-messages.js and its domain modules
// (filebrowser.js, server-settings.js) form an ESM import cycle —
// app-messages.js imports from server-settings.js (for
// updateSsLiteVisibility etc.), and server-settings.js imports
// registerHandlers back from app-messages.js, calling it at server-settings.js's
// own module-body top level (lr-4e49 Part 2's registry conversion,
// aabd710). Depending on which module app.js's import graph reaches first,
// ESM's cycle-breaking semantics can run server-settings.js's top-level
// registerHandlers() call BEFORE app-messages.js's own `var handlers = {}`
// line has executed. registerHandlers is always safely callable (function
// declarations are hoisted at module instantiation), but the module-scope
// `handlers` object it wrote into was still unassigned — throwing
// "Cannot read properties of undefined (reading '<message-type>')" and
// halting the entire module graph before app.js:1041's connect() call.
// Fixed in app-messages.js by lazily initializing `handlers` inside
// registerHandlers() itself and guarding the top-level `var handlers = {}`
// so it cannot clobber registrations a circular caller already made.
//
// WHY EXISTING TESTS MISSED IT:
//   - app-messages-registry-completeness-lr-4e49.test.js statically
//     regex-parses registerHandlers({...}) call sites; it never executes
//     the module graph, so it cannot observe an evaluation-order throw.
//   - boot-smoke-lr-1a5f.test.js drives a Node `ws` client against the
//     server's WebSocket endpoint; it never loads lib/public/*.js in a JS
//     engine at all (see that file's own header comment, "What this test
//     does NOT prove"), so a broken client-side ESM import/eval-order bug
//     is invisible to it (PEACHES finding B4 on PR #224; MILLER filed
//     lr-ae85d5 for the guard itself).
//
// WHAT THIS TEST DOES: dynamically imports the REAL lib/public/app.js
// module graph under Node's native ESM loader (the same loader semantics —
// linking, circular-import cycle-breaking, module-body evaluation order —
// a browser's ES module loader implements), with a minimal DOM/browser
// global stub sufficient to let module-body top-level code execute without
// throwing for unrelated (jsdom-shaped) reasons. This exercises the exact
// class of failure lr-8657/lr-db24ec/this incident hit: a fatal throw
// during module load/link, which halts boot before connect() runs.
//
// This is intentionally NOT a full browser/Playwright test (heavier CI
// dependency, no headless Chromium available in this environment) — per
// lr-4c58ae's STEP 3 fallback: "at least add a static ESM-resolution check
// that every named import in the eagerly-loaded graph resolves to a real
// export." Node's own ESM loader IS that resolver: it throws
// SyntaxError "does not provide an export named X" for a bad named import,
// and executes real module-body code (surfacing ReferenceError for a used
// but undeclared identifier, and evaluation-order bugs like this one) —
// stronger guarantees than a hand-rolled regex parser would give.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var { pathToFileURL } = require("url");

var APP_JS_URL = pathToFileURL(
  path.join(__dirname, "..", "lib", "public", "app.js")
).href;

// Minimal DOM element stub — enough surface for module-top-level code
// (event listener wiring, class list toggles, canvas 2D context calls,
// etc.) across lib/public/*.js to execute without throwing for reasons
// unrelated to the module graph's own import/export/eval-order integrity.
function makeFakeElement() {
  var el = {
    style: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    dataset: {},
    children: [],
    attributes: {},
    addEventListener: function () {},
    removeEventListener: function () {},
    appendChild: function (c) { el.children.push(c); return c; },
    removeChild: function () {},
    insertBefore: function (c) { return c; },
    setAttribute: function () {},
    getAttribute: function () { return null; },
    removeAttribute: function () {},
    hasAttribute: function () { return false; },
    querySelector: function () { return makeFakeElement(); },
    querySelectorAll: function () { return [makeFakeElement()]; },
    closest: function () { return makeFakeElement(); },
    focus: function () {},
    blur: function () {},
    click: function () {},
    scrollTo: function () {},
    scrollIntoView: function () {},
    remove: function () {},
    getBoundingClientRect: function () {
      return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 };
    },
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
    set: function (v) { el._text = v; },
  });
  Object.defineProperty(el, "innerHTML", {
    get: function () { return el._html; },
    set: function (v) { el._html = v; },
  });
  Object.defineProperty(el, "parentElement", { get: function () { return el; } });
  return el;
}

// Records every WebSocket construction so the test can assert connect()
// (app.js:1041) actually ran as part of the module graph's top-level init
// sequence — the concrete symptom this incident fixes (onopen never
// firing because connect() was never reached).
var wsConstructions = [];

function installBrowserGlobals() {
  var fakeDocument = {
    getElementById: function () { return makeFakeElement(); },
    querySelector: function () { return makeFakeElement(); },
    querySelectorAll: function () { return [makeFakeElement()]; },
    createElement: function () { return makeFakeElement(); },
    addEventListener: function () {},
    removeEventListener: function () {},
    body: makeFakeElement(),
    documentElement: makeFakeElement(),
    head: makeFakeElement(),
    visibilityState: "visible",
    cookie: "",
    title: "",
  };

  global.document = fakeDocument;
  global.window = global;
  global.addEventListener = function () {};
  global.removeEventListener = function () {};
  global.dispatchEvent = function () {};
  global.location = { pathname: "/", hash: "", href: "http://localhost/", search: "" };
  Object.defineProperty(global, "navigator", {
    value: {
      userAgent: "node-esm-graph-probe",
      platform: "node-esm-graph-probe",
      serviceWorker: undefined,
      clipboard: { writeText: function () { return Promise.resolve(); } },
      vibrate: function () {},
    },
    configurable: true,
  });
  global.localStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
  global.sessionStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
  // lr-795882: a real browser WebSocket always eventually calls onopen,
  // onclose, or onerror. This stub previously never called any of them, so
  // app-connection.js's connect()->openSocket() 3s "not connected yet" watchdog
  // (connectTimeoutId, app-connection.js:297) never got cleared by a real
  // onopen — it fired, tore the socket down, and called connect() again,
  // which built a NEW real 3s Node timer, forever. Under `node --test`
  // (no --test-force-exit) that unbounded setTimeout chain kept the process
  // event loop alive indefinitely, and under --test-force-exit it silently
  // truncated later test files in the same run instead of ever completing.
  // Firing onopen asynchronously mirrors a real successful handshake, which
  // reaches connect()'s real terminal state and clears its own timer via the
  // production onopen handler — no test-side timer bookkeeping needed.
  // lr-795882: a real browser WebSocket always eventually calls onopen,
  // onclose, or onerror. This stub previously never called any of them, so
  // app-connection.js's connect()->openSocket() 3s "not connected yet" watchdog
  // (connectTimeoutId, app-connection.js:297) never got cleared by a real
  // onopen — it fired, tore the socket down, and called connect() again,
  // which built a NEW real 3s Node timer, forever. Under `node --test`
  // (no --test-force-exit) that unbounded setTimeout chain kept the process
  // event loop alive indefinitely, and under --test-force-exit it silently
  // truncated later test files in the same run instead of ever completing.
  // Firing onopen asynchronously mirrors a real successful handshake, which
  // reaches connect()'s real terminal state and clears its own timer via the
  // production onopen handler — no test-side timer bookkeeping needed.
  global.WebSocket = function (url, protocols) {
    var sock = {
      send: function () {},
      close: function () {},
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
    };
    wsConstructions.push({ url: url, protocols: protocols });
    setTimeout(function () {
      if (typeof sock.onopen === "function") sock.onopen();
    }, 0);
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

test("app.js's real ESM module graph loads and links without throwing (lr-4c58ae boot-halt regression)", { timeout: 15000 }, function () {
  installBrowserGlobals();
  wsConstructions.length = 0;

  return import(APP_JS_URL).then(
    function () {
      // Loaded cleanly — the entire eagerly-loaded import graph (~80
      // modules under lib/public/modules/) linked and every module's
      // top-level body executed without throwing.
      assert.ok(true, "app.js module graph loaded without a fatal error");
    },
    function (err) {
      assert.fail(
        "app.js's ESM module graph failed to load — this is exactly the class of " +
        "failure that hangs both desktop and mobile on 'reconnecting to server' " +
        "(connect() at app.js:1041 is never reached). " +
        "Error: " + err.constructor.name + ": " + err.message
      );
    }
  );
});

test("connect() runs as part of app.js's top-level init sequence (WebSocket is constructed)", function () {
  // This depends on the previous test having already imported app.js —
  // Node's module cache means a second dynamic import() of the same URL
  // resolves to the already-evaluated module without re-running the body,
  // so this assertion reads the wsConstructions state captured during the
  // first test's load.
  assert.ok(
    wsConstructions.length > 0,
    "connect() (app.js:1041) never constructed a WebSocket — module graph " +
    "loaded but boot did not reach the connection step"
  );
});

// Regression test for lr-795882: the fake WebSocket used to load app.js's
// module graph above must resolve to a real terminal FSM state (connected),
// not leave a live reconnect watchdog running. Before the fix, this file
// left an unbounded self-rescheduling setTimeout chain
// (app-connection.js:297's connectTimeoutId) running forever because the
// fake WebSocket never called onopen/onclose/onerror — silently truncating
// whatever test file happened to run after this one under
// --test-force-exit, and hanging `node --test` outright without it.
//
// `store` is the same singleton app.js's own connect() call reads/writes —
// asserting through it (rather than reaching into app-connection.js's
// private connectTimeoutId closure variable) verifies the *effect* that
// actually matters: the connection FSM reached a settled state and stopped
// scheduling new watchdog timers, using only the module's public surface.
test("connect()'s FSM reaches a settled connected state (no leaked reconnect watchdog, lr-795882)", async function () {
  var storeModule = await import(pathToFileURL(
    path.join(__dirname, "..", "lib", "public", "modules", "store.js")
  ).href);
  // The fake WebSocket's onopen fires via a real setTimeout(fn, 0) queued
  // during app.js's module-load (see installBrowserGlobals above); yield to
  // the event loop so that macrotask has a chance to run before asserting.
  await new Promise(function (resolve) { setTimeout(resolve, 50); });
  assert.equal(
    storeModule.store.get("connected"), true,
    "app.js's connect() FSM must reach 'connected' once the stubbed WebSocket " +
    "opens — if this is false, the 3s connectTimeoutId watchdog in " +
    "app-connection.js is still armed and will keep rescheduling itself " +
    "(the exact leak lr-795882 fixed)"
  );
});

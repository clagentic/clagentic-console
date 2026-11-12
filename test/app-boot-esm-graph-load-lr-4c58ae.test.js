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
// a browser's ES module loader implements), with the shared browser stub
// (test/browser-stub.js) sufficient to let module-body top-level code execute
// without throwing for unrelated (jsdom-shaped) reasons. This exercises the
// exact class of failure lr-8657/lr-db24ec/this incident hit: a fatal throw
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
var { installBrowserGlobals } = require("./browser-stub");

var APP_JS_URL = pathToFileURL(
  path.join(__dirname, "..", "lib", "public", "app.js")
).href;

// Records every WebSocket construction so the test can assert connect()
// (app.js:1041) actually ran as part of the module graph's top-level init
// sequence — the concrete symptom this incident fixes (onopen never
// firing because connect() was never reached).
var wsConstructions = [];

test("app.js's real ESM module graph loads and links without throwing (lr-4c58ae boot-halt regression)", { timeout: 15000 }, function () {
  installBrowserGlobals({
    label: "node-esm-graph-probe",
    onSocket: function (url, protocols) { wsConstructions.push({ url: url, protocols: protocols }); },
  });
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
  // during app.js's module-load (see the shared stub); yield to
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

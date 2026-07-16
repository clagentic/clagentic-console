// pwa-stale-sw-reconnect-lr-e0ec47.test.js — regression coverage for lr-e0ec47,
// mobile PWA stuck on "reconnecting to server" after a deploy because the
// service worker was registered once and never proactively updated, and the
// activate-time cache lifecycle had an empty-cache window.
//
// The touched modules (notifications.js, sw.js, app-connection.js,
// command-palette.js) are ESM/plain-JS files with heavy DOM/SW/WS
// dependencies that this project's test runner does not exercise via a DOM
// or service-worker harness (see frontend-state-correlation-lr-fb49.test.js
// for the established convention) — these are source-text regression checks
// asserting the fix is present.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

function readMod(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

var NOTIFICATIONS_JS = readMod("lib/public/modules/notifications.js");
var SW_JS = readMod("lib/public/sw.js");
var APP_CONNECTION_JS = readMod("lib/public/modules/app-connection.js");
var COMMAND_PALETTE_JS = readMod("lib/public/modules/command-palette.js");

// ---------------------------------------------------------------------------
// 1 — notifications.js: reg.update() on register and on foreground
// ---------------------------------------------------------------------------

test("notifications.js: initServiceWorker calls reg.update() immediately after register()", function () {
  var idx = NOTIFICATIONS_JS.indexOf('navigator.serviceWorker.register("/sw.js")');
  assert.ok(idx !== -1, "expected the SW registration call to still exist");
  var block = NOTIFICATIONS_JS.slice(idx, idx + 700);
  assert.match(
    block,
    /reg\.update\(\)\.catch\(function\s*\(\)\s*\{\}\);/,
    "registering the SW must trigger an immediate reg.update() so a foregrounded PWA " +
    "re-checks the no-cache sw.js for a post-deploy change (lr-e0ec47)"
  );
});

test("notifications.js: initServiceWorker re-checks for updates on visibilitychange and pageshow", function () {
  var idx = NOTIFICATIONS_JS.indexOf('navigator.serviceWorker.register("/sw.js")');
  assert.ok(idx !== -1);
  var block = NOTIFICATIONS_JS.slice(idx, idx + 1200);

  assert.match(
    block,
    /document\.addEventListener\("visibilitychange",\s*function\s*\(\)\s*\{\s*if\s*\(document\.visibilityState === "visible"\)\s*reg\.update\(\)\.catch\(function\s*\(\)\s*\{\}\);\s*\}\);/,
    "expected a visibilitychange listener that calls reg.update() when the PWA becomes visible"
  );
  assert.match(
    block,
    /window\.addEventListener\("pageshow",\s*function\s*\(\)\s*\{\s*reg\.update\(\)\.catch\(function\s*\(\)\s*\{\}\);\s*\}\);/,
    "expected a pageshow listener that calls reg.update() (covers bfcache restores on mobile)"
  );
});

// ---------------------------------------------------------------------------
// 2 — app-connection.js + command-palette.js: stale-version watchdog
// ---------------------------------------------------------------------------

test("command-palette.js: exposes a read-only getPaletteVersion accessor for the cached running version", function () {
  assert.match(
    COMMAND_PALETTE_JS,
    /export function getPaletteVersion\(\)\s*\{\s*return cachedVersion;\s*\}/,
    "expected getPaletteVersion() to expose the version cached from the WS 'info' handshake"
  );
});

test("app-connection.js: scheduleReconnect parses /info JSON and feeds it to the stale-version watchdog", function () {
  var idx = APP_CONNECTION_JS.indexOf("export function scheduleReconnect()");
  assert.ok(idx !== -1);
  var block = APP_CONNECTION_JS.slice(idx, idx + 900);

  assert.match(block, /fetch\("\/info"\)/, "must still preflight /info on reconnect");
  assert.match(
    block,
    /res\.json\(\)\.catch\(function\s*\(\)\s*\{\s*return null;\s*\}\)/,
    "must parse the /info response body to read the served version"
  );
  assert.match(
    block,
    /checkStaleVersion\(info\);/,
    "must hand the parsed /info payload to the stale-version watchdog"
  );
});

test("app-connection.js: checkStaleVersion only reloads after a sustained version mismatch while disconnected", function () {
  var idx = APP_CONNECTION_JS.indexOf("function checkStaleVersion(info)");
  assert.ok(idx !== -1, "expected a checkStaleVersion helper");
  var block = APP_CONNECTION_JS.slice(idx, idx + 900);

  assert.match(
    block,
    /if\s*\(store\.get\('connected'\)\)\s*\{\s*staleVersionStreak = 0;\s*return;\s*\}/,
    "must bail out (and reset the streak) once reconnected — the watchdog only fires while disconnected"
  );
  assert.match(
    block,
    /servedVersion\s*===\s*runningVersion/,
    "must compare the /info-served version against the client's own running version"
  );
  assert.match(
    block,
    /staleVersionStreak\+\+;/,
    "must accumulate a streak rather than reloading on the first mismatch (avoids reloading on a single transient /info hiccup)"
  );
  assert.match(
    block,
    /if\s*\(staleVersionStreak >= STALE_VERSION_THRESHOLD\)\s*\{\s*location\.reload\(\);\s*\}/,
    "must force a reload once the mismatch persists past the threshold"
  );
});

test("app-connection.js: the reconnect-success paths (onopen and onmessage) reset the stale-version streak", function () {
  var openIdx = APP_CONNECTION_JS.indexOf("newWs.onopen = function ()");
  assert.ok(openIdx !== -1);
  var openBlock = APP_CONNECTION_JS.slice(openIdx, openIdx + 300);
  assert.match(openBlock, /staleVersionStreak = 0;/, "onopen must reset staleVersionStreak so a successful reconnect clears the watchdog");

  var msgIdx = APP_CONNECTION_JS.indexOf("newWs.onmessage = function (event)");
  assert.ok(msgIdx !== -1);
  var msgBlock = APP_CONNECTION_JS.slice(msgIdx, msgIdx + 400);
  assert.match(msgBlock, /staleVersionStreak = 0;/, "the onmessage 'backup connected' path must also reset staleVersionStreak");
});

// ---------------------------------------------------------------------------
// 3 — sw.js: no empty-cache window between activate and first fetch
// ---------------------------------------------------------------------------

test("sw.js: install pre-caches the app shell before skipWaiting so the new cache is never empty at activate", function () {
  assert.match(
    SW_JS,
    /var SHELL_URLS = \[.*"\/index\.html".*\];/,
    "expected a SHELL_URLS list including /index.html"
  );

  var idx = SW_JS.indexOf('self.addEventListener("install"');
  assert.ok(idx !== -1);
  var block = SW_JS.slice(idx, idx + 600);

  assert.match(
    block,
    /caches\.open\(CACHE_NAME\)\.then\(function\s*\(cache\)\s*\{\s*return cache\.addAll\(SHELL_URLS\)/,
    "install must pre-cache SHELL_URLS into the new CACHE_NAME before skipWaiting, otherwise an offline client " +
    "caught between activate (old cache deleted) and the first network fetch gets only the minimal placeholder shell"
  );
  assert.match(block, /self\.skipWaiting\(\)/, "install must still call skipWaiting after pre-caching");
});

test("sw.js: activate still deletes stale cache generations and claims clients", function () {
  var idx = SW_JS.indexOf('self.addEventListener("activate"');
  assert.ok(idx !== -1);
  var block = SW_JS.slice(idx, idx + 700);
  assert.match(block, /caches\.delete\(n\)/, "activate must still clean up old cache names");
  assert.match(block, /self\.clients\.claim\(\)/, "activate must still claim clients");
});

// wake-reconnect-transient-401-lr-e5c1fe.test.js — regression coverage for
// lr-e5c1fe: switching away from the window and back (visibilitychange /
// OS wake) triggered the full-screen "Session expired — sign in again."
// interstitial on a session that was NOT actually expired.
//
// ROOT CAUSE (verified from source, this task): server-auth.js's
// getMultiUserFromReq() is a pure, synchronous cookie-header lookup — there
// is no server-side race or async gate that could make it 401 an
// authenticated request. The 401 was therefore CLIENT-SIDE: a tab just woken
// from background can fire its first fetch() before the browser has
// reattached cookies, so a single /api/ws-ticket 401 on a wake-triggered
// reconnect does not mean the session is gone (proven operationally by
// "Sign in again" — a bare connect() re-run — succeeding immediately with no
// login). handleUnauthenticated() treated ANY single 401 as terminal.
//
// FIX: connect() and scheduleReconnect()'s /info preflight now each retry
// once, after a short backoff, before calling handleUnauthenticated(). Only
// two consecutive 401s (auth confirmed gone) render the sign-in wall.
//
// app-connection.js is an ESM/DOM-dependent module this project's test
// runner does not exercise via a DOM harness — see
// ws-ticket-auth-lr-de5fcb.test.js for the established source-text
// convention for exactly this class of file.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var APP_CONNECTION_JS = fs.readFileSync(
  path.join(__dirname, "..", "lib", "public", "modules", "app-connection.js"), "utf8"
);

// ---------------------------------------------------------------------------
// 1 — connect(): a single ws-ticket 401 does not go straight to
//     handleUnauthenticated() — it must retry once first.
// ---------------------------------------------------------------------------

test("connect(): a single ws-ticket 401 is NOT terminal — it schedules a retry before calling handleUnauthenticated", function () {
  var idx = APP_CONNECTION_JS.indexOf("export function connect()");
  assert.ok(idx !== -1, "expected an exported connect()");
  var block = APP_CONNECTION_JS.slice(idx, idx + 1200);

  assert.match(block, /result\.unauthenticated/, "connect() must still branch on the ticket-fetch unauthenticated result");
  assert.match(block, /setTimeout\(/, "the first 401 must trigger a backoff before any terminal action");

  // handleUnauthenticated() must appear strictly AFTER a second fetchWsTicket()
  // call within the retry closure, not directly off the first result.
  var firstUnauthIdx = block.indexOf("result.unauthenticated");
  var retryFetchIdx = block.indexOf("fetchWsTicket()", firstUnauthIdx);
  var handleUnauthIdx = block.indexOf("handleUnauthenticated();", firstUnauthIdx);
  assert.ok(retryFetchIdx !== -1, "expected a second fetchWsTicket() call inside the retry path");
  assert.ok(handleUnauthIdx !== -1, "expected handleUnauthenticated() to still be reachable");
  assert.ok(retryFetchIdx < handleUnauthIdx,
    "the retry fetchWsTicket() call must occur before handleUnauthenticated() is invoked — " +
    "a single 401 must never call handleUnauthenticated() directly");
});

test("connect(): only a second consecutive ws-ticket 401 (retryResult.unauthenticated) routes to handleUnauthenticated", function () {
  var idx = APP_CONNECTION_JS.indexOf("export function connect()");
  var block = APP_CONNECTION_JS.slice(idx, idx + 1200);
  assert.match(block, /retryResult\.unauthenticated/,
    "the retry's own result must be checked independently before declaring the session expired");
  assert.match(block, /openSocket\(retryResult\.ticket\)/,
    "if the retry succeeds (no second 401), the socket must open normally — proving the first 401 was transient");
});

// ---------------------------------------------------------------------------
// 2 — scheduleReconnect(): the /info 401 preflight gets the same treatment,
//     so it can't independently fire the sign-in wall out from under
//     connect()'s own retry.
// ---------------------------------------------------------------------------

test("scheduleReconnect(): a single /info 401 during the reconnect preflight is re-verified before handleUnauthenticated", function () {
  var idx = APP_CONNECTION_JS.indexOf("export function scheduleReconnect()");
  assert.ok(idx !== -1, "expected an exported scheduleReconnect()");
  var block = APP_CONNECTION_JS.slice(idx, idx + 1400);

  assert.match(block, /res\.status === 401/, "must still detect a 401 on the /info preflight");
  var firstStatusIdx = block.indexOf("res.status === 401");
  var retryFetchIdx = block.indexOf('fetch("/info")', firstStatusIdx);
  var handleUnauthIdx = block.indexOf("handleUnauthenticated();", firstStatusIdx);
  assert.ok(retryFetchIdx !== -1, "expected a second /info fetch inside the retry path");
  assert.ok(handleUnauthIdx !== -1, "expected handleUnauthenticated() to still be reachable");
  assert.ok(retryFetchIdx < handleUnauthIdx,
    "the retry /info fetch must occur before handleUnauthenticated() is invoked on this path too");
});

// ---------------------------------------------------------------------------
// 3 — the retry backoff constant exists and is shared (not a magic number
//     duplicated per call site).
// ---------------------------------------------------------------------------

test("app-connection.js: a single named backoff constant gates both retry paths", function () {
  assert.match(APP_CONNECTION_JS, /var UNAUTH_RETRY_BACKOFF_MS = \d+;/,
    "expected a single named constant for the re-verify backoff");
  var occurrences = APP_CONNECTION_JS.split("UNAUTH_RETRY_BACKOFF_MS").length - 1;
  assert.ok(occurrences >= 3,
    "expected the constant to be defined once and referenced by both connect() and scheduleReconnect()'s retry paths");
});

// ---------------------------------------------------------------------------
// 4 — the genuinely-unauthenticated case (lr-de5fcb's original interstitial)
//     must still be preserved: handleUnauthenticated() itself is unchanged
//     and still cancels the reconnect loop instead of auto-reloading.
// ---------------------------------------------------------------------------

test("handleUnauthenticated(): still stops the reconnect loop and shows the explicit sign-in wall (lr-de5fcb behavior preserved)", function () {
  var idx = APP_CONNECTION_JS.indexOf("function handleUnauthenticated()");
  assert.ok(idx !== -1, "expected a handleUnauthenticated() state handler");
  var block = APP_CONNECTION_JS.slice(idx, idx + 700);
  assert.match(block, /cancelReconnect\(\);/, "must cancel any pending reconnect timer");
  assert.match(block, /Session expired — sign in again\./, "must still show the explicit session-expired message");
  assert.doesNotMatch(block, /location\.reload\(\)/,
    "must not auto-reload (that would immediately re-trigger connect() -> /api/ws-ticket 401 -> a tight loop of its own)"
  );
});

// ---------------------------------------------------------------------------
// 5 — brand check: any touched user-facing string must use "Clagentic: Console".
// ---------------------------------------------------------------------------

test("app-connection.js: no bare 'clagentic' product-name usage was introduced by this fix", function () {
  var idx = APP_CONNECTION_JS.indexOf("var UNAUTH_RETRY_BACKOFF_MS");
  assert.ok(idx !== -1);
  var block = APP_CONNECTION_JS.slice(idx, idx + 2200);
  assert.doesNotMatch(block, /[^-_/@:]clagentic(?![-_/@.])/i,
    "no bare 'clagentic' product-name reference should appear in the touched region");
});

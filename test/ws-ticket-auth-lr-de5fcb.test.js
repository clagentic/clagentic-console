"use strict";
// Regression coverage for lr-de5fcb: the /ws upgrade authenticated ONLY via
// the SameSite=Lax relay_auth_user cookie, which mobile browsers do not
// reliably attach to a script-initiated WebSocket handshake — an
// otherwise-authenticated mobile session got 401'd on every reconnect and
// wedged the reconnect loop (MILLER, lr-de5fcb comment #1).
//
// Fix: a short-TTL, single-use ws-ticket, minted by an authenticated
// GET /api/ws-ticket and validated as a fallback in the upgrade handler
// when the cookie is absent.
//
// 1-4 drive the real server-auth.js ticket store directly (mint, single-use
//     consumption, cross-user isolation, expiry) — no reimplementation.
// 5-7 are source-text checks confirming the upgrade handler, client fetch
//     flow, and Surface-1 unauth-vs-unreachable branch are wired correctly;
//     these touch server.js's WS-upgrade closure and the DOM-dependent
//     app-connection.js client module, which this project's test runner
//     does not exercise via an HTTP/DOM harness (see
//     pwa-stale-sw-reconnect-lr-e0ec47.test.js for the established
//     source-text convention for exactly this class of file).

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr-de5fcb-"));
}

function makeAuth(tmpHome) {
  // Bust require cache so fresh modules pick up the temp CLAGENTIC_HOME —
  // users.js persists to CONFIG_DIR-derived paths at module scope.
  ["../lib/config", "../lib/users", "../lib/users-auth", "../lib/users-permissions",
   "../lib/users-preferences", "../lib/store", "../lib/server-auth", "../lib/smtp",
   "../lib/pages"].forEach(function (m) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  });
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var users, serverAuth, smtp, pages;
  try {
    users = require("../lib/users");
    serverAuth = require("../lib/server-auth");
    smtp = require("../lib/smtp");
    pages = require("../lib/pages");
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
  var auth = serverAuth.attachAuth({
    users: users,
    smtp: smtp,
    pages: pages,
    tlsOptions: null,
    osUsers: false,
    provisionLinuxUser: function () { return { ok: false }; },
    onUserProvisioned: null,
  });
  return { auth: auth, users: users };
}

function makeUser(users, username) {
  var result = users.createUser({ username: username, pin: "123456", role: "user" });
  assert.ok(result.ok, "test setup: createUser must succeed");
  return result.user;
}

// ---------------------------------------------------------------------------
// 1 — mint then consume: happy path
// ---------------------------------------------------------------------------

test("lr-de5fcb-1: mintWsTicket + consumeWsTicket round-trips to the bound userId", function () {
  var ctx = makeAuth(makeTempHome());
  var user = makeUser(ctx.users, "mobile-user");

  var ticket = ctx.auth.mintWsTicket(user.id);
  assert.ok(ticket && typeof ticket === "string" && ticket.length > 0,
    "mintWsTicket must return a fresh opaque ticket string");

  var resolved = ctx.auth.consumeWsTicket(ticket);
  assert.ok(resolved, "consumeWsTicket must resolve a freshly minted, unexpired ticket");
  assert.equal(resolved.id, user.id, "the resolved user must be the one the ticket was minted for");
});

// ---------------------------------------------------------------------------
// 2 — single-use: a second consume of the same ticket must fail
// ---------------------------------------------------------------------------

test("lr-de5fcb-2: a ws-ticket is single-use — reuse after a successful consume is rejected", function () {
  var ctx = makeAuth(makeTempHome());
  var user = makeUser(ctx.users, "mobile-user-2");

  var ticket = ctx.auth.mintWsTicket(user.id);
  var first = ctx.auth.consumeWsTicket(ticket);
  assert.ok(first, "first consume must succeed");

  var second = ctx.auth.consumeWsTicket(ticket);
  assert.equal(second, null, "replaying the same ticket must be rejected (bounds replay to a single use)");
});

// ---------------------------------------------------------------------------
// 3 — unknown / garbage ticket is rejected
// ---------------------------------------------------------------------------

test("lr-de5fcb-3: consumeWsTicket rejects an unknown ticket and a missing ticket", function () {
  var ctx = makeAuth(makeTempHome());

  assert.equal(ctx.auth.consumeWsTicket("not-a-real-ticket"), null,
    "an unminted ticket value must never resolve to a user");
  assert.equal(ctx.auth.consumeWsTicket(null), null, "a null ticket must be rejected");
  assert.equal(ctx.auth.consumeWsTicket(""), null, "an empty-string ticket must be rejected");
});

// ---------------------------------------------------------------------------
// 4 — expiry: a ticket past its TTL is rejected even though it exists
// ---------------------------------------------------------------------------

test("lr-de5fcb-4: an expired ws-ticket is rejected (bounds replay by time, not just by use-count)", function (t) {
  var ctx = makeAuth(makeTempHome());
  var user = makeUser(ctx.users, "mobile-user-4");

  var ticket = ctx.auth.mintWsTicket(user.id);

  // The ticket TTL is short (seconds) by design (spec: "SHORT-TTL (seconds,
  // e.g. 30s)"). Simulate the clock moving past expiry without sleeping the
  // test process for real seconds.
  var realNow = Date.now;
  t.after(function () { Date.now = realNow; });
  Date.now = function () { return realNow() + 60 * 1000; };

  var resolved = ctx.auth.consumeWsTicket(ticket);
  assert.equal(resolved, null, "a ticket consumed after its TTL has elapsed must be rejected");
});

// ---------------------------------------------------------------------------
// 5 — server.js: upgrade handler wiring (source-text — see file header)
// ---------------------------------------------------------------------------

var SERVER_JS = fs.readFileSync(path.join(__dirname, "..", "lib", "server.js"), "utf8");
var APP_CONNECTION_JS = fs.readFileSync(
  path.join(__dirname, "..", "lib", "public", "modules", "app-connection.js"), "utf8"
);

test("server.js: /api/ws-ticket requires the session cookie and mints via auth.mintWsTicket", function () {
  var idx = SERVER_JS.indexOf('fullUrl === "/api/ws-ticket"');
  assert.ok(idx !== -1, "expected a GET /api/ws-ticket route");
  var block = SERVER_JS.slice(idx, idx + 700);
  assert.match(block, /getMultiUserFromReq\(req\)/, "must resolve the requester from the session cookie");
  assert.match(block, /401/, "must 401 an unauthenticated request rather than minting a ticket for it");
  assert.match(block, /auth\.mintWsTicket\(/, "must mint the ticket through the auth module's ticket store");
});

test("server.js: the WS upgrade handler falls back to a ticket only when the cookie is absent", function () {
  var idx = SERVER_JS.indexOf("var wsCookieUser = getMultiUserFromReq(req);");
  assert.ok(idx !== -1, "expected the upgrade handler to resolve the cookie-authed user first");
  var block = SERVER_JS.slice(idx, idx + 900);
  assert.match(block, /if\s*\(!wsCookieUser\)\s*\{/, "the ticket path must only be attempted when the cookie path failed");
  assert.match(block, /extractWsTicketFromHeader\(req\.headers\["sec-websocket-protocol"\]\)/,
    "must read the ticket from Sec-WebSocket-Protocol, not a query string (avoids logging the credential)");
  assert.match(block, /auth\.consumeWsTicket\(offeredTicket\)/, "must validate+consume via the single-use ticket store");
  assert.match(block, /var wsAuthedUser = wsCookieUser \|\| wsTicketUser;/,
    "the cookie path must remain the primary source of truth; the ticket is strictly a fallback");
});

test("server.js: a ticket-authed upgrade echoes the accepted subprotocol in the 101 handshake", function () {
  assert.match(
    SERVER_JS,
    /handleProtocols:\s*function\s*\(protocols,\s*req\)\s*\{[\s\S]{0,200}req\._clayAcceptedProtocol/,
    "WebSocketServer must be configured with a handleProtocols hook that echoes the accepted ticket subprotocol " +
    "(required by the WS spec whenever the client offers a Sec-WebSocket-Protocol list)"
  );
  assert.match(
    SERVER_JS,
    /req\._clayAcceptedProtocol = "clagentic\.auth\." \+ offeredTicket;/,
    "the accepted-protocol marker must only be set after the ticket was validated, not merely offered"
  );
});

test("server.js: a rejected upgrade never accidentally accepts the long-lived session token via a ticket", function () {
  // The fix spec is explicit: the ticket must be a fresh opaque value, never
  // the session token itself, and never accepted via query string.
  assert.doesNotMatch(SERVER_JS, /ticket\s*=\s*.*relay_auth_user/,
    "the ws-ticket value must never be derived from the session cookie/token");
  var idx = SERVER_JS.indexOf("function extractWsTicketFromHeader");
  assert.ok(idx !== -1, "expected an extractWsTicketFromHeader helper");
  var block = SERVER_JS.slice(idx, idx + 500);
  assert.doesNotMatch(block, /req\.url/, "the ticket extractor must read the subprotocol header, not a URL query string");
});

test("server.js: a rejected upgrade logs cookie/ticket presence only when debug is enabled, never the values", function () {
  var idx = SERVER_JS.indexOf("if (!wsAuthedUser) {");
  assert.ok(idx !== -1);
  var block = SERVER_JS.slice(idx, idx + 500);
  assert.match(block, /if\s*\(debug\)\s*\{/, "the rejected-upgrade diagnostic log must be debug-gated");
  assert.match(block, /cookiePresent=/, "must record whether a cookie was present");
  assert.match(block, /ticketOffered=/, "must record whether a ticket was offered");
  assert.doesNotMatch(block, /req\.headers\.cookie\s*\+/, "must never concatenate/log the raw cookie header value");
});

// ---------------------------------------------------------------------------
// 6 — app-connection.js: ticket-fetch-before-connect + subprotocol offer
// ---------------------------------------------------------------------------

test("app-connection.js: connect() fetches a ws-ticket before opening the socket and offers it as a subprotocol", function () {
  assert.match(
    APP_CONNECTION_JS,
    /fetch\("\/api\/ws-ticket"/,
    "connect() must fetch a ticket from /api/ws-ticket before opening the WebSocket"
  );
  assert.match(
    APP_CONNECTION_JS,
    /new WebSocket\(url, \["clagentic\.auth\." \+ ticket\]\)/,
    "the ticket must be offered via the Sec-WebSocket-Protocol subprotocol list, not a query string"
  );
});

test("app-connection.js: the WS URL is still derived strictly from window.location (same-origin invariant preserved)", function () {
  var idx = APP_CONNECTION_JS.indexOf("function openSocket(ticket)");
  assert.ok(idx !== -1);
  var block = APP_CONNECTION_JS.slice(idx, idx + 700);
  assert.match(
    block,
    /protocol \+ "\/\/" \+ location\.host \+ store\.get\('wsPath'\)/,
    "the socket URL must still be built from location.protocol/location.host, never a daemon.js share host"
  );
});

// ---------------------------------------------------------------------------
// 7 — app-connection.js: Surface 1 — unauthenticated vs unreachable
// ---------------------------------------------------------------------------

test("app-connection.js: a ticket-fetch 401 routes to handleUnauthenticated instead of looping", function () {
  var idx = APP_CONNECTION_JS.indexOf("function fetchWsTicket()");
  assert.ok(idx !== -1);
  var fetchBlock = APP_CONNECTION_JS.slice(idx, idx + 500);
  assert.match(fetchBlock, /res\.status === 401/, "must detect a 401 on the ticket fetch");

  var connectIdx = APP_CONNECTION_JS.indexOf("export function connect()");
  assert.ok(connectIdx !== -1);
  var connectBlock = APP_CONNECTION_JS.slice(connectIdx, connectIdx + 900);
  assert.match(connectBlock, /result\.unauthenticated/, "connect() must branch on the ticket-fetch unauthenticated result");
  assert.match(connectBlock, /handleUnauthenticated\(\);/, "an unauthenticated ticket fetch must route to the explicit sign-in state");
});

test("app-connection.js: an upgrade rejected before onopen (with a ticket offered) is treated as unauthenticated, not unreachable", function () {
  var idx = APP_CONNECTION_JS.indexOf("newWs.onclose = function (e) {");
  assert.ok(idx !== -1);
  var block = APP_CONNECTION_JS.slice(idx, idx + 1200);
  assert.match(block, /if\s*\(!everOpened && ticket\)\s*\{/,
    "onclose must distinguish 'never opened despite offering a ticket' (auth rejection) from a normal drop");
  assert.match(block, /handleUnauthenticated\(\);/, "the never-opened-with-ticket case must route to the unauthenticated state");
  assert.match(block, /scheduleReconnect\(\);/, "the normal drop case must still fall through to the transient-disconnect reconnect path");
});

test("app-connection.js: handleUnauthenticated stops the reconnect loop instead of masking as a spinner", function () {
  var idx = APP_CONNECTION_JS.indexOf("function handleUnauthenticated()");
  assert.ok(idx !== -1, "expected a handleUnauthenticated() state handler");
  var block = APP_CONNECTION_JS.slice(idx, idx + 700);
  assert.match(block, /cancelReconnect\(\);/, "must cancel any pending reconnect timer");
  assert.doesNotMatch(block, /location\.reload\(\)/,
    "must not auto-reload (that would immediately re-trigger connect() -> /api/ws-ticket 401 -> a tight loop of its own)"
  );
});

test("app-connection.js: /info 401 during scheduled reconnect routes through handleUnauthenticated, not a bare reload", function () {
  var idx = APP_CONNECTION_JS.indexOf("export function scheduleReconnect()");
  assert.ok(idx !== -1);
  var block = APP_CONNECTION_JS.slice(idx, idx + 700);
  assert.match(block, /res\.status === 401\) \{ handleUnauthenticated\(\); return null; \}/,
    "the /info reconnect preflight must route a 401 through the same explicit unauthenticated state as the WS path"
  );
});

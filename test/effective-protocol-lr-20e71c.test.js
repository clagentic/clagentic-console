// Regression coverage for lr-20e71c: the System Settings HTTPS badge and the
// daemon's share-URL derivation both read `tls: !!tlsOptions` — which means
// only "is the daemon terminating TLS itself from CONFIG_DIR/certs". A
// deployment fronted by a reverse proxy (e.g. Caddy) that terminates TLS and
// forwards plain HTTP to the daemon is genuinely HTTPS, but tlsOptions is
// correctly null there — so the badge reported a false negative, and the
// share URL advertised http:// for a console actually served over https://.
//
// lib/effective-protocol.js's resolveEffectiveProtocol() is the new single
// source of truth for the EXTERNAL protocol, kept separate from tlsOptions
// (which stays the accurate name for daemon-internal termination). It is a
// pure function, directly requirable and unit-tested below.
//
// lib/server.js (WS-upgrade wiring), lib/project-sessions.js (get_daemon_config
// passthrough), and lib/daemon.js (onGetDaemonConfig response shape, startup
// log line) are not practical direct-require targets under plain Node (they
// stand up a real HTTP/WS server or read live config at module-load time) —
// matching the project's established convention (see
// server-cross-project-unread-per-session-lr-0aa7b6.test.js,
// rate-limit-per-session-lr-0827ba.test.js), these are covered by source-text
// presence checks confirming the wiring is actually present.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var { resolveEffectiveProtocol } = require("../lib/effective-protocol");

function readMod(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

// ---------------------------------------------------------------------------
// resolveEffectiveProtocol: pure function, all three states
// ---------------------------------------------------------------------------

test("resolveEffectiveProtocol: tlsOptions set -> direct https, regardless of trustedProxy/header", function () {
  var result = resolveEffectiveProtocol({
    tlsOptions: { key: "k", cert: "c" },
    trustedProxy: false,
    forwardedProtoHeader: null,
  });
  assert.deepStrictEqual(result, { protocol: "https", state: "direct" });
});

test("resolveEffectiveProtocol: no tlsOptions, trustedProxy true, X-Forwarded-Proto: https -> proxy https", function () {
  var result = resolveEffectiveProtocol({
    tlsOptions: null,
    trustedProxy: true,
    forwardedProtoHeader: "https",
  });
  assert.deepStrictEqual(result, { protocol: "https", state: "proxy" });
});

test("resolveEffectiveProtocol: no tlsOptions, trustedProxy FALSE, X-Forwarded-Proto: https -> disabled (header never trusted unconditionally)", function () {
  var result = resolveEffectiveProtocol({
    tlsOptions: null,
    trustedProxy: false,
    forwardedProtoHeader: "https",
  });
  assert.deepStrictEqual(result, { protocol: "http", state: "disabled" },
    "an untrusted client's X-Forwarded-Proto must never flip the badge to Enabled — this is the spoofing surface the trustedProxy gate closes");
});

test("resolveEffectiveProtocol: no tlsOptions, no trustedProxy, no header -> genuinely disabled", function () {
  var result = resolveEffectiveProtocol({
    tlsOptions: null,
    trustedProxy: false,
    forwardedProtoHeader: undefined,
  });
  assert.deepStrictEqual(result, { protocol: "http", state: "disabled" });
});

test("resolveEffectiveProtocol: trustedProxy true but header is http -> disabled, not proxy", function () {
  var result = resolveEffectiveProtocol({
    tlsOptions: null,
    trustedProxy: true,
    forwardedProtoHeader: "http",
  });
  assert.deepStrictEqual(result, { protocol: "http", state: "disabled" });
});

test("resolveEffectiveProtocol: multi-hop header 'https, http' (append-mode spoof vector) must NOT read as https — a single trustedProxy boolean cannot express which hop is trustworthy", function () {
  // Regression for the PEACHES finding-1 defect: the old code took
  // split(",")[0] (the LEFTMOST value) under the mistaken belief that a
  // proxy chain appends closest-proxy-first. In a real appending chain the
  // leftmost value is the ORIGINAL CLIENT-SUPPLIED one — an untrusted client
  // sending "X-Forwarded-Proto: https" to an appending proxy that itself
  // forwards plain HTTP produces exactly "https, http" on the wire. The old
  // code read "https" (leftmost) and reported a false "Enabled (proxy)"
  // badge — reintroducing the spoofing surface this task exists to close.
  // This test fails on the pre-fix code (which returned state: "proxy").
  var result = resolveEffectiveProtocol({
    tlsOptions: null,
    trustedProxy: true,
    forwardedProtoHeader: "https, http",
  });
  assert.deepStrictEqual(result, { protocol: "http", state: "disabled" },
    "a multi-valued X-Forwarded-Proto must be refused outright, not partially trusted by position");
});

test("resolveEffectiveProtocol: multi-hop header 'http, https' (rightmost https) is ALSO refused — rightmost-trust is not assumed safe under a single-boolean trust model", function () {
  var result = resolveEffectiveProtocol({
    tlsOptions: null,
    trustedProxy: true,
    forwardedProtoHeader: "http, https",
  });
  assert.deepStrictEqual(result, { protocol: "http", state: "disabled" });
});

test("resolveEffectiveProtocol: header value is case-insensitive", function () {
  var result = resolveEffectiveProtocol({
    tlsOptions: null,
    trustedProxy: true,
    forwardedProtoHeader: "HTTPS",
  });
  assert.deepStrictEqual(result, { protocol: "https", state: "proxy" });
});

test("resolveEffectiveProtocol: trustedProxy true but header absent -> disabled", function () {
  var result = resolveEffectiveProtocol({
    tlsOptions: null,
    trustedProxy: true,
    forwardedProtoHeader: null,
  });
  assert.deepStrictEqual(result, { protocol: "http", state: "disabled" });
});

// ---------------------------------------------------------------------------
// lib/server.js: X-Forwarded-Proto is resolved once per WS connection at
// upgrade time (where req.headers is in scope) and attached to the ws, gated
// on the operator-declared trustedProxy option — never read unconditionally.
// ---------------------------------------------------------------------------

var SERVER_JS = readMod("lib/server.js");

test("lib/server.js: reads opts.trustedProxy (operator-declared trust boundary)", function () {
  assert.match(
    SERVER_JS,
    /var trustedProxy = !!opts\.trustedProxy;/,
    "expected createServer to read opts.trustedProxy into a local trustedProxy flag"
  );
});

test("lib/server.js: resolves and attaches ws._clagenticEffectiveProtocol at WS-upgrade time via resolveEffectiveProtocol", function () {
  var idx = SERVER_JS.indexOf("ws._clagenticEffectiveProtocol = resolveEffectiveProtocol(");
  assert.ok(idx !== -1, "expected ws._clagenticEffectiveProtocol to be assigned from resolveEffectiveProtocol(...)");
  var block = SERVER_JS.slice(idx, idx + 300);
  assert.match(block, /tlsOptions:\s*tlsOptions/, "must pass the daemon-internal tlsOptions through");
  assert.match(block, /trustedProxy:\s*trustedProxy/, "must pass the operator-declared trustedProxy flag through");
  assert.match(
    block,
    /forwardedProtoHeader:\s*req\.headers\["x-forwarded-proto"\]/,
    "must read X-Forwarded-Proto from the upgrade request, not trust it unconditionally elsewhere"
  );
});

test("lib/server.js: ws._clagenticEffectiveProtocol is assigned inside the upgrade handler, before ctx.handleConnection", function () {
  var upgradeIdx = SERVER_JS.indexOf('server.on("upgrade", function (req, socket, head) {');
  var effIdx = SERVER_JS.indexOf("ws._clagenticEffectiveProtocol = resolveEffectiveProtocol(");
  var handleConnIdx = SERVER_JS.indexOf("ctx.handleConnection(ws, wsUser);");
  assert.ok(upgradeIdx !== -1 && effIdx !== -1 && handleConnIdx !== -1, "expected all three anchors to exist");
  assert.ok(upgradeIdx < effIdx && effIdx < handleConnIdx,
    "ws._clagenticEffectiveProtocol must be resolved after the upgrade handler starts (req.headers in scope) and before the connection is handed off");
});

// ---------------------------------------------------------------------------
// lib/server.js: /setup and /pwa GET routes, and the last-visited-project
// cookie's Secure attribute, must derive from resolveEffectiveProtocol
// rather than tlsOptions alone (PEACHES finding 2 on PR #409 — HOLDEN
// independently verified by reading source). Behind a trusted TLS-
// terminating proxy, tlsOptions is correctly null, so `tlsOptions ? "https"
// : "http"` under-reports for any route still using that pattern.
// ---------------------------------------------------------------------------

test("lib/server.js: /setup route derives its URL protocol via resolveEffectiveProtocol, not tlsOptions alone", function () {
  var idx = SERVER_JS.indexOf('fullUrl === "/setup" && req.method === "GET"');
  assert.ok(idx !== -1, "expected the /setup route to exist");
  var block = SERVER_JS.slice(idx, idx + 700);
  assert.ok(!/var protocol = tlsOptions \? "https" : "http";/.test(block),
    "/setup must not fall back to the bare tlsOptions-as-protocol pattern this task exists to remove");
  assert.match(
    block,
    /var protocol = resolveEffectiveProtocol\(\{\s*tlsOptions:\s*tlsOptions,\s*trustedProxy:\s*trustedProxy,\s*forwardedProtoHeader:\s*req\.headers\["x-forwarded-proto"\],\s*\}\)\.protocol;/,
    "/setup must resolve the per-request effective protocol exactly as the WS upgrade handler does"
  );
});

test("lib/server.js: /pwa route derives its URL protocol via resolveEffectiveProtocol, not tlsOptions alone", function () {
  var idx = SERVER_JS.indexOf('fullUrl === "/pwa" && req.method === "GET"');
  assert.ok(idx !== -1, "expected the /pwa route to exist");
  var block = SERVER_JS.slice(idx, idx + 700);
  assert.ok(!/var protocol = tlsOptions \? "https" : "http";/.test(block),
    "/pwa must not fall back to the bare tlsOptions-as-protocol pattern this task exists to remove");
  assert.match(
    block,
    /var protocol = resolveEffectiveProtocol\(\{\s*tlsOptions:\s*tlsOptions,\s*trustedProxy:\s*trustedProxy,\s*forwardedProtoHeader:\s*req\.headers\["x-forwarded-proto"\],\s*\}\)\.protocol;/,
    "/pwa must resolve the per-request effective protocol exactly as the WS upgrade handler does"
  );
});

test("lib/server.js: no remaining `tlsOptions ? \"https\" : \"http\"` protocol-derivation sites anywhere in the file", function () {
  assert.ok(
    !/tlsOptions \? "https" : "http"/.test(SERVER_JS),
    "every route that derives a display/URL protocol from tlsOptions must instead resolve it via resolveEffectiveProtocol"
  );
});

test("lib/server.js: last-visited-project cookie's Secure attribute derives from resolveEffectiveProtocol, not tlsOptions alone", function () {
  var idx = SERVER_JS.indexOf("Set last-visited project cookie for root redirect");
  assert.ok(idx !== -1, "expected the last-visited-project cookie block to exist");
  var block = SERVER_JS.slice(idx, idx + 900);
  assert.ok(!/tlsOptions \? "; Secure" : ""/.test(block),
    "the Secure cookie attribute must not gate on daemon-internal tlsOptions alone — that under-reports HTTPS behind a trusted proxy");
  assert.match(
    block,
    /cookieEffectiveProtocol === "https" \? "; Secure" : ""/,
    "Secure must be set whenever the resolved effective protocol is https, including the proxy-terminated case"
  );
});

// ---------------------------------------------------------------------------
// lib/project-sessions.js: get_daemon_config passes the per-connection
// effective protocol through to onGetDaemonConfig, since its own dispatch
// only has ws/msg in scope, not the original upgrade req.
// ---------------------------------------------------------------------------

var PROJECT_SESSIONS_JS = readMod("lib/project-sessions.js");

test('lib/project-sessions.js: get_daemon_config calls onGetDaemonConfig(ws._clagenticEffectiveProtocol)', function () {
  var idx = PROJECT_SESSIONS_JS.indexOf('if (msg.type === "get_daemon_config") {');
  assert.ok(idx !== -1, "expected the get_daemon_config handler to exist");
  var block = PROJECT_SESSIONS_JS.slice(idx, idx + 600);
  assert.match(
    block,
    /opts\.onGetDaemonConfig\s*\(\s*ws\._clagenticEffectiveProtocol\s*\)/,
    "get_daemon_config must forward ws._clagenticEffectiveProtocol (resolved at upgrade time) into onGetDaemonConfig"
  );
});

// ---------------------------------------------------------------------------
// lib/daemon.js: onGetDaemonConfig response shape + startup log line
// ---------------------------------------------------------------------------

var DAEMON_JS = readMod("lib/daemon.js");

test("lib/daemon.js: createServer is passed trustedProxy: !!config.trustedProxy", function () {
  assert.match(
    DAEMON_JS,
    /trustedProxy:\s*!!config\.trustedProxy,/,
    "expected the createServer(...) call to thread the operator's daemon.json trustedProxy declaration through"
  );
});

test("lib/daemon.js: onGetDaemonConfig keeps `tls` as daemon-internal-only and adds tlsEffective/tlsState from the passed-in effectiveProtocol", function () {
  var idx = DAEMON_JS.indexOf("onGetDaemonConfig: function (effectiveProtocol)");
  assert.ok(idx !== -1, "expected onGetDaemonConfig to accept an effectiveProtocol parameter");
  var block = DAEMON_JS.slice(idx, idx + 500);
  assert.match(block, /tls:\s*!!tlsOptions,/, "the existing `tls` field must stay tied to daemon-internal tlsOptions only — never repurposed");
  assert.match(
    block,
    /tlsEffective:\s*effectiveProtocol \? effectiveProtocol\.protocol === "https" : !!tlsOptions,/,
    "tlsEffective must derive from the passed-in effectiveProtocol when present"
  );
  assert.match(
    block,
    /tlsState:\s*effectiveProtocol \? effectiveProtocol\.state : \(tlsOptions \? "direct" : "disabled"\),/,
    "tlsState must derive from the passed-in effectiveProtocol when present, with a same-shape fallback when absent (e.g. IPC callers)"
  );
});

test("lib/daemon.js: get_status IPC case is untouched — still reports tls: !!tlsOptions (no request context available over IPC)", function () {
  var idx = DAEMON_JS.indexOf('case "get_status":');
  assert.ok(idx !== -1, "expected the get_status IPC case to exist");
  var block = DAEMON_JS.slice(idx, idx + 300);
  assert.match(block, /tls:\s*!!tlsOptions,/, "get_status is a CLI/IPC-only status shape with no live HTTP request to read X-Forwarded-Proto from — it correctly stays tied to daemon-internal termination");
});

test("lib/daemon.js: startup listen log reflects the trustedProxy declaration rather than always printing http:// behind a proxy", function () {
  var idx = DAEMON_JS.indexOf('function startListening() {');
  assert.ok(idx !== -1, "expected startListening to exist");
  var block = DAEMON_JS.slice(idx, idx + 900);
  assert.match(
    block,
    /var protocol = tlsOptions \? "https" : \(config\.trustedProxy \? "https" : "http"\);/,
    "startup has no live request (no X-Forwarded-Proto to read), so the log line must fall back to the operator's trustedProxy declaration instead of silently printing http://"
  );
  assert.match(
    block,
    /var protocolNote = \(!tlsOptions && config\.trustedProxy\) \? " \(proxy-terminated\)" : "";/,
    "the proxy-terminated annotation must be kept out of the scheme itself — 'https (proxy-terminated)://...' is not a valid URI"
  );
  assert.match(
    block,
    /"\[daemon\] Listening on " \+ protocol \+ ":\/\/" \+ listenHost \+ ":" \+ config\.port \+ protocolNote/,
    "the annotation must be appended after the URI, not inside the scheme"
  );
});

// ---------------------------------------------------------------------------
// lib/public/modules/server-settings.js: three-state badge render
// ---------------------------------------------------------------------------

var SERVER_SETTINGS_JS = readMod("lib/public/modules/server-settings.js");

test("lib/public/modules/server-settings.js: updateDaemonConfig renders three distinct HTTPS badge states from config.tlsState", function () {
  var idx = SERVER_SETTINGS_JS.indexOf("export function updateDaemonConfig(config) {");
  assert.ok(idx !== -1, "expected updateDaemonConfig to exist");
  var block = SERVER_SETTINGS_JS.slice(idx, idx + 2000);
  assert.match(block, /var tlsState = config\.tlsState \|\| \(config\.tls \? "direct" : "disabled"\);/,
    "must read config.tlsState with a same-shape fallback for an older/IPC-shaped payload");
  assert.match(block, /tlsState === "direct" \? "Enabled" :/, 'direct state must render "Enabled"');
  assert.match(block, /tlsState === "proxy" \? "Enabled \(proxy\)" : "Disabled";/,
    'proxy state must render a visibly distinct "Enabled (proxy)" label, and disabled must render "Disabled" — never collapsing the genuinely-unencrypted case into "Enabled"');
  assert.match(block, /classList\.toggle\("settings-badge-green", tlsState === "direct"\)/);
  assert.match(block, /classList\.toggle\("settings-badge-proxy", tlsState === "proxy"\)/);
});

test("lib/public/modules/server-settings.js: the badge stays read-only — no WS message is sent from the TLS row (readout, not a control)", function () {
  var idx = SERVER_SETTINGS_JS.indexOf("export function updateDaemonConfig(config) {");
  var nextFnIdx = SERVER_SETTINGS_JS.indexOf("export function handleSetPinResult", idx);
  var block = SERVER_SETTINGS_JS.slice(idx, nextFnIdx);
  assert.ok(!/settings-tls[\s\S]*addEventListener/.test(block), "the settings-tls element must never gain a click/change handler — it is a readout, not a control");
});

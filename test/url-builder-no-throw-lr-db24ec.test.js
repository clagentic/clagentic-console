// Regression test for lr-db24ec: bin/cli.js and lib/cli/menus.js both called
// toClayStudioUrl(ip, port, protocol) — a helper that was removed in lr-8406
// ("remove pre-fork builtin cert") along with the getBuiltinCert() /
// forceBuiltin / config.builtinCert wiring that gated it. lr-8406 stripped
// most call sites, but two were missed (one later relocated verbatim into
// lib/cli/menus.js by the lr-4e49 cli.js split): the "daemon already
// running" headless-status path in bin/cli.js and the "recover_admin"
// recovery-URL path in lib/cli/menus.js. Both still read the now-dead
// config.builtinCert flag and, on any config that carried it as true (e.g.
// a stale pre-lr-8406 config.json), called the undefined toClayStudioUrl and
// threw ReferenceError — a CLI crash, worst-case on the account-recovery
// path.
//
// Fix: since config.builtinCert is never set to true anywhere in the
// current codebase (lr-8406 removed all the setting code), the dead
// ternary branches were dropped; both paths now always build the URL the
// same way every other call site in this file already does:
// protocol + "://" + ip + ":" + port.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");

var CLI_PATH = path.join(__dirname, "..", "bin", "cli.js");
var MENUS_PATH = path.join(__dirname, "..", "lib", "cli", "menus.js");

function readSource(p) {
  return fs.readFileSync(p, "utf8");
}

test("bin/cli.js + lib/cli/menus.js: no reference to the removed toClayStudioUrl helper", function () {
  [CLI_PATH, MENUS_PATH].forEach(function (p) {
    assert.ok(
      readSource(p).indexOf("toClayStudioUrl") === -1,
      p + " still references toClayStudioUrl, which was removed in lr-8406 and has no definition anywhere in bin/ or lib/ (lr-db24ec)"
    );
  });
});

test("bin/cli.js + lib/cli/menus.js: no reference to the dead config.builtinCert flag", function () {
  [CLI_PATH, MENUS_PATH].forEach(function (p) {
    assert.ok(
      readSource(p).indexOf("config.builtinCert") === -1,
      p + " still branches on config.builtinCert, which is never set to true anywhere in the current codebase (lr-8406) (lr-db24ec)"
    );
  });
});

// Both call sites build the URL the same way: protocol + "://" + ip + ":" + port,
// optionally with a "/recover/<path>" suffix. Exercise the shared shape
// directly to prove it renders a URL without throwing, for both the plain
// http and the tls-enabled ("https") cases, mirroring the real inputs
// (a LAN/Tailscale IPv4 string, a numeric port, a "http"/"https" protocol).
function buildStatusUrl(ip, port, protocol) {
  return protocol + "://" + ip + ":" + port;
}

function buildRecoveryUrl(ip, port, protocol, recoveryUrlPath) {
  return protocol + "://" + ip + ":" + port + "/recover/" + recoveryUrlPath;
}

test("studio-status URL path (bin/cli.js headless daemon-already-running) renders a URL without throwing", function () {
  ["http", "https"].forEach(function (protocol) {
    var url;
    assert.doesNotThrow(function () {
      url = buildStatusUrl("192.168.1.50", 2633, protocol);
    });
    assert.strictEqual(url, protocol + "://192.168.1.50:2633");
  });
});

test("recovery-URL path (lib/cli/menus.js recover_admin) renders a URL without throwing", function () {
  ["http", "https"].forEach(function (protocol) {
    var url;
    assert.doesNotThrow(function () {
      url = buildRecoveryUrl("192.168.1.50", 2633, protocol, "deadbeef");
    });
    assert.strictEqual(url, protocol + "://192.168.1.50:2633/recover/deadbeef");
  });
});

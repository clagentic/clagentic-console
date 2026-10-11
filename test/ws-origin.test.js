// WebSocket upgrade origin check (lib/ws-origin.js): the full origin, not just
// the port, must belong to the daemon. One test per caller shape.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var { checkWsOrigin } = require("../lib/ws-origin");

function check(headers, extra) {
  return checkWsOrigin(Object.assign({ headers: headers, tls: false, trustedProxy: false, allowedOrigins: [] }, extra || {})).ok;
}

test("direct LAN access by IP and port", function () {
  assert.equal(check({ origin: "http://192.168.1.20:2633", host: "192.168.1.20:2633" }), true);
  assert.equal(check({ origin: "http://192.168.1.20:2633", host: "192.168.1.21:2633" }), false);
  assert.equal(check({ origin: "http://192.168.1.20:9999", host: "192.168.1.20:2633" }), false, "same host, other port");
});

test("the same port on a different host is refused", function () {
  assert.equal(check({ origin: "http://evil.example:2633", host: "console.lan:2633" }), false);
  assert.equal(check({ origin: "http://sibling.example.com:2633", host: "console.example.com:2633" }), false);
});

test("host names compare case-insensitively", function () {
  assert.equal(check({ origin: "http://Console.LAN:2633", host: "console.lan:2633" }), true);
});

test("a TLS-terminating reverse proxy on :443 in front of an HTTP daemon", function () {
  assert.equal(check({ origin: "https://console.example.com", host: "console.example.com" }), true);
  assert.equal(check({ origin: "https://console.example.com:443", host: "console.example.com" }), true);
  assert.equal(check({ origin: "https://other.example.com", host: "console.example.com" }), false, "a sibling subdomain");
});

test("a proxy that rewrites Host is trusted only when the operator says so", function () {
  var headers = { origin: "https://console.example.com", host: "127.0.0.1:2633", "x-forwarded-host": "console.example.com", "x-forwarded-proto": "https" };
  assert.equal(check(headers), false, "X-Forwarded-Host is ignored without trustedProxy");
  assert.equal(check(headers, { trustedProxy: true }), true);
  assert.equal(check({ origin: "https://evil.example.com", host: "127.0.0.1:2633", "x-forwarded-host": "console.example.com" }, { trustedProxy: true }), false);
});

test("the scheme is compared only where the daemon knows it", function () {
  assert.equal(check({ origin: "http://console.lan:2633", host: "console.lan:2633" }, { tls: true }), false, "a TLS daemon serves https origins only");
  assert.equal(check({ origin: "https://console.lan:2633", host: "console.lan:2633" }, { tls: true }), true);
  assert.equal(check({ origin: "http://console.example.com", host: "console.example.com", "x-forwarded-proto": "https" }, { trustedProxy: true }), false);
  assert.equal(check({ origin: "https://console.example.com", host: "console.example.com", "x-forwarded-proto": "https" }, { trustedProxy: true }), true);
  assert.equal(check({ origin: "https://console.example.com", host: "console.example.com", "x-forwarded-proto": "https" }), true, "an unconfigured proxy's header is not consulted");
});

test("IPv6 hosts", function () {
  assert.equal(check({ origin: "http://[::1]:2633", host: "[::1]:2633" }), true);
  assert.equal(check({ origin: "http://[::1]:2633", host: "[::2]:2633" }), false);
  assert.equal(check({ origin: "https://[2001:db8::5]", host: "[2001:db8::5]" }), true);
});

test("clients with no Origin (CLI, relay, MCP bridge) are accepted", function () {
  assert.equal(check({ host: "console.lan:2633" }), true);
  assert.equal(check({}), true);
  assert.equal(check({ origin: "", host: "console.lan:2633" }), true);
});

test("an Origin with no Host header is refused", function () {
  assert.equal(check({ origin: "http://console.lan:2633" }), false);
});

test("origins that are not http(s) origins are refused: null, malformed, extension", function () {
  assert.equal(check({ origin: "null", host: "console.lan:2633" }), false);
  assert.equal(check({ origin: "not a url", host: "console.lan:2633" }), false);
  assert.equal(check({ origin: "file:///tmp/x.html", host: "console.lan:2633" }), false);
  assert.equal(check({ origin: "chrome-extension://abcdefghijklmnop", host: "console.lan:2633" }), false);
  assert.equal(check({ origin: ["http://console.lan:2633"], host: "console.lan:2633" }), false);
});

test("the operator's allowedOrigins list admits what the host check would refuse", function () {
  var allowed = ["https://console.example.com", "chrome-extension://abcdefghijklmnop"];
  assert.equal(check({ origin: "https://console.example.com", host: "127.0.0.1:2633" }, { allowedOrigins: allowed }), true);
  assert.equal(check({ origin: "https://console.example.com:443", host: "127.0.0.1:2633" }, { allowedOrigins: allowed }), true, "default port made explicit");
  assert.equal(check({ origin: "chrome-extension://abcdefghijklmnop", host: "127.0.0.1:2633" }, { allowedOrigins: allowed }), true);
  assert.equal(check({ origin: "chrome-extension://other", host: "127.0.0.1:2633" }, { allowedOrigins: allowed }), false);
  assert.equal(check({ origin: "https://evil.example.com", host: "127.0.0.1:2633" }, { allowedOrigins: allowed }), false);
  assert.equal(check({ origin: "https://console.example.com", host: "127.0.0.1:2633" }, { allowedOrigins: [5, null, {}] }), false);
});

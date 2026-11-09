"use strict";

// mcp-bridge-credential.js - the per-project credential the local MCP bridge
// child presents to the daemon. The daemon holds one random secret in memory
// for its lifetime (never written anywhere); the credential for a project is
// HMAC-SHA256(secret, slug), so a credential for one project is refused on any
// other. The peer address of a request grants nothing: a reverse proxy on the
// same host makes every client look local.

var crypto = require("crypto");

var ENV_NAME = "CLAGENTIC_CONSOLE_MCP_BRIDGE_TOKEN";
var HEADER_NAME = "x-clagentic-console-mcp-bridge-token";

var _secret = null;

function secret() {
  if (!_secret) _secret = crypto.randomBytes(32);
  return _secret;
}

function credentialFor(slug) {
  return crypto.createHmac("sha256", secret()).update(String(slug)).digest("hex");
}

// Constant-time and total: a missing, non-string or wrong-length value is a
// plain false. Both sides are hashed first so timingSafeEqual always sees
// equal-length buffers whatever the caller sent.
function verifyCredential(slug, presented) {
  if (typeof presented !== "string" || !presented) return false;
  var a = crypto.createHash("sha256").update(presented).digest();
  var b = crypto.createHash("sha256").update(credentialFor(slug)).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  ENV_NAME: ENV_NAME,
  HEADER_NAME: HEADER_NAME,
  credentialFor: credentialFor,
  verifyCredential: verifyCredential,
};

// client-address.js — one answer to "who is this client, and is it local?".
//
// The TCP peer is the client only when nothing sits in front of the daemon.
// Behind a same-host reverse proxy every client is the loopback peer, which
// collapses rate-limit buckets and audit records into one and makes proxied
// sockets look local.
//
// Address: with trustedProxy declared, X-Forwarded-For is used only when it is
// a single valid IP literal. A multi-valued chain, an invalid value or an
// absent header falls back to the peer; no hop is ever picked, for the same
// reason as lib/effective-protocol.js (trustedProxy is one boolean and cannot
// say which hop to trust). Without trustedProxy the header is ignored.
//
// Locality: a loopback peer with no forwarding header at all, whatever
// trustedProxy says, since a forwarding header means someone else is the client.

var net = require("net");

var LOOPBACK = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
var FORWARDING_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip"];

/**
 * @param {Object} req - http.IncomingMessage (or an object with headers/socket)
 * @param {boolean} trustedProxy - operator-declared proxy trust boundary
 * @returns {{address: string, local: boolean}}
 */
function resolveClientAddress(req, trustedProxy) {
  var headers = (req && req.headers) || {};
  var peer = (req && req.socket && req.socket.remoteAddress) || "";
  var address = peer;

  if (trustedProxy) {
    var xff = headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.indexOf(",") === -1) {
      var candidate = xff.trim();
      if (net.isIP(candidate)) address = candidate;
    }
  }

  var forwarded = FORWARDING_HEADERS.some(function (h) { return headers[h] !== undefined; });
  return { address: address, local: LOOPBACK.indexOf(peer) !== -1 && !forwarded };
}

module.exports = { resolveClientAddress: resolveClientAddress };

// effective-protocol.js — single source of truth for the EXTERNAL protocol a
// client actually reached this daemon over, as distinct from tlsOptions
// (daemon-internal TLS termination only, see lib/daemon.js).
//
// Root cause (lr-20e71c): tlsOptions is non-null only when the daemon itself
// terminates TLS from CONFIG_DIR/certs. A deployment fronted by a reverse
// proxy (e.g. Caddy) that terminates TLS and forwards plain HTTP to the
// daemon is genuinely served over HTTPS, but tlsOptions is correctly null —
// so any code that read tlsOptions as a stand-in for "is this HTTPS" (the
// System Settings badge, the share-URL protocol) reported a false negative.
//
// X-Forwarded-Proto is NOT trusted unconditionally — an untrusted client
// could set it to spoof an "Enabled" readout over what is really plain HTTP.
// It is only consulted when the operator has explicitly declared this
// deployment sits behind a trusted proxy (config.trustedProxy). Caddy sets
// the header automatically; the operator's config declaration is the trust
// boundary, not the header's mere presence.
//
// Multi-hop chains (comma-separated header value): per RFC 7239 / the de
// facto X-Forwarded-* convention, each proxy in a chain APPENDS its own
// value to the right, so the LEFTMOST entry is the value the ORIGINAL
// client supplied (attacker-controlled) and the RIGHTMOST is the value the
// hop closest to this daemon set. "Rightmost is authoritative" is only true
// when every hop between the client and this daemon is itself trusted not
// to pass an untouched client-supplied value through — and config.trustedProxy
// is a single boolean with no hop-count, so it cannot express "trust exactly
// the last N hops" or "trust hop closest to us but not earlier ones". A
// misconfigured or attacker-reachable intermediate hop could still leave an
// attacker-controlled value in the rightmost position under some proxy
// topologies. Given that ambiguity, a multi-valued header is treated as
// untrustworthy under this trust model and ignored entirely (falls through
// to "disabled") rather than guessing which position is safe. Operators
// running a single, directly-adjacent trusted proxy (the Caddy deployment
// this repo ships) always see a single-valued header and are unaffected;
// only a chain deeper than one hop is refused.

/**
 * Resolve the three possible states a deployment's external protocol can be in.
 *
 * @param {Object} params
 * @param {Object|null} params.tlsOptions - daemon-internal TLS cert material
 *   (non-null only when Node itself is terminating TLS). Name stays
 *   unchanged — it is NOT the effective-protocol source of truth.
 * @param {boolean} params.trustedProxy - operator-declared trust boundary
 *   for reading X-Forwarded-Proto from this request.
 * @param {string|null|undefined} params.forwardedProtoHeader - the raw
 *   X-Forwarded-Proto header value. A single value is trusted when
 *   trustedProxy is set; a comma-separated (multi-hop) value is rejected
 *   outright, since a single trustedProxy boolean cannot express which hop
 *   in the chain is the trustworthy one (see module comment above).
 * @returns {{protocol: "http"|"https", state: "direct"|"proxy"|"disabled"}}
 *   state drives the three badge renders: "direct" = daemon terminates TLS
 *   itself; "proxy" = a trusted proxy terminates TLS in front of the daemon;
 *   "disabled" = genuinely unencrypted, must stay visibly distinct from the
 *   other two.
 */
function resolveEffectiveProtocol(params) {
  var tlsOptions = params && params.tlsOptions;
  var trustedProxy = !!(params && params.trustedProxy);
  var forwardedProtoHeader = params && params.forwardedProtoHeader;

  if (tlsOptions) {
    return { protocol: "https", state: "direct" };
  }

  if (trustedProxy && forwardedProtoHeader) {
    var rawHeader = String(forwardedProtoHeader);
    // A multi-hop (comma-separated) value is refused rather than guessed at
    // — see module comment above for why neither "leftmost" nor "rightmost"
    // is safe to assume under a single-boolean trust model.
    if (rawHeader.indexOf(",") === -1) {
      var singleProto = rawHeader.trim().toLowerCase();
      if (singleProto === "https") {
        return { protocol: "https", state: "proxy" };
      }
    }
  }

  return { protocol: "http", state: "disabled" };
}

module.exports = { resolveEffectiveProtocol: resolveEffectiveProtocol };

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
 *   X-Forwarded-Proto header value (may be a comma-separated list; the
 *   first hop's value is authoritative).
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
    // Take the first hop's value — a proxy chain appends, closest-proxy-first.
    var firstProto = String(forwardedProtoHeader).split(",")[0].trim().toLowerCase();
    if (firstProto === "https") {
      return { protocol: "https", state: "proxy" };
    }
  }

  return { protocol: "http", state: "disabled" };
}

module.exports = { resolveEffectiveProtocol: resolveEffectiveProtocol };

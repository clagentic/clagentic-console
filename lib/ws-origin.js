// WebSocket upgrade origin check (defence in depth against cross-site
// WebSocket hijacking; every upgrade must also carry a valid login).
//
// Rules:
//   - No Origin header: a non-browser client (CLI, relay, MCP bridge). Allowed;
//     the login still applies.
//   - An Origin on the operator's allowedOrigins list: allowed.
//   - Otherwise the Origin's host AND port must equal those of the request's
//     Host header (or, only when the operator declared a trusted proxy, of its
//     X-Forwarded-Host). A bare port match is not enough: a sibling
//     subdomain that is served on the same port is a different origin.
//   - Scheme is compared only where the daemon knows it: it terminates TLS
//     itself (https required), or a trusted proxy reported it
//     (X-Forwarded-Proto). Behind an unconfigured TLS-terminating proxy the
//     scheme the daemon sees is not the browser's, so it is not compared; the
//     origin's own scheme only supplies the default port.
//   - Any Origin that is not a parsable http(s) origin (including "null" and
//     extension origins such as chrome-extension://...) is refused unless it
//     is on the allowed list.

function parseOrigin(value) {
  try {
    var url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch (e) {
    return null;
  }
}

function defaultPort(protocol) {
  return protocol === "https:" ? "443" : "80";
}

// "scheme://host:port" with the default port made explicit and the host
// lower-cased, or null when value is not an http(s) origin.
function normalizeOrigin(value) {
  var url = parseOrigin(value);
  if (!url) return null;
  return url.protocol + "//" + url.hostname + ":" + (url.port || defaultPort(url.protocol));
}

function hostMatches(originUrl, hostHeader) {
  if (!hostHeader) return false;
  var hostUrl;
  try {
    hostUrl = new URL(originUrl.protocol + "//" + hostHeader);
  } catch (e) {
    return false;
  }
  var originPort = originUrl.port || defaultPort(originUrl.protocol);
  var hostPort = hostUrl.port || defaultPort(originUrl.protocol);
  return originUrl.hostname === hostUrl.hostname && originPort === hostPort;
}

function firstValue(header) {
  if (typeof header !== "string") return "";
  return header.split(",")[0].trim();
}

// o: { headers, tls, trustedProxy, allowedOrigins }
// Returns { ok: boolean, reason?: string }.
function checkWsOrigin(o) {
  var headers = o.headers || {};
  var origin = headers.origin;
  if (origin === undefined || origin === "") return { ok: true };
  if (typeof origin !== "string") return { ok: false, reason: "malformed origin" };

  var allowed = Array.isArray(o.allowedOrigins) ? o.allowedOrigins : [];
  var normalized = normalizeOrigin(origin);
  for (var i = 0; i < allowed.length; i++) {
    if (typeof allowed[i] !== "string") continue;
    // Non-http(s) entries (extension origins) are compared as written.
    if (allowed[i] === origin) return { ok: true };
    if (normalized && normalizeOrigin(allowed[i]) === normalized) return { ok: true };
  }

  var originUrl = parseOrigin(origin);
  if (!originUrl) return { ok: false, reason: "origin is not an http(s) origin" };

  var hostOk = hostMatches(originUrl, headers.host);
  if (!hostOk && o.trustedProxy) {
    hostOk = hostMatches(originUrl, firstValue(headers["x-forwarded-host"]));
  }
  if (!hostOk) return { ok: false, reason: "origin host does not match the request host" };

  var knownScheme = null;
  if (o.tls) knownScheme = "https:";
  else if (o.trustedProxy) {
    var forwardedProto = firstValue(headers["x-forwarded-proto"]).toLowerCase();
    if (forwardedProto === "https" || forwardedProto === "http") knownScheme = forwardedProto + ":";
  }
  if (knownScheme && originUrl.protocol !== knownScheme) {
    return { ok: false, reason: "origin scheme does not match the connection" };
  }
  return { ok: true };
}

module.exports = { checkWsOrigin: checkWsOrigin };

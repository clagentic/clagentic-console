"use strict";

// OpenID Connect sign-in: the authorization code flow with PKCE.
//
// Read before writing, and what each step rests on:
//   OpenID Connect Core 1.0, section 3.1 (authorization code flow), 3.1.2.1
//     (authentication request: response_type, scope, client_id, redirect_uri,
//     state, nonce), 3.1.3.1 and 3.1.3.2 (token request and its client
//     authentication), 3.1.3.7 (ID token validation), 15.5.2 (nonce use) and
//     9 (client_secret_basic is the default client authentication method).
//   OpenID Connect Discovery 1.0, section 4 (the .well-known document) and
//     4.3 (the issuer in the document must equal the issuer used to find it).
//   RFC 7636 (PKCE), section 4.1 (code_verifier), 4.2 (S256 code_challenge),
//     4.3 (the request carries code_challenge and code_challenge_method) and
//     4.5 (the token request carries code_verifier).
//   RFC 6749, section 2.3.1 (client_secret_basic encodes the id and secret as
//     form-urlencoded before Base64) and 4.1.3 (the token request).
//   jose: jwtVerify (signature, exp, nbf, iss, aud checks; requiredClaims;
//     algorithms; clockTolerance) with createRemoteJWKSet (the provider's
//     jwks_uri, key choice by alg and kid, cached with a cooldown).
//
// The provider client secret is only ever placed in the token request. It is
// not logged, not returned and not copied into any error.

var crypto = require("crypto");
var { loadJose } = require("../identity/jose");

var KIND = "oidc";
var HTTP_TIMEOUT_MS = 5000;
var MAX_RESPONSE_BYTES = 256 * 1024;
var PENDING_TTL_MS = 10 * 60 * 1000;
var PENDING_MAX = 200;
var PENDING_PER_ADDRESS = 10;
var DISCOVERY_TTL_MS = 5 * 60 * 1000;
var DISCOVERY_FAILURE_TTL_MS = 10 * 1000;
var CLOCK_TOLERANCE_SECONDS = 60;
// Asymmetric algorithms only: a symmetric ID token would be verified against
// the client secret, which is not what this flow relies on.
var ASYMMETRIC_ALGS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];
var REQUIRED_CLAIMS = ["iss", "sub", "aud", "exp", "iat"];

// A failure the caller can map to a message. "unreachable" means the provider
// did not answer; every other code means it answered and the answer was refused.
function fail(code) {
  return { error: code };
}

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

// An endpoint carries the client secret and the sign-in itself, so it must be
// https. Plain http is accepted for loopback only, which is how a provider on
// the same host is reached in development.
function isAcceptableUrl(value) {
  var url;
  try { url = new URL(value); } catch (e) { return false; }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

// A short-lived, single-use record of each sign-in in progress, keyed by the
// state value sent to the provider. take() removes the entry, so a callback
// can be answered once.
function createPendingStore(now) {
  var clock = now || Date.now;
  var entries = new Map();

  function sweep() {
    var t = clock();
    entries.forEach(function (entry, key) {
      if (entry.expiresAt <= t) entries.delete(key);
    });
  }

  // The start route needs no login, so one client must not be able to push
  // another client's in-flight sign-in out. Each address has its own quota and
  // a full quota evicts that address's own oldest entry. The overall cap only
  // bounds memory across many addresses.
  return {
    put: function (state, entry, address) {
      sweep();
      var owner = typeof address === "string" ? address : "";
      var own = [];
      entries.forEach(function (existing, key) {
        if (existing.address === owner) own.push(key);
      });
      while (own.length >= PENDING_PER_ADDRESS) {
        entries.delete(own.shift());
      }
      while (entries.size >= PENDING_MAX) {
        entries.delete(entries.keys().next().value);
      }
      entries.set(state, Object.assign({ expiresAt: clock() + PENDING_TTL_MS }, entry, { address: owner }));
    },
    take: function (state) {
      var entry = entries.get(state);
      entries.delete(state);
      if (!entry || entry.expiresAt <= clock()) return null;
      return entry;
    },
    size: function () { return entries.size; },
  };
}

function createOidcProvider(options) {
  var opts = options || {};
  var fetchImpl = opts.fetch || function (url, init) { return fetch(url, init); };
  var clock = opts.now || Date.now;
  var pending = opts.pending || createPendingStore(clock);
  var discoveryCache = new Map();

  // The cap is enforced while reading: a declared length over it is refused
  // before any body is read, and the stream is cancelled once the bytes counted
  // pass it.
  function readJson(response) {
    var declared = Number(response.headers && response.headers.get && response.headers.get("content-length"));
    if (declared > MAX_RESPONSE_BYTES) {
      if (response.body && response.body.cancel) response.body.cancel().catch(function () {});
      return Promise.reject(new Error("response too large"));
    }
    if (!response.body || !response.body.getReader) {
      return response.text().then(function (text) {
        if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("response too large");
        return JSON.parse(text);
      });
    }
    var reader = response.body.getReader();
    var chunks = [];
    var total = 0;
    function pump() {
      return reader.read().then(function (step) {
        if (step.done) return JSON.parse(Buffer.concat(chunks).toString("utf8"));
        total += step.value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          return reader.cancel().catch(function () {}).then(function () {
            throw new Error("response too large");
          });
        }
        chunks.push(Buffer.from(step.value));
        return pump();
      });
    }
    return pump();
  }

  function request(url, init) {
    var withSignal = Object.assign({ redirect: "error", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }, init);
    return fetchImpl(url, withSignal);
  }

  // Discovery 4: GET <issuer>/.well-known/openid-configuration, with a
  // terminating slash on the issuer removed first. Discovery 4.3: the issuer
  // the document names must be exactly the one configured.
  // A failed lookup is remembered briefly so the unauthenticated status and
  // start routes cannot be used to make this server call the provider on every
  // request while it is down.
  function discover(cfg) {
    var issuer = cfg.issuer;
    var cached = discoveryCache.get(issuer);
    if (cached && cached.expiresAt > clock()) return cached.promise || Promise.resolve(cached.value);
    // The in-flight lookup is cached at once so callers arriving while a
    // hanging provider is still being waited on share it instead of each
    // starting another outbound request. lookup() always resolves.
    var inFlight = lookup(cfg).then(function (value) {
      var ttl = value.error ? DISCOVERY_FAILURE_TTL_MS : DISCOVERY_TTL_MS;
      discoveryCache.set(issuer, { value: value, expiresAt: clock() + ttl });
      return value;
    });
    discoveryCache.set(issuer, { promise: inFlight, expiresAt: Infinity });
    return inFlight;
  }

  function lookup(cfg) {
    var issuer = cfg.issuer;
    var url = issuer.replace(/\/+$/, "") + "/.well-known/openid-configuration";
    return request(url, { headers: { Accept: "application/json" } }).then(function (response) {
      if (!response.ok) return fail("unreachable");
      return readJson(response).then(function (meta) {
        var sane = meta && meta.issuer === issuer &&
          isAcceptableUrl(meta.authorization_endpoint) &&
          isAcceptableUrl(meta.token_endpoint) &&
          isAcceptableUrl(meta.jwks_uri);
        if (!sane) return fail("provider_metadata");
        return loadJose().then(function (jose) {
          return {
            meta: meta,
            jwks: jose.createRemoteJWKSet(new URL(meta.jwks_uri), { timeoutDuration: HTTP_TIMEOUT_MS }),
          };
        });
      });
    }).catch(function () {
      return fail("unreachable");
    });
  }

  // Core 9: a client with a secret authenticates with client_secret_basic
  // unless the provider advertises only client_secret_post.
  function clientAuth(meta, cfg, form, headers) {
    var methods = Array.isArray(meta.token_endpoint_auth_methods_supported) ? meta.token_endpoint_auth_methods_supported : null;
    var usePost = methods && methods.indexOf("client_secret_basic") === -1 && methods.indexOf("client_secret_post") !== -1;
    if (usePost) {
      form.set("client_id", cfg.clientId);
      form.set("client_secret", cfg.clientSecret);
    } else {
      var id = encodeURIComponent(cfg.clientId).replace(/%20/g, "+");
      var secret = encodeURIComponent(cfg.clientSecret).replace(/%20/g, "+");
      headers.Authorization = "Basic " + Buffer.from(id + ":" + secret).toString("base64");
      form.set("client_id", cfg.clientId);
    }
  }

  function signingAlgorithms(meta) {
    var advertised = Array.isArray(meta.id_token_signing_alg_values_supported) ? meta.id_token_signing_alg_values_supported : [];
    var usable = advertised.filter(function (alg) { return ASYMMETRIC_ALGS.indexOf(alg) !== -1; });
    // Core 15.1: RS256 is the algorithm every provider must support.
    return usable.length ? usable : ["RS256"];
  }

  return {
    kind: KIND,
    pending: pending,

    // The reason a configuration cannot be used, or null.
    validateConfig: function (cfg) {
      if (!cfg.issuer || !isAcceptableUrl(cfg.issuer)) return "The issuer must be an https URL.";
      if (!cfg.clientId) return "A client id is required.";
      if (!cfg.clientSecret) return "A client secret is required.";
      if (!cfg.allowedSubject) return "The allowed identity (subject) is required.";
      return null;
    },

    // The identity this configuration allows to sign in, as stored on the user.
    allowedIdentity: function (cfg) {
      return { provider: KIND, issuer: cfg.issuer, subject: cfg.allowedSubject };
    },

    // True when the provider answers discovery with a usable document.
    isAvailable: function (cfg) {
      return discover(cfg).then(function (found) { return !found.error; });
    },

    // Core 3.1.2.1 with PKCE (RFC 7636 4.1-4.3): returns the URL to send the
    // browser to and the state value to bind to that browser.
    begin: function (cfg, redirectUri, clientAddress) {
      return discover(cfg).then(function (found) {
        if (found.error) return found;
        var state = base64url(crypto.randomBytes(24));
        var nonce = base64url(crypto.randomBytes(24));
        var verifier = base64url(crypto.randomBytes(32));
        var challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
        pending.put(state, { nonce: nonce, verifier: verifier, redirectUri: redirectUri }, clientAddress);
        var url = new URL(found.meta.authorization_endpoint);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", cfg.clientId);
        url.searchParams.set("redirect_uri", redirectUri);
        url.searchParams.set("scope", "openid");
        url.searchParams.set("state", state);
        url.searchParams.set("nonce", nonce);
        url.searchParams.set("code_challenge", challenge);
        url.searchParams.set("code_challenge_method", "S256");
        return { url: url.toString(), state: state };
      });
    },

    // Core 3.1.3: exchange the code and validate the ID token (3.1.3.7).
    // stateCookie is the value the browser held from begin(); a callback whose
    // state is not the one this browser started is refused (login CSRF).
    complete: function (cfg, params) {
      var state = params && params.state;
      var code = params && params.code;
      if (typeof state !== "string" || !state || typeof code !== "string" || !code) return Promise.resolve(fail("callback"));
      var entry = pending.take(state);
      if (!entry) return Promise.resolve(fail("state"));
      if (params.stateCookie !== state) return Promise.resolve(fail("state"));
      if (!entry.verifier) return Promise.resolve(fail("pkce"));

      return discover(cfg).then(function (found) {
        if (found.error) return found;
        var form = new URLSearchParams();
        var headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
        form.set("grant_type", "authorization_code");
        form.set("code", code);
        form.set("redirect_uri", entry.redirectUri);
        form.set("code_verifier", entry.verifier);
        clientAuth(found.meta, cfg, form, headers);

        return request(found.meta.token_endpoint, { method: "POST", headers: headers, body: form.toString() })
          .then(function (response) {
            if (!response.ok) return fail("token_rejected");
            return readJson(response).then(function (tokens) {
              if (!tokens || typeof tokens.id_token !== "string") return fail("id_token");
              return verifyIdToken(found, cfg, tokens.id_token, entry);
            });
          }, function () { return fail("unreachable"); })
          .catch(function () { return fail("token_rejected"); });
      });
    },
  };

  // Core 3.1.3.7: signature against the provider's keys, issuer, audience,
  // expiry and issued-at; the nonce equals the one sent; with several
  // audiences, azp names this client.
  function verifyIdToken(found, cfg, idToken, entry) {
    return loadJose().then(function (jose) {
      return jose.jwtVerify(idToken, found.jwks, {
        issuer: cfg.issuer,
        audience: cfg.clientId,
        algorithms: signingAlgorithms(found.meta),
        requiredClaims: REQUIRED_CLAIMS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
    }).then(function (verified) {
      var claims = verified.payload;
      if (typeof claims.nonce !== "string" || claims.nonce !== entry.nonce) return fail("nonce");
      if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== cfg.clientId) return fail("id_token");
      if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) return fail("id_token");
      return { identity: { provider: KIND, issuer: claims.iss, subject: claims.sub } };
    }, function (err) {
      // A key set that could not be fetched is the provider being down; any
      // other verification error is a token that failed its checks.
      return fail(err && err.code === "ERR_JWKS_TIMEOUT" ? "unreachable" : "id_token");
    });
  }
}

module.exports = {
  KIND: KIND,
  createOidcProvider: createOidcProvider,
  createPendingStore: createPendingStore,
  isAcceptableUrl: isAcceptableUrl,
};

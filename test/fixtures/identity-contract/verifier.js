"use strict";

// A verifier of the Identity Assertion contract (version 1.0.0), written from the
// contract text (sections 2 to 6) and a standard JWS library, used by tests to
// check what the console issues. It is a test instrument: it shares no code with
// the console's identity surface and none with any issuer. It is proven against
// the vendored conformance vectors in this directory before it is trusted to
// judge anything else (test/identity-contract-vectors.test.js).

var fs = require("fs");
var path = require("path");

var ALGORITHMS = ["EdDSA", "ES256"];
var GRADES = ["workload", "harness"];
var ORIGINS = ["human", "scheduled", "loop", "trigger", "agent"];
var ACTOR_ANY = /^(human|agent|runtime):[A-Za-z0-9._-]{1,128}$/;
var ACTOR_CHAIN = /^(agent|runtime):[A-Za-z0-9._-]{1,128}$/;
var ROLE = /^[a-z][a-z0-9_-]{0,63}$/;
var BASE64URL = /^[A-Za-z0-9_-]*$/;

function fail(error) {
  return { ok: false, error: error };
}

function isObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function decodeObject(segment) {
  if (!BASE64URL.test(segment)) return null;
  try {
    var value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return isObject(value) ? value : null;
  } catch (e) {
    return null;
  }
}

function nonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function actorChainValid(act) {
  while (act !== undefined) {
    if (!isObject(act) || typeof act.sub !== "string" || !ACTOR_CHAIN.test(act.sub)) return false;
    act = act.act;
  }
  return true;
}

function claimsShapeValid(c) {
  var always = ["iss", "sub", "roles", "grade", "rt", "sid", "origin", "iat", "exp", "jti", "cia"];
  for (var i = 0; i < always.length; i++) if (c[always[i]] === undefined) return false;
  if (!nonEmptyString(c.iss) || typeof c.sub !== "string" || !ACTOR_ANY.test(c.sub)) return false;
  if (!Array.isArray(c.roles) || c.roles.some(function (r) { return typeof r !== "string" || !ROLE.test(r); })) return false;
  if (new Set(c.roles).size !== c.roles.length) return false;
  if (GRADES.indexOf(c.grade) === -1 || ORIGINS.indexOf(c.origin) === -1) return false;
  if (!isObject(c.rt) || !nonEmptyString(c.rt.id) || !nonEmptyString(c.rt.version)) return false;
  if (!nonEmptyString(c.sid) || !nonEmptyString(c.jti)) return false;
  if (c.spawn !== undefined && !nonEmptyString(c.spawn)) return false;
  if (c.act !== undefined && !actorChainValid(c.act)) return false;
  var hasAud = c.aud !== undefined;
  if (hasAud) {
    if (!nonEmptyString(c.aud) || c.dir !== undefined) return false;
  } else if (typeof c.dir !== "string" || c.dir[0] !== "/") {
    return false;
  }
  if (c.grade === "harness" && (c.act === undefined || c.spawn === undefined)) return false;
  return true;
}

// token: compact JWS. options: { trusted: { <iss>: <jwks object> }, mode: "local" | "peer",
// now: seconds, observedDir, peerId }. Returns { ok: true, actor, grade, claims } or { ok: false, error }.
async function verifyToken(token, options) {
  var jose = await import("jose");
  var parts = String(token).split(".");
  if (parts.length !== 3) return fail("malformed");
  var header = decodeObject(parts[0]);
  var claims = decodeObject(parts[1]);
  if (!header || !claims || header.crit !== undefined) return fail("malformed");

  if (ALGORITHMS.indexOf(header.alg) === -1) return fail("alg_not_allowed");
  if (typeof claims.iss !== "string" || !Object.prototype.hasOwnProperty.call(options.trusted, claims.iss)) {
    return fail("issuer_untrusted");
  }
  var jwk = (options.trusted[claims.iss].keys || []).filter(function (k) { return k.kid === header.kid; })[0];
  if (!jwk) return fail("key_not_found");

  var expectedType = header.alg === "EdDSA" ? { kty: "OKP", crv: "Ed25519" } : { kty: "EC", crv: "P-256" };
  if (jwk.kty !== expectedType.kty || jwk.crv !== expectedType.crv) return fail("signature_invalid");
  try {
    // Only the three segments as sent are verified; header members that name keys
    // (jku, jwk, x5u, x5c) are never consulted.
    await jose.compactVerify(token, await jose.importJWK(jwk, header.alg), { algorithms: [header.alg] });
  } catch (e) {
    return fail("signature_invalid");
  }

  if (claims.cia !== 1) return fail("contract_version_unsupported");

  var now = options.now;
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) return fail("claims_invalid");
  if (claims.nbf !== undefined && !Number.isInteger(claims.nbf)) return fail("claims_invalid");
  if (claims.exp <= now) return fail("expired");
  if ((claims.nbf !== undefined && now < claims.nbf) || claims.iat > now) return fail("not_yet_valid");
  if (claims.exp - claims.iat > 43200) return fail("ttl_exceeded");

  if (!claimsShapeValid(claims)) return fail("claims_invalid");

  if (options.mode === "peer") {
    if (claims.aud === undefined || claims.aud !== options.peerId) return fail("audience_mismatch");
  } else {
    if (claims.aud !== undefined) return fail("audience_unexpected");
    if (path.normalize(claims.dir) !== path.normalize(options.observedDir)) return fail("dir_mismatch");
  }

  var actor = claims.act !== undefined ? claims.act.sub : claims.sub;
  return { ok: true, actor: actor, grade: claims.grade, claims: claims };
}

// The delivery checks of section 6 for a directory named by `dir` (or unset).
function checkDelivery(dir) {
  if (dir === undefined || dir === "" || !path.isAbsolute(dir)) return fail("identity_dir_missing");
  var st;
  try { st = fs.lstatSync(dir); } catch (e) { return fail("identity_dir_missing"); }
  if (st.isSymbolicLink()) return fail("identity_dir_unsafe");
  if (!st.isDirectory()) return fail("identity_dir_missing");
  if (st.uid !== process.getuid() || (st.mode & 0o077) !== 0) return fail("identity_dir_unsafe");
  var file = path.join(dir, "identity.jwt");
  var fst;
  try { fst = fs.lstatSync(file); } catch (e) { return fail("identity_file_missing"); }
  if (fst.isSymbolicLink() || !fst.isFile()) return fail("identity_file_symlink");
  if (fst.size > 16384) return fail("malformed");
  return { ok: true, content: fs.readFileSync(file, "utf8") };
}

module.exports = { verifyToken: verifyToken, checkDelivery: checkDelivery };

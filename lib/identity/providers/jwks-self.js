"use strict";

// Class 2: the console is its own issuer. It signs contract-conformant session
// assertions with its own key and publishes the matching key set, so any verifier
// that trusts this console's `iss` can check them with a standard JWS library and
// no other software installed.
//
// What this is, and is not. The console asserts what it knows about its own
// session. Its key is readable by the console's own user, so the assertion is
// attribution-grade (grade "harness": an actor that exists inside a host process,
// asserted by that host) and never workload-grade.
//
// No human. The console never signs a `human:` subject or actor. `sub` is the
// runtime and `act.sub` the persona agent when the session has one, else the
// runtime again. That a person typed the turn is carried by the `origin` claim
// only.

var crypto = require("crypto");
var contract = require("../contract");
var signingKey = require("./signing-key");
var unavailableModule = require("../unavailable");
var pkg = require("../../../package.json");

var unavailable = unavailableModule.unavailable;

function runtimeActor(rt) {
  return "runtime:" + rt;
}

function buildClaims(cfg, definition, origin, rt, dir) {
  var now = Math.floor(Date.now() / 1000);
  var hasDefinition = typeof definition === "string" && contract.NAME_PATTERN.test(definition);
  return {
    iss: cfg.issuer,
    sub: runtimeActor(rt),
    act: { sub: hasDefinition ? "agent:" + definition : runtimeActor(rt) },
    roles: cfg.roles.slice(),
    grade: "harness",
    rt: { id: rt, version: pkg.version },
    sid: crypto.randomUUID(),
    spawn: crypto.randomUUID(),
    origin: origin,
    dir: dir,
    iat: now,
    exp: now + cfg.ttlSeconds,
    jti: crypto.randomUUID(),
    cia: contract.CONTRACT_MAJOR,
  };
}

function createJwksSelfProvider(cfg) {
  var signerPromise = null;

  function signer() {
    if (!signerPromise) {
      signerPromise = signingKey.loadSigner(cfg).catch(function (err) {
        // A failure is not cached: fixing the key and starting the next session works.
        signerPromise = null;
        throw err;
      });
    }
    return signerPromise;
  }

  async function obtainSession(definition, origin, rt, ctx) {
    if (!contract.NAME_PATTERN.test(rt)) return unavailable("runtime_invalid", "the runtime id is not a valid actor name");
    if (contract.ORIGINS.indexOf(origin) === -1) return unavailable("origin_invalid", "the turn's origin is not one the contract defines");
    var s;
    try {
      s = await signer();
    } catch (err) {
      if (err && err.identityCode) return unavailable(err.identityCode, err.message);
      throw err;
    }
    var dir = await ctx.allocateDir();
    var assertion = await new s.jose.SignJWT(buildClaims(cfg, definition, origin, rt, dir))
      .setProtectedHeader({ alg: s.alg, kid: s.kid })
      .sign(s.privateKey);
    return { provider: contract.PROVIDERS.JWKS_SELF, dir: dir, assertion: assertion };
  }

  return { name: contract.PROVIDERS.JWKS_SELF, obtainSession: obtainSession };
}

module.exports = { createJwksSelfProvider: createJwksSelfProvider };

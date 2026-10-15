"use strict";

// Reads the `identity` block of the console configuration (daemon.json).
//
//   identity.provider            "none" (default) | "gatekeeper" | "jwks-self" | "module"
//   identity.spawn_root          where session delivery directories are created
//
//   gatekeeper:   identity.gatekeeper.socket      issuer socket (absolute path)
//                 identity.gatekeeper.binary      client executable, default "gatekeeper"
//                 identity.gatekeeper.timeout_ms  bound on one request
//   jwks-self:    identity.signing_key            private key (PEM, PKCS#8 Ed25519)
//                 identity.jwks_path              where the public key set is published
//                 identity.issuer                 `iss` of the assertions, default file URL of jwks_path
//                 identity.roles                  role ceiling the assertions carry, default none
//                 identity.ttl_seconds            assertion lifetime, default 3600, at most 43200
//   module:       identity.provider_module        absolute path of a user-supplied provider
//
// An absent block, or provider "none", is the default: the console does nothing
// identity-related. A block that cannot be understood is reported as provider
// "invalid" so every session says so instead of silently running unattested.

var path = require("path");
var url = require("url");
var contract = require("./contract");

var DEFAULT_TTL_SECONDS = 3600;
var DEFAULT_GATEKEEPER_BINARY = "gatekeeper";
var DEFAULT_TIMEOUT_MS = 8000;

function none() {
  return { provider: "none" };
}

function invalid(reason) {
  return { provider: "invalid", reason: reason };
}

function isAbsolutePath(value) {
  return typeof value === "string" && value !== "" && path.isAbsolute(value);
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function commonFields(raw, configDir) {
  var spawnRoot = raw.spawn_root === undefined ? path.join(configDir, "identity", "spawn") : raw.spawn_root;
  if (!isAbsolutePath(spawnRoot)) return { error: "identity.spawn_root must be an absolute path" };
  return { spawnRoot: spawnRoot };
}

function gatekeeperConfig(raw, common) {
  var gk = raw.gatekeeper;
  if (!isObject(gk) || !isAbsolutePath(gk.socket)) {
    return invalid("identity.gatekeeper.socket must be an absolute path");
  }
  var binary = gk.binary === undefined ? DEFAULT_GATEKEEPER_BINARY : gk.binary;
  if (typeof binary !== "string" || binary === "") return invalid("identity.gatekeeper.binary must be a string");
  var timeout = gk.timeout_ms === undefined ? DEFAULT_TIMEOUT_MS : gk.timeout_ms;
  if (!Number.isInteger(timeout) || timeout <= 0) return invalid("identity.gatekeeper.timeout_ms must be a positive integer");
  return { provider: "gatekeeper", spawnRoot: common.spawnRoot, socket: gk.socket, binary: binary, timeoutMs: timeout };
}

function jwksSelfConfig(raw, common, configDir) {
  var signingKey = raw.signing_key === undefined ? path.join(configDir, "identity", "signing-key.pem") : raw.signing_key;
  var jwksPath = raw.jwks_path === undefined ? path.join(configDir, "identity", "jwks.json") : raw.jwks_path;
  if (!isAbsolutePath(signingKey)) return invalid("identity.signing_key must be an absolute path");
  if (!isAbsolutePath(jwksPath)) return invalid("identity.jwks_path must be an absolute path");
  var issuer = raw.issuer === undefined ? url.pathToFileURL(jwksPath).href : raw.issuer;
  if (typeof issuer !== "string" || issuer === "") return invalid("identity.issuer must be a string");
  var roles = raw.roles === undefined ? [] : raw.roles;
  if (!Array.isArray(roles) || roles.some(function (r) { return !contract.ROLE_PATTERN.test(r); }) || new Set(roles).size !== roles.length) {
    return invalid("identity.roles must be a list of distinct role names");
  }
  var ttl = raw.ttl_seconds === undefined ? DEFAULT_TTL_SECONDS : raw.ttl_seconds;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > contract.MAX_LIFETIME_SECONDS) {
    return invalid("identity.ttl_seconds must be between 1 and " + contract.MAX_LIFETIME_SECONDS);
  }
  return {
    provider: "jwks-self",
    spawnRoot: common.spawnRoot,
    signingKey: signingKey,
    // Only the default key is created when it is missing: a key path someone
    // named is never replaced by a freshly generated one.
    generateKey: raw.signing_key === undefined,
    jwksPath: jwksPath,
    issuer: issuer,
    roles: roles.slice(),
    ttlSeconds: ttl,
  };
}

function resolveConfig(raw, configDir) {
  if (raw === undefined || raw === null) return none();
  if (!isObject(raw)) return invalid("identity must be an object");
  var name = raw.provider;
  if (name === undefined) name = raw.provider_module === undefined ? "none" : "module";
  if (name === "none") return none();
  if (typeof name !== "string") return invalid("identity.provider must be a string");
  if (raw.provider_module !== undefined && name !== "module") {
    return invalid("identity.provider_module cannot be combined with identity.provider " + name);
  }
  var common = commonFields(raw, configDir);
  if (common.error) return invalid(common.error);
  switch (name) {
    case contract.PROVIDERS.GATEKEEPER:
      return gatekeeperConfig(raw, common);
    case contract.PROVIDERS.JWKS_SELF:
      return jwksSelfConfig(raw, common, configDir);
    case "module":
      if (!isAbsolutePath(raw.provider_module)) return invalid("identity.provider_module must be an absolute path");
      return { provider: "module", spawnRoot: common.spawnRoot, modulePath: raw.provider_module };
    default:
      return invalid("identity.provider " + JSON.stringify(name.slice(0, 40)) + " is not one the console knows");
  }
}

module.exports = { resolveConfig: resolveConfig };

"use strict";

// Constants of the published Identity Assertion contract (version 1.0.0). The
// console implements the contract from its text, a JWS library and the vendored
// conformance vectors; it shares no code with any issuer.

var CONTRACT_VERSION = "1.0.0";
var CONTRACT_MAJOR = 1;

// What the console delivers a session's assertion through.
var IDENTITY_DIR_ENV = "CLAGENTIC_IDENTITY_DIR";
var IDENTITY_FILE = "identity.jwt";
var IDENTITY_TMP_DIR = "tmp";

var MAX_LIFETIME_SECONDS = 43200;
var MAX_FILE_BYTES = 16384;
var MAX_JWKS_BYTES = 65536;

var ALGORITHMS = Object.freeze(["EdDSA", "ES256"]);
var GRADES = Object.freeze(["workload", "harness"]);
var ORIGINS = Object.freeze(["human", "scheduled", "loop", "trigger", "agent"]);

var ACTOR_PATTERN = /^(agent|runtime):[A-Za-z0-9._-]{1,128}$/;
var SUBJECT_PATTERN = /^(human|agent|runtime):[A-Za-z0-9._-]{1,128}$/;
var ROLE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
var NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

// The names providers record on a session. "declared" is the record of a
// session that has no assertion: the console says what it did, nothing is signed.
var PROVIDERS = Object.freeze({
  GATEKEEPER: "gatekeeper",
  JWKS_SELF: "jwks-self",
  DECLARED: "declared",
});

module.exports = {
  CONTRACT_VERSION: CONTRACT_VERSION,
  CONTRACT_MAJOR: CONTRACT_MAJOR,
  IDENTITY_DIR_ENV: IDENTITY_DIR_ENV,
  IDENTITY_FILE: IDENTITY_FILE,
  IDENTITY_TMP_DIR: IDENTITY_TMP_DIR,
  MAX_LIFETIME_SECONDS: MAX_LIFETIME_SECONDS,
  MAX_FILE_BYTES: MAX_FILE_BYTES,
  MAX_JWKS_BYTES: MAX_JWKS_BYTES,
  ALGORITHMS: ALGORITHMS,
  GRADES: GRADES,
  ORIGINS: ORIGINS,
  ACTOR_PATTERN: ACTOR_PATTERN,
  SUBJECT_PATTERN: SUBJECT_PATTERN,
  ROLE_PATTERN: ROLE_PATTERN,
  NAME_PATTERN: NAME_PATTERN,
  PROVIDERS: PROVIDERS,
};

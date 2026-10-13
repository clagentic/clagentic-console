"use strict";

// codex-version.js - reading and comparing Codex versions. The console runs the
// Codex the user installed, so every protocol decision starts from a version
// that is read defensively from text the console does not control: a binary's
// version output and the userAgent string an app-server reports.

// The oldest Codex the console drives. Below it the app-server lacks the
// thread operations the console relies on (thread/revert from this version on).
var MIN_CODEX_VERSION = "0.148.0";

// A whole whitespace-separated token must be the version: a token with junk
// before or after the numbers ("abc0.150.0", "0.150.0abc") is not one, so text
// that merely contains digits is never taken for a version.
var VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

/**
 * Reads the first token of a text that is exactly x.y.z[-pre]. Returns null when
 * there is none, so a caller never acts on a version it could not read.
 * @param {*} text
 * @returns {?{major: number, minor: number, patch: number, pre: ?string, text: string}}
 */
function parseVersion(text) {
  if (typeof text !== "string" || text.length > 4096) return null;
  var tokens = text.split(/\s+/);
  var m = null;
  for (var i = 0; i < tokens.length && !m; i++) m = VERSION_RE.exec(tokens[i]);
  if (!m) return null;
  var major = parseInt(m[1], 10);
  var minor = parseInt(m[2], 10);
  var patch = parseInt(m[3], 10);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return {
    major: major,
    minor: minor,
    patch: patch,
    pre: m[4] || null,
    text: major + "." + minor + "." + patch + (m[4] ? "-" + m[4] : ""),
  };
}

/**
 * The version the app-server embeds in its userAgent, "<originator>/<version>
 * (<platform details>)". The originator is read as everything before the first
 * slash so a digit in it is never taken for the version.
 * @param {*} userAgent
 * @returns {?object} parseVersion's result
 */
function versionFromUserAgent(userAgent) {
  if (typeof userAgent !== "string") return null;
  var m = /^[^/\s]*\/(\S+)/.exec(userAgent.trim());
  return m ? parseVersion(m[1]) : null;
}

function asParsed(value) {
  if (value && typeof value === "object" && typeof value.major === "number") return value;
  return parseVersion(value);
}

function comparePre(a, b) {
  // A release outranks its own prerelease; prereleases compare part by part.
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  var pa = a.split(".");
  var pb = b.split(".");
  for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    var na = /^\d+$/.test(pa[i]);
    var nb = /^\d+$/.test(pb[i]);
    if (na && nb) {
      var d = parseInt(pa[i], 10) - parseInt(pb[i], 10);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * -1, 0 or 1. Either side may be text or a parsed version; an unreadable side
 * throws, since an ordering of an unknown version would be a guess.
 */
function compareVersions(a, b) {
  var va = asParsed(a);
  var vb = asParsed(b);
  if (!va || !vb) throw new Error("[YOKE] cannot compare an unreadable Codex version");
  var keys = ["major", "minor", "patch"];
  for (var i = 0; i < keys.length; i++) {
    if (va[keys[i]] !== vb[keys[i]]) return va[keys[i]] < vb[keys[i]] ? -1 : 1;
  }
  return comparePre(va.pre, vb.pre);
}

/** Whether a version is at least a minimum; false for an unreadable version. */
function atLeast(version, minimum) {
  var v = asParsed(version);
  return !!v && compareVersions(v, minimum) >= 0;
}

module.exports = {
  MIN_CODEX_VERSION: MIN_CODEX_VERSION,
  parseVersion: parseVersion,
  versionFromUserAgent: versionFromUserAgent,
  compareVersions: compareVersions,
  atLeast: atLeast,
};

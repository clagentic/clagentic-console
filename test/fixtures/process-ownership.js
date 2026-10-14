"use strict";

// Decides whether a pid belongs to one test harness instance. A pid read from a
// file (daemon.json) is data the test does not control, so it is signalled only
// when the process itself carries this instance's random token in its
// environment. The token is compared whole: no path or prefix reasoning, so a
// sibling temp dir or another run's daemon can never match.

var crypto = require("crypto");
var fs = require("fs");

var TOKEN_ENV = "CLAGENTIC_CONSOLE_TEST_HARNESS_TOKEN";

function newHarnessToken() {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * @param {number} pid
 * @param {string} token the harness instance's token
 * @returns {{ok: boolean, reason?: string}} ok:false means "do not signal";
 *   an unreadable /proc entry is unverified, never owned.
 */
function verifyOwnedPid(pid, token) {
  if (!token) return { ok: false, reason: "no harness token to compare against" };
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, reason: "not a usable pid" };
  var environ;
  try {
    environ = fs.readFileSync("/proc/" + pid + "/environ", "utf8").split("\0");
  } catch (e) {
    return { ok: false, reason: "its /proc environment cannot be read (" + e.code + ")" };
  }
  var want = TOKEN_ENV + "=" + token;
  return environ.some(function (entry) { return entry === want; })
    ? { ok: true }
    : { ok: false, reason: "its environment does not carry this harness's token" };
}

module.exports = { TOKEN_ENV, newHarnessToken, verifyOwnedPid };

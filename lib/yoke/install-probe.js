// install-probe.js - finds out which registered agents are installed, for the
// daemon's own user or for a specific OS user. Every executable name looked up
// must belong to a registered vendor (registry.binaryNames): the name reaches
// a shell command for the OS-user case, so an unregistered name is refused with
// a named error instead of being passed on.

var execFileSync = require("child_process").execFileSync;
var registry = require("./registry");

var LOOKUP_TIMEOUT_MS = 3000;

/**
 * Path of a registered executable on PATH, or null when the lookup fails (an
 * empty string means the lookup succeeded but printed nothing).
 * @param {string} name   must be a registered binary name
 * @param {?string} linuxUser  look it up as this OS user instead
 */
function findBinaryPath(name, linuxUser) {
  registry.assertAllowedBinary(name);
  try {
    var out;
    if (linuxUser) {
      out = execFileSync("su", ["-", linuxUser, "-c", "which " + name], { timeout: LOOKUP_TIMEOUT_MS, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    } else if (process.platform === "win32") {
      out = execFileSync("where", [name], { timeout: LOOKUP_TIMEOUT_MS, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    } else {
      out = execFileSync("which", [name], { timeout: LOOKUP_TIMEOUT_MS, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    }
    return String(out).trim().split(/\r?\n/)[0];
  } catch (e) {
    return null;
  }
}

/**
 * Ids of the registered vendors that are installed.
 * @param {?string} linuxUser
 * @returns {string[]}
 */
function detectInstalledVendors(linuxUser) {
  var found = [];
  registry.list().forEach(function (vendor) {
    var installed = vendor.probeInstalled({
      lookupBinary: function (name) { return findBinaryPath(name, linuxUser) !== null; },
    });
    if (installed) found.push(vendor.id);
  });
  return found;
}

module.exports = {
  findBinaryPath: findBinaryPath,
  detectInstalledVendors: detectInstalledVendors,
};

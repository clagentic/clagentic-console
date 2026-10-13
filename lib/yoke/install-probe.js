// install-probe.js - finds out which registered agents are installed, for the
// daemon's own user or for a specific OS user. Every executable name looked up
// must belong to a registered vendor (registry.binaryNames): the name reaches
// a shell command for the OS-user case, so an unregistered name is refused with
// a named error instead of being passed on.
//
// A lookup has three outcomes, never two: found, not installed, or the lookup
// itself failed (timeout, permission, su or which unusable). A failed lookup
// is reported as such so the picker can say it could not check, instead of
// telling the user an installed agent is missing.

var execFileSync = require("child_process").execFileSync;
var registry = require("./registry");

var LOOKUP_TIMEOUT_MS = 3000;
var PROBE_FAILED_CODE = "YOKE_PROBE_FAILED";

function ProbeFailedError(probeClass, cause) {
  var err = new Error("[YOKE] Install lookup failed: " + probeClass + (cause && cause.message ? " (" + cause.message + ")" : ""));
  err.code = PROBE_FAILED_CODE;
  err.probeClass = probeClass;
  return err;
}

/**
 * Names why a lookup command did not succeed.
 * @param {Error} e  what execFileSync threw
 * @param {boolean} asUser  the lookup ran through su
 * @returns {?string} null when the command ran and found nothing, otherwise
 *   the failure class
 */
function classifyLookupFailure(e, asUser) {
  if (e && (e.code === "ETIMEDOUT" || e.killed || e.signal)) return "timeout";
  if (e && (e.code === "EACCES" || e.code === "EPERM")) return "permission-denied";
  if (e && e.code === "ENOENT") return asUser ? "su-unavailable" : "lookup-tool-missing";
  var stderr = e && e.stderr ? String(e.stderr).trim() : "";
  // which exits 1 and prints nothing when the name is not on PATH. Output on
  // stderr with that exit is su (or the shell) failing, not the name missing.
  if (e && e.status === 1 && !stderr) return null;
  return asUser ? "su-failed" : "lookup-failed";
}

/**
 * Outcome of looking up one registered executable.
 * @param {string} name   must be a registered binary name
 * @param {?string} linuxUser  look it up as this OS user instead
 * @returns {{state: "found", path: string}|{state: "missing"}|{state: "failed", probeClass: string}}
 */
function probeBinary(name, linuxUser) {
  registry.assertAllowedBinary(name);
  var options = { timeout: LOOKUP_TIMEOUT_MS, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] };
  try {
    var out;
    if (linuxUser) {
      out = execFileSync("su", ["-", linuxUser, "-c", "which " + name], options);
    } else if (process.platform === "win32") {
      out = execFileSync("where", [name], options);
    } else {
      out = execFileSync("which", [name], options);
    }
    return { state: "found", path: String(out).trim().split(/\r?\n/)[0] };
  } catch (e) {
    var probeClass = classifyLookupFailure(e, !!linuxUser);
    return probeClass ? { state: "failed", probeClass: probeClass } : { state: "missing" };
  }
}

/**
 * Path of a registered executable on PATH, or null when it was not found or
 * the lookup failed. Callers that must tell the two apart use probeBinary.
 * @param {string} name   must be a registered binary name
 * @param {?string} linuxUser  look it up as this OS user instead
 */
function findBinaryPath(name, linuxUser) {
  var result = probeBinary(name, linuxUser);
  return result.state === "found" ? result.path : null;
}

/**
 * Which registered vendors are installed, and which could not be checked.
 * @param {?string} linuxUser
 * @returns {{installed: string[], failures: Object<string, string>}}
 *   failures maps a vendor id to the class of the lookup failure
 */
function detectVendorInstallState(linuxUser) {
  var installed = [];
  var failures = {};
  var details = {};
  registry.list().forEach(function (vendor) {
    try {
      var outcome = vendor.probeInstalled({
        linuxUser: linuxUser || null,
        lookupBinary: function (name) {
          var result = probeBinary(name, linuxUser);
          if (result.state === "failed") throw ProbeFailedError(result.probeClass);
          return result.state === "found";
        },
        // For a probe that does its own lookup and reached a failed one.
        failed: function (probeClass) { throw ProbeFailedError(probeClass); },
      });
      // A probe answers with whether the agent is installed, or with that and
      // what it found (path, version) or why it is not usable.
      var found = outcome && typeof outcome === "object" ? outcome.installed : outcome;
      if (outcome && typeof outcome === "object" && outcome.detail) details[vendor.id] = outcome.detail;
      if (found) installed.push(vendor.id);
    } catch (e) {
      if (!e || e.code !== PROBE_FAILED_CODE) throw e;
      failures[vendor.id] = e.probeClass;
    }
  });
  return { installed: installed, failures: failures, details: details };
}

/**
 * Ids of the registered vendors that are installed.
 * @param {?string} linuxUser
 * @returns {string[]}
 */
function detectInstalledVendors(linuxUser) {
  return detectVendorInstallState(linuxUser).installed;
}

module.exports = {
  classifyLookupFailure: classifyLookupFailure,
  probeBinary: probeBinary,
  findBinaryPath: findBinaryPath,
  detectVendorInstallState: detectVendorInstallState,
  detectInstalledVendors: detectInstalledVendors,
};

// link-trap.js — refuses to run a daemon from an `npm link` install.
//
// `npm link` / `npm install -g <workspace-path>` creates a symlink at the
// UNSCOPED package name next to the scoped global install
// (<node_modules>/clagentic-console beside <node_modules>/@clagentic/console).
// With that symlink present, edits in a working tree go live in the daemon
// without a pack/install step.
//
// Two places are checked, because the daemon may be reached either way:
//   - beside the package dir, when it sits in a scoped global install;
//   - beside the global node_modules implied by the bin path it was invoked
//     through (<prefix>/bin/clagentic-console -> <prefix>/lib/node_modules),
//     which is the only signal left when the bin symlink resolves into a
//     working tree. A plain dev checkout matches neither and is never flagged.

var fs = require("fs");
var path = require("path");

/**
 * @param {string} pkgDir  Package root (the directory holding package.json).
 * @param {object} [opts]
 * @param {string} [opts.binPath]  The path the CLI was invoked through (argv[1]).
 * @param {object} [opts.fs]       fs-like exposing lstatSync; for tests.
 * @returns {string|null} The offending symlink path, or null.
 * @throws {LinkTrapProbeError} A candidate could not be inspected for a reason
 *   other than not existing; callers must refuse to start.
 */
function findLinkTrap(pkgDir, opts) {
  opts = opts || {};
  var fsImpl = opts.fs || fs;
  var candidates = [];

  var scopeDir = path.dirname(pkgDir);
  if (path.basename(scopeDir) === "@clagentic") {
    candidates.push(path.join(path.dirname(scopeDir), "clagentic-console"));
  }
  if (opts.binPath && path.basename(path.dirname(opts.binPath)) === "bin") {
    var prefix = path.dirname(path.dirname(opts.binPath));
    candidates.push(path.join(prefix, "lib", "node_modules", "clagentic-console"));
  }

  for (var i = 0; i < candidates.length; i++) {
    var isLink;
    try {
      isLink = fsImpl.lstatSync(candidates[i]).isSymbolicLink();
    } catch (e) {
      // Only "nothing there" means no trap. Any other failure (EACCES, ELOOP,
      // EIO, ...) leaves the question unanswered, and starting a daemon from a
      // possibly linked working tree is the thing this guard exists to stop.
      if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) continue;
      throw new LinkTrapProbeError(candidates[i], e);
    }
    if (isLink) return candidates[i];
  }
  return null;
}

/** Thrown by findLinkTrap when a candidate path cannot be inspected. */
function LinkTrapProbeError(probedPath, cause) {
  var errno = cause && cause.code ? cause.code : "UNKNOWN";
  this.name = "LinkTrapProbeError";
  this.code = "LINK_TRAP_PROBE_FAILED";
  this.path = probedPath;
  this.errno = errno;
  this.message = "cannot check " + probedPath + " for an npm link trap (" + errno + (cause && cause.message ? ": " + cause.message : "") + ")";
}
LinkTrapProbeError.prototype = Object.create(Error.prototype);
LinkTrapProbeError.prototype.constructor = LinkTrapProbeError;

function linkTrapMessage(trap) {
  return [
    "ERROR: " + trap + " is a symlink (npm link trap). Remove it before starting:",
    "  rm " + trap,
    "Then reinstall via: npm pack --pack-destination <dir> && npm install -g <dir>/clagentic-console-*.tgz",
  ].join("\n");
}

module.exports = { findLinkTrap: findLinkTrap, linkTrapMessage: linkTrapMessage, LinkTrapProbeError: LinkTrapProbeError };

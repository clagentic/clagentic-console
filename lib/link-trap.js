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
    try {
      if (fsImpl.lstatSync(candidates[i]).isSymbolicLink()) return candidates[i];
    } catch (e) {
      // absent: not a trap
    }
  }
  return null;
}

function linkTrapMessage(trap) {
  return [
    "ERROR: " + trap + " is a symlink (npm link trap). Remove it before starting:",
    "  rm " + trap,
    "Then reinstall via: npm pack --pack-destination <dir> && npm install -g <dir>/clagentic-console-*.tgz",
  ].join("\n");
}

module.exports = { findLinkTrap: findLinkTrap, linkTrapMessage: linkTrapMessage };

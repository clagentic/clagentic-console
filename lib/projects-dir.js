// projects-dir.js — where new projects (create / clone) are placed.
//
// The directories resolved here hold users' git repositories. Daemon config
// stores ABSOLUTE project paths under them, worktrees reference them, and
// session history is keyed by the encoded cwd. So this module only ever
// READS the filesystem (stat). It never moves, renames, copies or links.
//
// Resolution order (non-os-users mode):
//   1. config.projectsDir, when set.
//   2. The console-scoped default, when it already exists. Console only ever
//      creates it when no legacy dir existed, so its presence means console
//      already chose it; a legacy-named dir that appeared later (the bare
//      brand name is shared by other clagentic products) must not redirect
//      where new projects land.
//   3. A legacy dir, when one exists: used in place.
//   4. The console-scoped default (created by the caller on first use).
//
// os-users mode keeps ignoring config.projectsDir, as it always has, and uses
// a system path instead of a home-relative one.

var fs = require("fs");
var path = require("path");

var DEFAULT_DIRNAME = "clagentic-console-projects";
// FHS: variable state data belongs under /var/lib/<name>.
var OS_USERS_DEFAULT_DIR = "/var/lib/clagentic-console/projects";
var OS_USERS_LEGACY_DIR = "/var/clagentic/projects";
var HOME_LEGACY_DIRNAMES = ["clagentic-projects", "clay-projects"];

function isDirectory(fsImpl, p) {
  try {
    return fsImpl.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {object} opts.config      Daemon config ({projectsDir, osUsers}).
 * @param {string} opts.realHome
 * @param {object} [opts.fs]        fs-like exposing statSync only; for tests.
 * @returns {{dir: string, source: "config"|"default"|"legacy", legacy: boolean}}
 */
function resolveProjectsDir(opts) {
  var config = opts.config || {};
  var fsImpl = opts.fs || fs;

  if (config.osUsers) {
    if (isDirectory(fsImpl, OS_USERS_DEFAULT_DIR)) {
      return { dir: OS_USERS_DEFAULT_DIR, source: "default", legacy: false };
    }
    if (isDirectory(fsImpl, OS_USERS_LEGACY_DIR)) {
      return { dir: OS_USERS_LEGACY_DIR, source: "legacy", legacy: true };
    }
    return { dir: OS_USERS_DEFAULT_DIR, source: "default", legacy: false };
  }

  if (config.projectsDir) {
    return { dir: config.projectsDir, source: "config", legacy: false };
  }

  var defaultDir = path.join(opts.realHome, DEFAULT_DIRNAME);
  if (isDirectory(fsImpl, defaultDir)) {
    return { dir: defaultDir, source: "default", legacy: false };
  }
  for (var i = 0; i < HOME_LEGACY_DIRNAMES.length; i++) {
    var legacyDir = path.join(opts.realHome, HOME_LEGACY_DIRNAMES[i]);
    if (isDirectory(fsImpl, legacyDir)) {
      return { dir: legacyDir, source: "legacy", legacy: true };
    }
  }
  return { dir: defaultDir, source: "default", legacy: false };
}

/**
 * One-line startup notice for a legacy resolution, or null.
 */
function legacyNotice(resolved, configFile) {
  if (!resolved || !resolved.legacy) return null;
  return "[daemon] Projects directory " + resolved.dir + " is a legacy location; it is used in place and is not moved or copied. " +
    "To choose another location for NEW projects, set \"projectsDir\" in " + configFile + ".";
}

module.exports = {
  resolveProjectsDir: resolveProjectsDir,
  legacyNotice: legacyNotice,
  OS_USERS_DEFAULT_DIR: OS_USERS_DEFAULT_DIR,
  OS_USERS_LEGACY_DIR: OS_USERS_LEGACY_DIR,
};

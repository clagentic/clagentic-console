// project-bootstrap.js - the processes the daemon starts to create a project on
// behalf of a user: `git init` for a new project and `git clone` for a cloned
// one. daemon.js cannot be required, so the account handling lives here, where
// it is reached the same way by the daemon and by its tests.
//
// In os-users mode both run as the creator's Linux account, started through
// the shared as-account helper (os-users.js asUser). A creator with no mapped
// account, or whose account is gone, is refused with a named error; nothing is
// ever created as the daemon account in their place.

var fs = require("fs");
var childProcess = require("child_process");
var osUsers = require("./os-users");

/**
 * The account a project is created as, or null when os-users mode is off or no
 * user is creating it (those keep the daemon's behaviour). Throws an
 * OsUserError for a creator that is present but cannot be run as.
 * @returns {?{linuxUser: string, info: object}}
 */
function resolveCreator(osUsersMode, wsUser) {
  if (!osUsersMode || !wsUser) return null;
  return osUsers.resolveUserAccount(wsUser);
}

/**
 * `git init` in targetDir, as the creator's account in os-users mode: the
 * directory is handed to the account first, and git runs as it.
 */
function initRepo(o) {
  var creator = resolveCreator(o.osUsers, o.wsUser);
  if (!creator) {
    childProcess.execFileSync("git", ["init"], { cwd: o.targetDir });
    return;
  }
  // Settled before the directory is touched: a refused spawn leaves it as it was.
  var run = osUsers.asUser(creator.info, "git", ["init"], { cwd: o.targetDir });
  fs.chmodSync(o.targetDir, 0o700);
  childProcess.execFileSync("chown", ["-R", creator.info.uid + ":" + creator.info.gid, o.targetDir]);
  childProcess.execFileSync(run.command, run.args, run.options);
}

/**
 * What to spawn for `git clone`: { command, args, options }. Without an account
 * it is git with the daemon's environment plus the clone's own overrides, as
 * before; with one it is the account's, with only the overrides added.
 * cloneArgSpec: { args, envOverrides } from buildCloneArgs.
 */
function cloneSpawnSpec(account, cloneArgSpec, baseDir) {
  var options = { cwd: baseDir };
  if (!account) {
    options.env = Object.assign({}, process.env, cloneArgSpec.envOverrides);
    return { command: "git", args: cloneArgSpec.args, options: options };
  }
  options.env = cloneArgSpec.envOverrides;
  return osUsers.asUser(account.info, "git", cloneArgSpec.args, options);
}

module.exports = { resolveCreator: resolveCreator, initRepo: initRepo, cloneSpawnSpec: cloneSpawnSpec };

"use strict";

// os-user-spawn.js - the one way the daemon starts a process as another OS
// user. Node's own uid/gid spawn options set the user and group but drop every
// supplementary group, so a process started that way loses access that the
// user's groups grant. This runs the command through setpriv with the user's
// groups initialized, and describes the call as data so it can be checked
// without a process being started.
//
// The caller states the user as a resolved identity (os-users.resolveOsUserInfo)
// and is refused when it is missing or is root: a process is never started as
// the daemon's user in place of a user who was meant to be isolated.

var fs = require("fs");
var childProcess = require("child_process");

var SETPRIV_PATHS = ["/usr/bin/setpriv", "/bin/setpriv", "/usr/sbin/setpriv", "/sbin/setpriv"];

function refusal(code, message) {
  var err = new Error("[os-users] " + message);
  err.code = code;
  return err;
}

/** The setpriv executable on this host, or null. */
function findSetpriv(exists) {
  var check = exists || fs.existsSync;
  for (var i = 0; i < SETPRIV_PATHS.length; i++) {
    if (check(SETPRIV_PATHS[i])) return SETPRIV_PATHS[i];
  }
  return null;
}

var _warnedNoSetpriv = false;

function assertIdentity(osUserInfo) {
  if (!osUserInfo || typeof osUserInfo !== "object") {
    throw refusal("OS_USER_UNMAPPED", "no OS user identity; refusing to start the process as the daemon's user");
  }
  if (!Number.isInteger(osUserInfo.uid) || !Number.isInteger(osUserInfo.gid) || osUserInfo.uid <= 0 || osUserInfo.gid < 0) {
    throw refusal("OS_USER_INVALID", "refusing to start a process as uid " + osUserInfo.uid + " gid " + osUserInfo.gid);
  }
}

/**
 * How to start a command as an OS user.
 * @param {string} command
 * @param {string[]} args
 * @param {{uid: number, gid: number}} osUserInfo  a resolved identity
 * @param {object} options  spawn options, without uid or gid; env is the
 *   complete environment of the process (the daemon's is never inherited)
 * @param {{exists: function}} [deps]
 * @returns {{command: string, args: string[], options: object, groupsInitialized: boolean}}
 */
function spawnSpecAsUser(command, args, osUserInfo, options, deps) {
  assertIdentity(osUserInfo);
  var opts = Object.assign({}, options);
  if ("uid" in opts || "gid" in opts) {
    throw refusal("OS_USER_INVALID", "the user is named by the identity, not by spawn options");
  }
  var setpriv = findSetpriv(deps && deps.exists);
  if (setpriv) {
    return {
      command: setpriv,
      args: ["--reuid", String(osUserInfo.uid), "--regid", String(osUserInfo.gid), "--init-groups", "--", command].concat(args || []),
      options: opts,
      groupsInitialized: true,
    };
  }
  if (!_warnedNoSetpriv) {
    _warnedNoSetpriv = true;
    console.warn("[os-users] setpriv is not installed: processes run as the OS user without the user's supplementary groups. Install util-linux to keep them.");
  }
  return {
    command: command,
    args: (args || []).slice(),
    options: Object.assign(opts, { uid: osUserInfo.uid, gid: osUserInfo.gid }),
    groupsInitialized: false,
  };
}

/** child_process.spawn as an OS user. */
function spawnAsUser(command, args, osUserInfo, options, deps) {
  var spec = spawnSpecAsUser(command, args, osUserInfo, options, deps);
  return ((deps && deps.spawn) || childProcess.spawn)(spec.command, spec.args, spec.options);
}

/** child_process.execFileSync as an OS user. */
function execFileSyncAsUser(command, args, osUserInfo, options, deps) {
  var spec = spawnSpecAsUser(command, args, osUserInfo, options, deps);
  return ((deps && deps.execFileSync) || childProcess.execFileSync)(spec.command, spec.args, spec.options);
}

module.exports = {
  findSetpriv: findSetpriv,
  spawnSpecAsUser: spawnSpecAsUser,
  spawnAsUser: spawnAsUser,
  execFileSyncAsUser: execFileSyncAsUser,
};

'use strict';

// supervisor.js — is a service manager responsible for this daemon's lifetime?
//
// Under systemd the unit restarts the daemon after it exits (Restart=always),
// and KillMode=mixed removes every other process in the unit's cgroup when the
// main process exits. A daemon that spawned its own replacement before exiting
// therefore had the replacement killed with the rest of the cgroup, and the
// restart worked only because the unit started another one. A supervised
// restart is an exit with RESTART_EXIT_CODE and nothing else.

// Also the code the dev watcher (lib/cli/daemon-launch.js) respawns on.
var RESTART_EXIT_CODE = 120;

// Set by systemd for every process it starts as part of a unit.
var SUPERVISOR_ENV = ['INVOCATION_ID', 'NOTIFY_SOCKET'];

function isSupervised(env) {
  var e = env || process.env;
  return SUPERVISOR_ENV.some(function (name) { return !!e[name]; });
}

/**
 * The environment for a daemon this process starts itself (the CLI's detached
 * start, a self-spawned replacement). That daemon is not the unit's main
 * process, so it must not read the unit's variables, which it would inherit
 * when the CLI itself was run from inside a service.
 */
function unsupervisedEnv(env) {
  var copy = Object.assign({}, env || process.env);
  SUPERVISOR_ENV.forEach(function (name) { delete copy[name]; });
  return copy;
}

module.exports = {
  RESTART_EXIT_CODE: RESTART_EXIT_CODE,
  isSupervised: isSupervised,
  unsupervisedEnv: unsupervisedEnv,
};

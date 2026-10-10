#!/usr/bin/env node
'use strict';

// postinstall.js — installs/updates the systemd service unit on Linux global npm installs.
// Runs automatically after `npm install -g @clagentic/console`.
// Does nothing on non-Linux platforms, on non-global installs (a local `npm ci` /
// `npm install` in a dev checkout or worktree must never touch /etc/systemd or
// /usr/local/bin), and for non-root invocations.
//
// All host effects go through the `deps` object so tests can stub the filesystem,
// systemctl and the environment; the exported run() is what main() calls with real ones.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const {
  LEGACY_WRAPPER_PATH,
  isLegacyWrapperContent,
  isGlobalInstall,
  resolveCliBin,
  renderUnit,
} = require('../lib/service-install');

const PREFIX = '[clagentic-console postinstall]';

const SYSTEMD_DIR = '/etc/systemd/system';
const NEW_UNIT = 'clagentic-console.service';
const OLD_UNIT = 'clagentic.service';
const UNIT_SRC = path.join(__dirname, '..', 'deploy', 'clagentic-console.service');
const PKG_DIR = path.join(__dirname, '..');

function errMsg(err) {
  // execFileSync puts detail in err.stderr; fall back to err.message.
  const stderr = err.stderr && err.stderr.toString().trim();
  return stderr || err.message;
}

function realDeps() {
  return {
    fs,
    env: process.env,
    platform: process.platform,
    getuid: () => process.getuid(),
    systemdDir: SYSTEMD_DIR,
    legacyWrapperPath: LEGACY_WRAPPER_PATH,
    pkgDir: PKG_DIR,
    unitSrc: UNIT_SRC,
    log: (msg) => console.log(`${PREFIX} ${msg}`),
    // Returns stdout string on success, throws on failure.
    runCmd: (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' }).toString().trim(),
    loadConfig: () => require('../lib/config').loadConfig(),
    applyDropIn: (limits, logFn) => require('../lib/memory-limits').applyDropIn(limits, logFn),
    parseMemoryLimit: (v) => require('../lib/memory-limits').parseMemoryLimit(v),
  };
}

// Removes the hand-placed legacy wrapper only when it is byte-for-byte the known
// legacy content; an operator-modified file is left alone.
function removeLegacyWrapper(deps) {
  const { fs: fsx, log, legacyWrapperPath } = deps;
  let content;
  try {
    content = fsx.readFileSync(legacyWrapperPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return 'absent';
    log(`WARNING: could not read ${legacyWrapperPath}: ${errMsg(err)}`);
    return 'unreadable';
  }
  if (!isLegacyWrapperContent(content)) {
    log(`${legacyWrapperPath} differs from the known legacy wrapper — leaving it in place`);
    return 'modified';
  }
  try {
    fsx.unlinkSync(legacyWrapperPath);
    log(`removed legacy wrapper ${legacyWrapperPath} (the unit now runs "clagentic-console daemon")`);
    return 'removed';
  } catch (err) {
    log(`WARNING: remove ${legacyWrapperPath} failed: ${errMsg(err)}`);
    return 'failed';
  }
}

function applyMemoryDropIn(deps) {
  const { log, runCmd } = deps;
  // When the operator has NOT set memoryHigh/memoryMax in daemon.json, the
  // drop-in is still written — with ABSOLUTE byte values computed from
  // /proc/meminfo MemTotal (floor(60%) / floor(75%)) — because a `%` directive
  // in the shipped unit file is resolved by systemd against the wrong MemTotal
  // inside an LXC container; only userspace sees the lxcfs-corrected value.
  // Recomputed on every postinstall so it tracks RAM changes. Operator
  // overrides in daemon.json always keep precedence.
  const cfg = deps.loadConfig();
  const memoryHigh = cfg && cfg.memoryHigh ? String(cfg.memoryHigh) : null;
  const memoryMax  = cfg && cfg.memoryMax  ? String(cfg.memoryMax)  : null;

  // Validate operator-supplied values before writing — reject garbage early.
  // (Computed defaults are always well-formed bare-byte strings, so no
  // validation is needed for that path.)
  if (memoryHigh) {
    const vr = deps.parseMemoryLimit(memoryHigh);
    if (!vr.ok) {
      log(`WARNING: ignoring invalid memoryHigh value in daemon.json: ${vr.error}`);
      return;
    }
  }
  if (memoryMax) {
    const vr = deps.parseMemoryLimit(memoryMax);
    if (!vr.ok) {
      log(`WARNING: ignoring invalid memoryMax value in daemon.json: ${vr.error}`);
      return;
    }
  }

  try {
    deps.applyDropIn({ memoryHigh, memoryMax }, (msg) => log(msg.replace(/^\[memory-limits\] /, '')));
    log('running systemctl daemon-reload (memory drop-in updated)');
    try {
      runCmd('systemctl', ['daemon-reload']);
    } catch (err) {
      log(`WARNING: daemon-reload (memory drop-in) failed: ${errMsg(err)}`);
    }
  } catch (err) {
    log(`WARNING: memory drop-in apply failed: ${err.message}`);
  }
}

function run(deps) {
  const { fs: fsx, env, log, runCmd } = deps;

  // Skip silently on non-Linux platforms.
  if (deps.platform !== 'linux') return 'skipped-platform';

  // A local install (npm ci / npm install in a checkout, a crew worktree, or an npx
  // cache) is not the production install. Acting on it as root rewrote the live unit
  // and ran daemon-reload on the production host.
  if (!isGlobalInstall(env)) {
    log('skipping (not a global install: npm_config_global/npm_config_location not set)');
    return 'skipped-not-global';
  }

  // Skip when not running as root — cannot write to /etc/systemd/system/.
  if (deps.getuid() !== 0) {
    log('skipping (not root)');
    return 'skipped-not-root';
  }

  // When the daemon triggers its own in-app update it passes CLAGENTIC_CONSOLE_SELF_UPDATE=1.
  // In that case, skip restarting the service — the daemon calls gracefulShutdown()
  // immediately after npm install completes, and systemd Restart=always handles the
  // supervised restart. Issuing systemctl restart here would race with gracefulShutdown
  // and tear down sessions before state is flushed.
  const { readConsoleEnv } = require('../lib/env-compat');
  const selfUpdate = readConsoleEnv('CLAGENTIC_CONSOLE_SELF_UPDATE', { env }) === '1';
  if (selfUpdate) {
    log('self-update detected (CLAGENTIC_CONSOLE_SELF_UPDATE=1) — skipping service restart');
  }

  const newUnitDest = path.join(deps.systemdDir, NEW_UNIT);
  const oldUnitPath = path.join(deps.systemdDir, OLD_UNIT);

  // Step 0: Resolve the installed bin the unit will run; refuse to write a unit that
  // points nowhere.
  const cliBin = resolveCliBin({ env, pkgDir: deps.pkgDir });
  if (!cliBin) {
    log(`ERROR: cannot determine the global clagentic-console bin path from ${deps.pkgDir}; unit not installed`);
    return 'error-no-bin';
  }

  // Step 1: Render and write the new unit file.
  log(`installing unit file -> ${newUnitDest} (ExecStart=${cliBin} daemon)`);
  try {
    const rendered = renderUnit(fsx.readFileSync(deps.unitSrc, 'utf8'), cliBin);
    fsx.writeFileSync(newUnitDest, rendered);
  } catch (err) {
    log(`ERROR installing unit file: ${errMsg(err)}`);
    // Cannot continue without the unit file in place.
    return 'error-unit';
  }

  // Step 2: daemon-reload to pick up the new unit file.
  log('running systemctl daemon-reload');
  try {
    runCmd('systemctl', ['daemon-reload']);
  } catch (err) {
    // systemd still holds the previous ExecStart, which points at the legacy
    // wrapper. Removing the wrapper now would make the next Restart=always fail,
    // so keep it, stop here and fail the install step with the reason.
    log(`ERROR: daemon-reload failed: ${errMsg(err)}; the new unit is written but not loaded, the legacy wrapper ${deps.legacyWrapperPath} is kept. Run "systemctl daemon-reload" and reinstall.`);
    return 'error-reload';
  }

  // Step 3: Enable the new unit if not already enabled.
  log(`enabling ${NEW_UNIT}`);
  try {
    runCmd('systemctl', ['enable', NEW_UNIT]);
  } catch (err) {
    log(`WARNING: enable ${NEW_UNIT} failed: ${errMsg(err)}`);
  }

  // Step 3b: The reload above succeeded, so systemd now runs the new ExecStart and the
  // hand-placed wrapper is unreferenced; clean it up if untouched.
  removeLegacyWrapper(deps);

  // Step 4: Handle rename — migrate from old clagentic.service if present.
  let wasRunningUnderOldUnit = false;
  if (fsx.existsSync(oldUnitPath)) {
    log(`old unit file detected: ${oldUnitPath} — performing rename cutover`);

    // Detect whether the old unit is currently active before stopping it.
    try {
      const activeState = runCmd('systemctl', ['is-active', OLD_UNIT]);
      if (activeState === 'active') {
        wasRunningUnderOldUnit = true;
      }
    } catch (_) {
      // is-active exits non-zero when not active — not an error.
    }

    log(`disabling ${OLD_UNIT}`);
    try {
      runCmd('systemctl', ['disable', OLD_UNIT]);
    } catch (err) {
      log(`WARNING: disable ${OLD_UNIT} failed (ignored): ${errMsg(err)}`);
    }

    log(`stopping ${OLD_UNIT}`);
    try {
      runCmd('systemctl', ['stop', OLD_UNIT]);
    } catch (err) {
      log(`WARNING: stop ${OLD_UNIT} failed (ignored): ${errMsg(err)}`);
    }

    log(`removing ${oldUnitPath}`);
    try {
      fsx.unlinkSync(oldUnitPath);
    } catch (err) {
      log(`WARNING: remove ${oldUnitPath} failed: ${errMsg(err)}`);
    }

    // daemon-reload again to clear the old unit from systemd's view.
    log('running systemctl daemon-reload (post-rename)');
    try {
      runCmd('systemctl', ['daemon-reload']);
    } catch (err) {
      log(`WARNING: daemon-reload (post-rename) failed: ${errMsg(err)}`);
    }
  }

  // Step 5: Start clagentic-console.service only if it was running under the old unit
  // and needs to be moved to the new one. Never restart a running service — that kills
  // live sessions. Never auto-start on a fresh install — the daemon needs configuration.
  // Self-updates use gracefulShutdown() + Restart=always; postinstall must not interfere.
  if (selfUpdate) {
    log('skipping start (self-update — gracefulShutdown will hand off to systemd)');
  } else if (wasRunningUnderOldUnit) {
    log(`starting ${NEW_UNIT} (was running under ${OLD_UNIT})`);
    try {
      runCmd('systemctl', ['start', NEW_UNIT]);
    } catch (err) {
      log(`WARNING: start ${NEW_UNIT} failed: ${errMsg(err)}`);
    }
  } else {
    log('skipping start (daemon was not running or is already running — operator controls restarts)');
  }

  // Step 6: Apply the memory-limit drop-in.
  applyMemoryDropIn(deps);

  log('done');
  return 'installed';
}

module.exports = { run, realDeps, removeLegacyWrapper };

if (require.main === module) {
  if (run(realDeps()) === 'error-reload') process.exitCode = 1;
}

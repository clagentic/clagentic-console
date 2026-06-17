#!/usr/bin/env node
'use strict';

// postinstall.js — installs/updates the systemd service unit on Linux global npm installs.
// Runs automatically after `npm install -g @clagentic/console`.
// Silently exits on non-Linux platforms and non-root invocations.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PREFIX = '[clagentic-console postinstall]';

function log(msg) {
  console.log(`${PREFIX} ${msg}`);
}

function runCmd(cmd, args) {
  // Returns stdout string on success, throws on failure.
  // stderr is captured in err.stderr on failure.
  return execFileSync(cmd, args, { stdio: 'pipe' }).toString().trim();
}

function errMsg(err) {
  // execFileSync puts detail in err.stderr; fall back to err.message.
  const stderr = err.stderr && err.stderr.toString().trim();
  return stderr || err.message;
}

// Skip silently on non-Linux platforms.
if (process.platform !== 'linux') {
  process.exit(0);
}

// Skip silently when not running as root — cannot write to /etc/systemd/system/.
if (process.getuid() !== 0) {
  log('skipping (not root)');
  process.exit(0);
}

// When the daemon triggers its own in-app update it passes CLAGENTIC_SELF_UPDATE=1.
// In that case, skip restarting the service — the daemon calls gracefulShutdown()
// immediately after npm install completes, and systemd Restart=always handles the
// supervised restart. Issuing systemctl restart here would race with gracefulShutdown
// and tear down sessions before state is flushed.
const selfUpdate = process.env.CLAGENTIC_SELF_UPDATE === '1';
if (selfUpdate) {
  log('self-update detected (CLAGENTIC_SELF_UPDATE=1) — skipping service restart');
}

const SYSTEMD_DIR = '/etc/systemd/system';
const NEW_UNIT = 'clagentic-console.service';
const OLD_UNIT = 'clagentic.service';
const NEW_UNIT_DEST = path.join(SYSTEMD_DIR, NEW_UNIT);
const OLD_UNIT_PATH = path.join(SYSTEMD_DIR, OLD_UNIT);
const UNIT_SRC = path.join(__dirname, '..', 'deploy', 'clagentic-console.service');

// Step 1: Copy the new unit file.
log(`installing unit file -> ${NEW_UNIT_DEST}`);
try {
  fs.copyFileSync(UNIT_SRC, NEW_UNIT_DEST);
} catch (err) {
  log(`ERROR copying unit file: ${errMsg(err)}`);
  // Cannot continue without the unit file in place.
  process.exit(0);
}

// Step 2: daemon-reload to pick up the new unit file.
log('running systemctl daemon-reload');
try {
  runCmd('systemctl', ['daemon-reload']);
} catch (err) {
  log(`WARNING: daemon-reload failed: ${errMsg(err)}`);
}

// Step 3: Enable the new unit if not already enabled.
log(`enabling ${NEW_UNIT}`);
try {
  runCmd('systemctl', ['enable', NEW_UNIT]);
} catch (err) {
  log(`WARNING: enable ${NEW_UNIT} failed: ${errMsg(err)}`);
}

// Step 4: Handle rename — migrate from old clagentic.service if present.
let wasRunningUnderOldUnit = false;
if (fs.existsSync(OLD_UNIT_PATH)) {
  log(`old unit file detected: ${OLD_UNIT_PATH} — performing rename cutover`);

  // Detect whether the old unit is currently active before stopping it.
  try {
    const activeState = runCmd('systemctl', ['is-active', OLD_UNIT]);
    if (activeState === 'active') {
      wasRunningUnderOldUnit = true;
    }
  } catch (_) {
    // is-active exits non-zero when not active — not an error.
  }

  // Disable the old unit.
  log(`disabling ${OLD_UNIT}`);
  try {
    runCmd('systemctl', ['disable', OLD_UNIT]);
  } catch (err) {
    log(`WARNING: disable ${OLD_UNIT} failed (ignored): ${errMsg(err)}`);
  }

  // Stop the old unit.
  log(`stopping ${OLD_UNIT}`);
  try {
    runCmd('systemctl', ['stop', OLD_UNIT]);
  } catch (err) {
    log(`WARNING: stop ${OLD_UNIT} failed (ignored): ${errMsg(err)}`);
  }

  // Remove the old unit file.
  log(`removing ${OLD_UNIT_PATH}`);
  try {
    fs.unlinkSync(OLD_UNIT_PATH);
  } catch (err) {
    log(`WARNING: remove ${OLD_UNIT_PATH} failed: ${errMsg(err)}`);
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
  // Stopped the old unit during rename cutover — start under the new one now.
  log(`starting ${NEW_UNIT} (was running under ${OLD_UNIT})`);
  try {
    runCmd('systemctl', ['start', NEW_UNIT]);
  } catch (err) {
    log(`WARNING: start ${NEW_UNIT} failed: ${errMsg(err)}`);
  }
} else {
  log(`skipping start (daemon was not running or is already running — operator controls restarts)`);
}

log('done');

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

function runCmd(cmd, args, opts) {
  // Returns stdout string on success, throws on failure.
  return execFileSync(cmd, args, { stdio: 'pipe', ...opts }).toString().trim();
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
  log(`ERROR copying unit file: ${err.message}`);
  // Cannot continue without the unit file in place.
  process.exit(0);
}

// Step 2: daemon-reload to pick up the new unit file.
log('running systemctl daemon-reload');
try {
  runCmd('systemctl', ['daemon-reload']);
} catch (err) {
  log(`WARNING: daemon-reload failed: ${err.message}`);
}

// Step 3: Enable the new unit if not already enabled.
log(`enabling ${NEW_UNIT}`);
try {
  runCmd('systemctl', ['enable', NEW_UNIT]);
} catch (err) {
  log(`WARNING: enable ${NEW_UNIT} failed: ${err.message}`);
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

  // Disable the old unit (suppress errors — may already be disabled).
  log(`disabling ${OLD_UNIT}`);
  try {
    runCmd('systemctl', ['disable', OLD_UNIT]);
  } catch (err) {
    log(`WARNING: disable ${OLD_UNIT} failed (ignored): ${err.message}`);
  }

  // Stop the old unit (suppress errors — may already be stopped).
  log(`stopping ${OLD_UNIT}`);
  try {
    runCmd('systemctl', ['stop', OLD_UNIT]);
  } catch (err) {
    log(`WARNING: stop ${OLD_UNIT} failed (ignored): ${err.message}`);
  }

  // Remove the old unit file.
  log(`removing ${OLD_UNIT_PATH}`);
  try {
    fs.unlinkSync(OLD_UNIT_PATH);
  } catch (err) {
    log(`WARNING: remove ${OLD_UNIT_PATH} failed: ${err.message}`);
  }

  // daemon-reload again to clear the old unit from systemd's view.
  log('running systemctl daemon-reload (post-rename)');
  try {
    runCmd('systemctl', ['daemon-reload']);
  } catch (err) {
    log(`WARNING: daemon-reload (post-rename) failed: ${err.message}`);
  }
}

// Step 5: Start or restart clagentic-console.service.
let newUnitActive = false;
try {
  const activeState = runCmd('systemctl', ['is-active', NEW_UNIT]);
  newUnitActive = activeState === 'active';
} catch (_) {
  // is-active exits non-zero when not active.
}

if (newUnitActive) {
  // Already running — restart so new unit file changes (memory limits, env, etc.) take effect.
  log(`restarting ${NEW_UNIT} (already active, applying unit file changes)`);
  try {
    runCmd('systemctl', ['restart', NEW_UNIT]);
  } catch (err) {
    log(`WARNING: restart ${NEW_UNIT} failed: ${err.message}`);
  }
} else if (wasRunningUnderOldUnit) {
  // Was running under the old unit — start it under the new one now.
  log(`starting ${NEW_UNIT} (was running under ${OLD_UNIT})`);
  try {
    runCmd('systemctl', ['start', NEW_UNIT]);
  } catch (err) {
    log(`WARNING: start ${NEW_UNIT} failed: ${err.message}`);
  }
} else {
  // Not currently running and was not running under old unit — start fresh.
  log(`starting ${NEW_UNIT}`);
  try {
    runCmd('systemctl', ['start', NEW_UNIT]);
  } catch (err) {
    log(`WARNING: start ${NEW_UNIT} failed: ${err.message}`);
  }
}

log('done');

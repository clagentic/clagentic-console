#!/usr/bin/env node
'use strict';

// check-sdk-lock-drift.js — fail when the installed build ships a different
// Agent SDK than the one package-lock.json pins.
//
// WHY: `npm install -g <tarball>` ignores package-lock.json (the lock is not
// published and there is no npm-shrinkwrap.json), so the caret ranges in
// package.json resolve afresh at install time. `npm ci` / `npm test` in a
// checkout exercise the locked SDK while the running service executes whatever
// the registry resolved at install time. This check closes that gap after the
// fact: it compares the versions of the SDK packages inside the globally
// installed build against the versions recorded in this tree's lock and exits
// non-zero on any difference. It runs as part of `npm run verify:installed-build`,
// the post-merge step that is already configured on_failure: fail, so drift
// blocks the merge chain instead of being logged and ignored.
//
// WHY A CHECK AND NOT npm-shrinkwrap.json: a shrinkwrap would make this lock —
// a generated file maintained for CI — the install-time source of truth for
// every end user, and would freeze transitive security fixes into published
// releases until the next release is cut. A bad entry would then surface as a
// user-facing install failure rather than a red post-merge step. The check
// keeps the lock a development artifact and turns any divergence into a loud,
// attributable failure at the one moment both sides are known.
//
// Exit codes: 0 = installed SDK versions match the lock; 1 = drift, or the
// lock/installed versions could not be read (an unreadable side is never
// treated as a match).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TRACKED_PACKAGES = ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk'];

function readLockedVersions(lockPath, names) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const packages = lock && lock.packages;
  if (!packages || typeof packages !== 'object') {
    throw new Error(`${lockPath} has no "packages" map (lockfileVersion 2 or 3 expected)`);
  }
  const versions = {};
  for (const name of names) {
    const entry = packages[`node_modules/${name}`];
    if (!entry || typeof entry.version !== 'string') {
      throw new Error(`${lockPath} has no locked version for ${name}`);
    }
    versions[name] = entry.version;
  }
  return versions;
}

// A package that is absent from the installed tree is reported as null so the
// caller can tell "missing" from "different"; any other read failure throws.
function readInstalledVersions(installedRoot, names) {
  const versions = {};
  for (const name of names) {
    const pkgJson = path.join(installedRoot, 'node_modules', ...name.split('/'), 'package.json');
    let raw;
    try {
      raw = fs.readFileSync(pkgJson, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        versions[name] = null;
        continue;
      }
      throw err;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.version !== 'string') {
      throw new Error(`${pkgJson} has no "version" field`);
    }
    versions[name] = parsed.version;
  }
  return versions;
}

function findDrift(locked, installed) {
  return Object.keys(locked)
    .filter((name) => installed[name] !== locked[name])
    .map((name) => ({ name, locked: locked[name], installed: installed[name] }));
}

function formatDrift(drift, installedRoot) {
  const lines = drift.map((d) =>
    `  ${d.name}: lock pins ${d.locked}, installed build has ${d.installed === null ? '(not installed)' : d.installed}`
  );
  return (
    `[check-sdk-lock-drift] SDK_LOCK_DRIFT: the installed build (${installedRoot}) does not match package-lock.json:\n` +
    `${lines.join('\n')}\n` +
    'The running service would execute a different SDK than the one `npm ci` / `npm test` exercised. ' +
    'Bump package.json and package-lock.json to the version the install resolved, or pin the range, ' +
    'then reinstall.'
  );
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== '--lock' && flag !== '--installed-root') || typeof value !== 'string') {
      throw new Error('usage: check-sdk-lock-drift.js [--lock <package-lock.json>] [--installed-root <dir>]');
    }
    opts[flag === '--lock' ? 'lock' : 'installedRoot'] = value;
  }
  return opts;
}

function resolveInstalledRoot() {
  const globalRoot = execFileSync('npm', ['root', '-g'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString().trim();
  return path.join(globalRoot, '@clagentic', 'console');
}

function main(argv) {
  let opts;
  let locked;
  let installed;
  let installedRoot;
  try {
    opts = parseArgs(argv);
    const lockPath = opts.lock || path.join(__dirname, '..', 'package-lock.json');
    installedRoot = opts.installedRoot || resolveInstalledRoot();
    locked = readLockedVersions(lockPath, TRACKED_PACKAGES);
    installed = readInstalledVersions(installedRoot, TRACKED_PACKAGES);
  } catch (err) {
    console.error(`[check-sdk-lock-drift] ERROR: ${err.message}`);
    return 1;
  }

  const drift = findDrift(locked, installed);
  if (drift.length > 0) {
    console.error(formatDrift(drift, installedRoot));
    return 1;
  }

  const summary = TRACKED_PACKAGES.map((name) => `${name}@${locked[name]}`).join(', ');
  console.log(`[check-sdk-lock-drift] installed build matches package-lock.json: ${summary}`);
  return 0;
}

module.exports = { TRACKED_PACKAGES, readLockedVersions, readInstalledVersions, findDrift, formatDrift, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

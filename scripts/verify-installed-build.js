#!/usr/bin/env node
'use strict';

// verify-installed-build.js — post-merge install assertion (lr-0d45).
//
// Confirms the globally-installed @clagentic/console build (installed by the
// preceding `npm run install:local-test` post_merge_steps entry) actually
// reflects the merged HEAD commit, rather than trusting a zero exit code from
// `npm install -g` alone. Compares the SHA embedded by scripts/write-build-sha.js
// (baked into the tarball at `prepack` time, so it travels with the package
// that `npm install -g` unpacked) against this working tree's own HEAD SHA at
// the moment loadout-merge runs post_merge_steps (i.e. the merged commit).
//
// Exit codes:
//   0  — installed build-sha.json matches this tree's HEAD.
//   1  — mismatch, or build-sha.json missing/unreadable, or HEAD unresolvable.
//         Reported on stderr with both SHAs so the exact drift is visible in
//         loadout-merge's captured step output.
//
// Run as a SEPARATE post_merge_steps entry (on_failure: fail) after
// `npm run install:local-test` — never combined into one shell string, per
// loadout-merge's shell-operator-token rejection (merge/post_merge.py).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function resolveHeadSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString().trim();
}

function resolveInstalledSha() {
  // `npm install -g` resolves the global node_modules root via `npm root -g`;
  // read the build-sha.json that write-build-sha.js baked into the tarball
  // at pack time (lib/ is in package.json's `files`, so it ships).
  const globalRoot = execFileSync('npm', ['root', '-g'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString().trim();
  const installedPath = path.join(globalRoot, '@clagentic', 'console', 'lib', 'build-sha.json');
  const raw = fs.readFileSync(installedPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed.sha !== 'string') {
    throw new Error(`${installedPath} does not contain a "sha" field`);
  }
  return { sha: parsed.sha, path: installedPath };
}

function main() {
  let headSha;
  try {
    headSha = resolveHeadSha();
  } catch (err) {
    console.error(`[verify-installed-build] ERROR: could not resolve this tree's HEAD SHA: ${err.message}`);
    process.exit(1);
  }

  let installed;
  try {
    installed = resolveInstalledSha();
  } catch (err) {
    console.error(`[verify-installed-build] ERROR: could not read installed build-sha.json: ${err.message}`);
    process.exit(1);
  }

  if (installed.sha !== headSha) {
    console.error(
      `[verify-installed-build] MISMATCH: installed build (${installed.path}) is at ` +
      `${installed.sha}, but merged HEAD is ${headSha}. The post-merge install did ` +
      `not land the merged commit — investigate before trusting the running build.`
    );
    process.exit(1);
  }

  console.log(`[verify-installed-build] ok: installed build matches merged HEAD (${headSha})`);
}

main();

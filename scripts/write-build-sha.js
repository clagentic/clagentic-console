#!/usr/bin/env node
'use strict';

// write-build-sha.js — embeds the current git commit SHA into lib/build-sha.json
// so a later install of this package can be checked against the source tree it
// was built from (lr-0d45: post-merge install verification).
//
// Runs as npm's `prepack` lifecycle hook — fires before `npm pack` builds the
// tarball, so `lib/build-sha.json` is always baked into what install:local-test
// ships. Also runs standalone via `node scripts/write-build-sha.js` for local
// debugging.
//
// Fails loudly (non-zero exit) if the SHA cannot be determined — a package
// packed without a resolvable SHA would make the post-install verification
// step (scripts/verify-installed-build.js) meaningless, so refuse to produce
// a stale/empty build-sha.json rather than pack one silently.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT_PATH = path.join(__dirname, '..', 'lib', 'build-sha.json');

function resolveSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim();
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : err.message;
    throw new Error(`could not resolve git HEAD SHA: ${stderr}`);
  }
}

function main() {
  let sha;
  try {
    sha = resolveSha();
  } catch (err) {
    console.error(`[write-build-sha] ERROR: ${err.message}`);
    process.exit(1);
  }
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    console.error(`[write-build-sha] ERROR: resolved SHA does not look like a git commit hash: ${JSON.stringify(sha)}`);
    process.exit(1);
  }
  const payload = { sha, writtenAt: new Date().toISOString() };
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n');
  console.log(`[write-build-sha] wrote ${OUT_PATH} (sha=${sha})`);
}

main();

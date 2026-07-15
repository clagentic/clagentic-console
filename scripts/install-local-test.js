#!/usr/bin/env node
'use strict';

// install-local-test.js — pack the current tree and install it globally (lr-0d45).
//
// Replaces the old `sh -c 'f=$(npm pack) && npm install -g "$f" && rm -f "$f"'`
// one-liner. That form broke because `$(npm pack)` captures npm's multi-line
// human-readable notices AND any output written to stdout by the `prepack`
// lifecycle hook (scripts/write-build-sha.js's own console.log) — not just the
// tarball filename. The resulting `$f` was a garbage multi-line string, so
// `npm install -g "$f"` failed with EINVALIDPACKAGENAME.
//
// `npm pack --json` also mixes prepack-hook stdout into the same stream, so
// this reads npm's output and extracts the tarball filename by parsing the
// trailing JSON array specifically (the only valid JSON substring `npm pack
// --json` ever emits), rather than trusting the whole stdout to be clean.

const { execFileSync } = require('child_process');

// Extracts the packed tarball filename from `npm pack --json`'s raw stdout.
// Exported (not just used internally) so tests can exercise the parsing
// logic against captured/synthetic npm output without shelling out to a
// real `npm pack` — see test/install-local-test-lr-0d45.test.js.
function extractTarballFilename(raw) {
  // npm pack --json emits a JSON array `[ { ... } ]` (pretty-printed,
  // multi-line, in practice), but the prepack lifecycle hook
  // (scripts/write-build-sha.js) writes its own log line to the same stdout
  // stream first, and that line itself starts with a literal '[' (its
  // "[write-build-sha] wrote ..." prefix) — so a naive raw.indexOf('[') finds
  // that '[' instead of the JSON array's. Rather than assume a specific
  // whitespace shape around the array's opening bracket, try every '[' that
  // starts a line as a candidate array start and parse from there to the end
  // of the string, taking the first candidate that parses as a non-empty
  // array of objects with a "filename" field. This tolerates both
  // pretty-printed and single-line npm output across npm versions.
  const lines = raw.split('\n');
  let offset = 0;
  const candidates = [];
  for (const line of lines) {
    if (line.startsWith('[')) {
      candidates.push(offset);
    }
    offset += line.length + 1;
  }

  for (const start of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(raw.slice(start));
    } catch {
      continue;
    }
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0].filename === 'string') {
      // npm pack --json's "filename" field uses the @scope/name@version form
      // with a literal '/' in place of the tarball's on-disk '-' separator;
      // the actual file on disk uses '-'. Normalize to get the real path.
      return parsed[0].filename.replace('/', '-');
    }
  }

  throw new Error(`could not locate a valid \`npm pack --json\` array in output:\n${raw}`);
}

function packAndGetFilename() {
  const raw = execFileSync('npm', ['pack', '--json'], { encoding: 'utf8' });
  return extractTarballFilename(raw);
}

function main() {
  let tarball;
  try {
    tarball = packAndGetFilename();
  } catch (err) {
    console.error(`[install-local-test] ERROR: ${err.message}`);
    process.exit(1);
  }

  console.log(`[install-local-test] packed ${tarball}`);

  try {
    execFileSync('npm', ['install', '-g', tarball], { stdio: 'inherit' });
  } finally {
    try {
      execFileSync('rm', ['-f', tarball]);
    } catch (cleanupErr) {
      console.error(`[install-local-test] WARN: could not remove ${tarball}: ${cleanupErr.message}`);
    }
  }

  console.log('[install-local-test] ok: installed');
}

module.exports = { extractTarballFilename };

if (require.main === module) {
  main();
}

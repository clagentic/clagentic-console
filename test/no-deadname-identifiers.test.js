// Static source-text scan that fails on a reintroduced `_clay`-prefixed
// internal identifier.
//
// "Clay" is the DEADNAME of Clagentic: Console (workspace CLAUDE.md rule 19).
// lr-6feac0 swept ~230 pre-existing `_clay*` WS/req connection properties
// (auth/session/UI-state internals — _clayUser, _clayActiveSession, etc.) to
// a `_clagentic*` prefix. Those survived the original brand-name rename
// because the existing brand guard only scans USER-FACING strings (CLI usage
// text, status lines) — it has no coverage for internal identifiers. Without
// a standing check, the deadname is free to creep back in one property at a
// time with nothing to catch it.
//
// What is checked:
//   - Every `.js` file under lib/ (including lib/public/) is scanned for the
//     literal source-text pattern `_clay` followed by an uppercase letter
//     (the `_clayXxx` naming shape every deadname property used) or as a
//     bare `_clay` property/identifier.
//
// What is intentionally NOT checked:
//   - The literal substring "clay" on its own (case-insensitive )is present
//     throughout this codebase in ways unrelated to this deadname family —
//     env var fallbacks (CLAY_HOME), legacy config migration helpers
//     (loadClayrc), external package/tool names (clay-mcp-bridge,
//     mcp__clay-datastore__ — an MCP server-name string literal, unrelated
//     to the _clayXxx WS/req property family; excluded by requiring a real
//     leading word-boundary before `_clay`, not by an explicit allowlist),
//     and historical CHANGELOG entries. None of those are the
//     `_clayXxx`-shaped internal-identifier pattern this task closed;
//     folding them in would require a much larger, separately-scoped sweep
//     and a broader exclusion list than a regression guard should carry.
//   - This file's own source (it necessarily contains the banned pattern as
//     data, to describe what it forbids) — excluded by path.
//
// Run: npm test (wired into test/*.test.js glob)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_ROOT = path.resolve(__dirname, '../lib');
const SELF_PATH = fileURLToPath(import.meta.url);

// `_clay` immediately followed by an uppercase letter (the shape every
// deadname property used: _clayUser, _clayActiveSession, _clayUnread,
// _clayLocal, _clayAcceptedProtocol, _clayThemeBound, _clayEffectiveProtocol)
// OR a bare `_clay` not followed by a letter/digit/underscore (word boundary),
// itself not preceded by a letter/digit/underscore either — a leading
// boundary is required so this does not fire on `_clay` as a substring of a
// LARGER identifier/string token it is not actually the start of (e.g.
// `mcp__clay-datastore__`, an MCP server-name string literal unrelated to
// this identifier family — lib/sdk-bridge.js). A real `_clayXxx` property
// access is always preceded by `.`, `(`, whitespace, a quote, or start of
// line/string — never by another identifier character.
const DEADNAME_RE = /(?<![A-Za-z0-9_])_clay(?:[A-Z][A-Za-z0-9]*|(?![A-Za-z0-9_]))/g;

function collectJsFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

function lineNumberAt(src, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}

const allFiles = collectJsFiles(LIB_ROOT);
const violations = [];

for (const file of allFiles) {
  if (file === SELF_PATH) continue;
  const src = fs.readFileSync(file, 'utf8');
  let m;
  DEADNAME_RE.lastIndex = 0;
  while ((m = DEADNAME_RE.exec(src)) !== null) {
    violations.push({
      file: path.relative(path.resolve(__dirname, '..'), file),
      line: lineNumberAt(src, m.index),
      match: m[0],
    });
  }
}

test('no _clay-prefixed deadname identifiers under lib/', () => {
  if (violations.length === 0) return;

  const lines = violations.map(v => `  ${v.file}:${v.line}  found "${v.match}"`);

  assert.fail(
    `${violations.length} deadname identifier occurrence(s) found under lib/ ` +
    `("Clay" is the deadname of Clagentic: Console — see lr-6feac0):\n` +
    lines.join('\n')
  );
});

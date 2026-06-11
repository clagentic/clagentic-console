// Static ESM import-resolution check for lib/public/.
//
// Catches the failure class from lr-8657 / PR #223: a named import that
// references a symbol that no longer exists in the target module (because it
// moved, was renamed, or the import path is simply wrong).
//
// What is checked:
//   - Every relative import in lib/public/**/*.js resolves to a file that exists.
//   - Every named symbol in those imports actually appears as an export in the
//     target file.
//
// What is intentionally NOT checked:
//   - Bare specifiers (node:*, ws, etc.) — not our code, no local file to check.
//   - Default imports (import x from '...') — these only consume the default export,
//     which has no stable name to verify.
//   - `export * from './bar'` re-export chains — treated as wildcard; any named
//     import from a file that uses export* is accepted without deep-following, to
//     avoid false-positives on complex re-export graphs.
//
// Run: npm test  (wired into test/*.test.js glob)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.resolve(__dirname, '../lib/public');

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Export extraction
// ---------------------------------------------------------------------------

// Parses all exported names from a file's source text.
// Returns { names: Set<string>, hasStarReexport: bool }.
function extractExports(src) {
  const names = new Set();
  let hasStarReexport = false;

  // export default ...
  if (/\bexport\s+default\b/.test(src)) {
    names.add('default');
  }

  // export function foo / export async function foo / export class Foo /
  // export var foo / export let foo / export const foo
  const declRe = /\bexport\s+(?:async\s+)?(?:function|class|var|let|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m;
  while ((m = declRe.exec(src)) !== null) {
    names.add(m[1]);
  }

  // export { foo, bar as baz, ... }        (local re-export, no 'from')
  // export { foo, bar } from './other'     (named re-export from another module)
  // In both cases the public exported name is the alias if present, else the original.
  const braceRe = /\bexport\s*\{([^}]+)\}(?:\s*from\s*['"][^'"]+['"])?/g;
  while ((m = braceRe.exec(src)) !== null) {
    const body = m[1];
    const itemRe = /([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:as\s+([A-Za-z_$][A-Za-z0-9_$]*))?/g;
    let im;
    while ((im = itemRe.exec(body)) !== null) {
      names.add(im[2] || im[1]);
    }
  }

  // export * from './bar'  — this file re-exports an unknown set of names.
  // Record the sentinel; callers skip deep checks against this file to avoid
  // false-positives on unbounded re-export graphs.
  if (/\bexport\s+\*\s+from\b/.test(src)) {
    hasStarReexport = true;
  }

  return { names, hasStarReexport };
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

// Returns [{ specifier, names[] }] for every static named import of a relative
// specifier in src.  Bare specifiers (node:*, ws, …) and default-only imports
// are skipped.
function extractNamedImports(src) {
  const imports = [];

  // Regex matches:  import { ... } from './path'  or  import { ... } from '../path'
  // The brace body [^}]* is single-line-greedy, which is fine because app.js
  // uses multi-line imports whose closing } is on its own line — the regex
  // engine still matches because [^}]* is greedy across newlines.
  const re = /\bimport\s*\{([^}]*)\}\s*from\s*(['"])(\.\.?\/[^'"]+)\2/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const body = m[1];
    const specifier = m[3];

    // Each item in the brace list: "foo" or "foo as localAlias".
    // We want the original exported name (left side).
    const itemRe = /([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:as\s+[A-Za-z_$][A-Za-z0-9_$]*)?/g;
    const names = [];
    let im;
    while ((im = itemRe.exec(body)) !== null) {
      names.push(im[1]);
    }

    if (names.length > 0) {
      imports.push({ specifier, names });
    }
  }

  return imports;
}

// ---------------------------------------------------------------------------
// Export cache — parse each target file at most once
// ---------------------------------------------------------------------------

const exportCache = new Map();

function getExports(absPath) {
  if (exportCache.has(absPath)) return exportCache.get(absPath);
  if (!fs.existsSync(absPath)) {
    const sentinel = { names: new Set(), hasStarReexport: false, missing: true };
    exportCache.set(absPath, sentinel);
    return sentinel;
  }
  const src = fs.readFileSync(absPath, 'utf8');
  const result = extractExports(src);
  exportCache.set(absPath, result);
  return result;
}

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------

const allFiles = collectJsFiles(PUBLIC_ROOT);
const violations = [];

for (const file of allFiles) {
  const src = fs.readFileSync(file, 'utf8');
  const namedImports = extractNamedImports(src);

  for (const { specifier, names } of namedImports) {
    const targetPath = path.resolve(path.dirname(file), specifier);

    // Try exact path first, then append .js for extension-less specifiers.
    const resolved = fs.existsSync(targetPath)
      ? targetPath
      : fs.existsSync(targetPath + '.js')
        ? targetPath + '.js'
        : null;

    if (!resolved) {
      violations.push({
        kind: 'missing-file',
        importer: path.relative(PUBLIC_ROOT, file),
        specifier,
        names,
      });
      continue;
    }

    const { names: exported, hasStarReexport } = getExports(resolved);

    // If the target uses `export * from`, its full export surface is unknown
    // without recursion. Skip to avoid false-positives.
    if (hasStarReexport) continue;

    for (const name of names) {
      if (!exported.has(name)) {
        violations.push({
          kind: 'missing-export',
          importer: path.relative(PUBLIC_ROOT, file),
          specifier,
          name,
          targetFile: path.relative(PUBLIC_ROOT, resolved),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Test assertion — report all violations in one shot
// ---------------------------------------------------------------------------

test('ESM named import resolution across lib/public/', () => {
  if (violations.length === 0) return;

  const lines = violations.map(v => {
    if (v.kind === 'missing-file') {
      return `  MISSING FILE  ${v.importer} imports from '${v.specifier}' — file not found`;
    }
    return `  MISSING EXPORT  ${v.importer} imports { ${v.name} } from '${v.specifier}' — not exported by ${v.targetFile}`;
  });

  assert.fail(
    `${violations.length} broken import(s) found in lib/public/:\n` +
    lines.join('\n')
  );
});

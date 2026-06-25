/**
 * Parity test for lr-336f: assert that the CJS backend copy
 * (lib/model-context-windows.js) and the ES module frontend copy
 * (lib/public/modules/model-context-windows.js) expose identical
 * KNOWN_CONTEXT_WINDOWS maps and produce identical resolution results for a
 * representative model set.
 *
 * This test is the enforcement mechanism that prevents the two files from
 * silently drifting — it must remain green whenever a new model is added.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load the CJS backend copy synchronously via require().
const cjs = require('../lib/model-context-windows.js');

// Load the ES module frontend copy via dynamic import().
const esm = await import('../lib/public/modules/model-context-windows.js');

// ---------------------------------------------------------------------------
// Map parity
// ---------------------------------------------------------------------------

test('lr-336f: KNOWN_CONTEXT_WINDOWS map is identical in both copies', () => {
  const cjsMap = cjs.KNOWN_CONTEXT_WINDOWS;
  const esmMap = esm.KNOWN_CONTEXT_WINDOWS;

  const cjsKeys = Object.keys(cjsMap).sort();
  const esmKeys = Object.keys(esmMap).sort();

  assert.deepStrictEqual(cjsKeys, esmKeys,
    'Both copies must have the same model keys in KNOWN_CONTEXT_WINDOWS');

  for (const key of cjsKeys) {
    assert.strictEqual(cjsMap[key], esmMap[key],
      `Context window for "${key}" must be identical in both copies`);
  }
});

// ---------------------------------------------------------------------------
// Resolution parity — representative model set
// ---------------------------------------------------------------------------

const TEST_CASES = [
  // [model, activeBetas, label]
  ["claude-sonnet-4", [], "sonnet-4 no beta"],
  ["claude-sonnet-4", ["context-1m-2025-08-07"], "sonnet-4 with context-1m beta"],
  ["o3", [], "o3 no beta"],
  ["o3", ["context-1m"], "o3 with context-1m beta"],
  ["o4-mini", [], "o4-mini no beta"],
  ["gpt-4.1", [], "gpt-4.1 no beta"],
  ["gpt-5.5", [], "gpt-5.5 no beta"],
  ["claude-opus-4.6[1m]", [], "opus with [1m] suffix"],
  ["unknown-future-model-xyz", [], "unknown model (returns 0)"],
  [null, [], "null model (returns 0)"],
  ["o3", null, "o3 null activeBetas (falls through to map)"],
];

for (const [model, activeBetas, label] of TEST_CASES) {
  test('lr-336f: resolution parity — ' + label, () => {
    const cjsResult = cjs.resolveModelContextWindow(model, activeBetas);
    const esmResult = esm.resolveModelContextWindow(model, activeBetas);
    assert.strictEqual(cjsResult, esmResult,
      `resolveModelContextWindow(${JSON.stringify(model)}, ${JSON.stringify(activeBetas)}) must agree: ` +
      `CJS=${cjsResult} ESM=${esmResult}`);
  });
}

// ---------------------------------------------------------------------------
// Spot-check known values
// ---------------------------------------------------------------------------

test('lr-336f: context-1m beta always returns 1M regardless of model', () => {
  const betas = ["context-1m"];
  assert.strictEqual(cjs.resolveModelContextWindow("o3", betas), 1000000);
  assert.strictEqual(esm.resolveModelContextWindow("o3", betas), 1000000);
  assert.strictEqual(cjs.resolveModelContextWindow("unknown-model", betas), 1000000);
  assert.strictEqual(esm.resolveModelContextWindow("unknown-model", betas), 1000000);
});

test('lr-336f: unknown model without beta returns 0 (degrade cleanly)', () => {
  assert.strictEqual(cjs.resolveModelContextWindow("hypothetical-model", []), 0);
  assert.strictEqual(esm.resolveModelContextWindow("hypothetical-model", []), 0);
});

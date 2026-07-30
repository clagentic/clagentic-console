/**
 * Parity test for lr-d91ecf: assert that the CJS backend copy
 * (lib/model-families.js) and the ES module frontend copy
 * (lib/public/modules/model-families.js) expose identical exports and
 * produce identical results for a representative model set.
 *
 * This is the enforcement mechanism that prevents the two files from
 * silently drifting — the same discipline as the existing
 * model-context-windows-parity.test.js (lr-336f).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load the CJS backend copy synchronously via require().
const cjs = require('../lib/model-families.js');

// Load the ES module frontend copy via dynamic import().
const esm = await import('../lib/public/modules/model-families.js');

// ---------------------------------------------------------------------------
// CLAUDE_MODEL_FAMILIES parity
// ---------------------------------------------------------------------------

test('lr-d91ecf: CLAUDE_MODEL_FAMILIES is identical in both copies', () => {
  assert.deepStrictEqual(cjs.CLAUDE_MODEL_FAMILIES, esm.CLAUDE_MODEL_FAMILIES);
});

// ---------------------------------------------------------------------------
// isSonnetModel / isOpusModel / isHaikuModel parity
// ---------------------------------------------------------------------------

const FAMILY_CASES = [
  'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-3-5',
  'gpt-5.5', 'default', '', null, undefined,
  { value: 'claude-sonnet-4' }, { value: 'claude-opus-4' },
  'claude-fable-5[1m]', 'fable', // lr-5c07ce
];

for (const model of FAMILY_CASES) {
  test('lr-d91ecf: isSonnetModel/isOpusModel/isHaikuModel parity — ' + JSON.stringify(model), () => {
    assert.strictEqual(cjs.isSonnetModel(model), esm.isSonnetModel(model));
    assert.strictEqual(cjs.isOpusModel(model), esm.isOpusModel(model));
    assert.strictEqual(cjs.isHaikuModel(model), esm.isHaikuModel(model));
  });
}

// ---------------------------------------------------------------------------
// parseClaudeModelVersion / compareClaudeVersions parity
// ---------------------------------------------------------------------------

const PARSE_CASES = [
  'claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-3',
  'claude-opus-4-6[1m]', 'default', '', null,
  'claude-fable-5[1m]', 'fable', // lr-5c07ce
];

for (const model of PARSE_CASES) {
  test('lr-d91ecf: parseClaudeModelVersion parity — ' + JSON.stringify(model), () => {
    assert.deepStrictEqual(cjs.parseClaudeModelVersion(model), esm.parseClaudeModelVersion(model));
  });
}

// lr-5c07ce: parity for the optional description argument (alias-only lists).
const PARSE_WITH_DESCRIPTION_CASES = [
  ['sonnet', 'Sonnet 4.6'],
  ['opus', 'Opus 4.8 with 1M context'],
  ['haiku', 'Haiku 4.5'],
  ['fable', 'Fable 5'],
  ['claude-opus-4-5', 'Opus 4.8 with 1M context'], // own version must win
  ['sonnet', 'Opus 4.8 with 1M context'], // mismatched family must not leak
];

for (const [modelId, description] of PARSE_WITH_DESCRIPTION_CASES) {
  test('lr-5c07ce: parseClaudeModelVersion(modelId, description) parity — ' + JSON.stringify([modelId, description]), () => {
    assert.deepStrictEqual(
      cjs.parseClaudeModelVersion(modelId, description),
      esm.parseClaudeModelVersion(modelId, description)
    );
  });
}

// ---------------------------------------------------------------------------
// deriveClaudeLatestTiers parity
// ---------------------------------------------------------------------------

test('lr-d91ecf: deriveClaudeLatestTiers parity', () => {
  const models = ['claude-opus-4-6', 'claude-opus-4', 'claude-sonnet-4-5', 'claude-sonnet-4', 'default'];
  assert.deepStrictEqual(cjs.deriveClaudeLatestTiers(models), esm.deriveClaudeLatestTiers(models));
});

test('lr-5c07ce: deriveClaudeLatestTiers parity on an alias-only list with description fields', () => {
  const models = [
    { value: 'default', description: 'Opus 4.8 with 1M context' },
    { value: 'claude-fable-5[1m]', description: 'Fable 5' },
    { value: 'sonnet', description: 'Sonnet 4.6' },
    { value: 'haiku', description: 'Haiku 4.5' },
  ];
  assert.deepStrictEqual(cjs.deriveClaudeLatestTiers(models), esm.deriveClaudeLatestTiers(models));
});

// ---------------------------------------------------------------------------
// claudeDisplayName parity
// ---------------------------------------------------------------------------

const DISPLAY_NAME_CASES = [
  'claude-opus-4-6', 'claude-sonnet-4-5', 'claude-haiku-3-5',
  'claude-opus-9-9', // unseen future version
  'default', 'claude-future-family-1-0',
  'fable', 'claude-fable-5[1m]', // lr-5c07ce
];

for (const model of DISPLAY_NAME_CASES) {
  test('lr-d91ecf: claudeDisplayName parity — ' + model, () => {
    assert.strictEqual(cjs.claudeDisplayName(model), esm.claudeDisplayName(model));
  });
}

// lr-5c07ce: parity for claudeDisplayName's optional description argument.
const DISPLAY_NAME_WITH_DESCRIPTION_CASES = [
  ['sonnet', 'Sonnet 4.6'],
  ['opus', 'Opus 4.8 with 1M context'],
  ['fable', 'Fable 5'],
];

for (const [modelId, description] of DISPLAY_NAME_WITH_DESCRIPTION_CASES) {
  test('lr-5c07ce: claudeDisplayName(modelId, description) parity — ' + JSON.stringify([modelId, description]), () => {
    assert.strictEqual(cjs.claudeDisplayName(modelId, description), esm.claudeDisplayName(modelId, description));
  });
}

test('lr-d91ecf: claudeDisplayName derives a sane label for a model ID never hardcoded anywhere', () => {
  // Acceptance criterion: an ID the code has never seen gets a sane derived
  // display name with no code change. "claude-opus-9-9" appears nowhere in
  // lib/ as a literal — it must still resolve to "Opus 9.9" purely from
  // family + version parsing.
  assert.strictEqual(cjs.claudeDisplayName('claude-opus-9-9'), 'Opus 9.9');
  assert.strictEqual(esm.claudeDisplayName('claude-opus-9-9'), 'Opus 9.9');
});

// ---------------------------------------------------------------------------
// claudeModelSupportsThinking / claudeModelSupportsEffort parity
// ---------------------------------------------------------------------------

const CAPABILITY_CASES = ['claude-opus-4-6', 'claude-sonnet-4-5', 'claude-haiku-3-5', 'default', ''];

for (const model of CAPABILITY_CASES) {
  test('lr-d91ecf: capability heuristics parity — ' + JSON.stringify(model), () => {
    assert.strictEqual(cjs.claudeModelSupportsThinking(model), esm.claudeModelSupportsThinking(model));
    assert.strictEqual(cjs.claudeModelSupportsEffort(model), esm.claudeModelSupportsEffort(model));
  });
}

// Regression tests for lr-5c07ce — MODEL_DESCRIPTIONS was missing "fable"
// entirely (rendering a description-less row in the picker, per Andy's
// screenshot) and "opus" still claimed "Most powerful model", which is
// stale once Fable ranks above it. These descriptions are hardcoded
// in-repo (settings-defaults.js) — an SDK update does not fix them; only a
// code change here does (Andy asked this directly).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_DESCRIPTIONS, getModelDesc } from '../lib/public/modules/settings-defaults.js';

test('lr-5c07ce: fable has a MODEL_DESCRIPTIONS entry', () => {
  assert.ok(MODEL_DESCRIPTIONS.fable, 'fable must have a non-empty description');
});

test('lr-5c07ce: getModelDesc resolves a description for the live fable value shape (versioned ID with beta suffix)', () => {
  assert.equal(getModelDesc('claude-fable-5[1m]'), MODEL_DESCRIPTIONS.fable);
});

test('lr-5c07ce: opus description no longer claims to be the most powerful model (stale once fable ranks above it)', () => {
  assert.ok(
    MODEL_DESCRIPTIONS.opus.toLowerCase().indexOf('most powerful') === -1,
    'opus description must not claim to be the top model now that fable exists'
  );
});

test('lr-5c07ce: getModelDesc for fable and opus never collide', () => {
  assert.notEqual(getModelDesc('fable'), getModelDesc('opus'));
});

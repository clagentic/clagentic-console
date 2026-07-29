// Regression tests for lr-e03635 — shared latest/older model tiering.
//
// splitModelsByTier() (lib/public/modules/settings-defaults.js) is the single
// partition function used by every picker surface: renderModelList's own
// latest-list + collapsible "Older models" disclosure, and app-panels.js's
// session-chip rebuildModelList. It has no DOM dependency, so it's testable
// directly without a browser/jsdom harness (same pattern as other pure
// exports in this module).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitModelsByTier } from '../lib/public/modules/settings-defaults.js';

test('lr-e03635: splitModelsByTier puts isLatest:true models in latest, isLatest:false in older', () => {
  var models = [
    { value: 'a', isLatest: true },
    { value: 'b', isLatest: false },
    { value: 'c', isLatest: true },
    { value: 'd', isLatest: false },
  ];
  var tiers = splitModelsByTier(models);
  assert.deepStrictEqual(tiers.latest.map(function (m) { return m.value; }), ['a', 'c']);
  assert.deepStrictEqual(tiers.older.map(function (m) { return m.value; }), ['b', 'd']);
});

test('lr-e03635: a model object with no isLatest field at all is treated as latest, never hidden', () => {
  var models = [{ value: 'legacy-shape' }];
  var tiers = splitModelsByTier(models);
  assert.deepStrictEqual(tiers.latest.map(function (m) { return m.value; }), ['legacy-shape']);
  assert.deepStrictEqual(tiers.older, []);
});

test('lr-e03635: empty-disclosure rule — all-latest input produces an empty older tier', () => {
  var models = [{ value: 'x', isLatest: true }, { value: 'y', isLatest: true }];
  var tiers = splitModelsByTier(models);
  assert.equal(tiers.older.length, 0);
});

test('lr-e03635: empty input produces empty tiers, not an error', () => {
  var tiers = splitModelsByTier([]);
  assert.deepStrictEqual(tiers, { latest: [], older: [] });
  var tiersUndef = splitModelsByTier(undefined);
  assert.deepStrictEqual(tiersUndef, { latest: [], older: [] });
});

test('lr-e03635: plain string entries (no isLatest field possible) are always latest', () => {
  var tiers = splitModelsByTier(['gpt-5.5', 'gpt-5.2']);
  assert.deepStrictEqual(tiers.latest, ['gpt-5.5', 'gpt-5.2']);
  assert.deepStrictEqual(tiers.older, []);
});

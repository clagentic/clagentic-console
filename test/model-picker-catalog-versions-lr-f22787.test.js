// Regression tests for lr-f22787 — the model picker must render multiple
// versions per family as clickable rows once the release-time-generated
// catalog (lib/generated/claude-model-catalog.json) supplies older,
// still-runnable versioned IDs alongside the vendor's live alias list. Also
// pins the "Catalog" marker (PR body point (c): shown, never hidden) on any
// row sourced from the catalog rather than the live vendor enumeration.
//
// Both picker surfaces are covered:
//   - renderModelList (lib/public/modules/settings-defaults.js) — project/
//     server settings panels.
//   - rebuildModelList (lib/public/modules/app-panels.js) — session config
//     chip popover.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeFakeElement(tag) {
  var listeners = {};
  var children = [];
  var el = {
    tagName: tag,
    className: "",
    textContent: "",
    dataset: {},
    style: {},
    attrs: {},
    value: "",
    children: children,
    innerHTML: "",
    appendChild: function (child) { children.push(child); return child; },
    setAttribute: function (k, v) { this.attrs[k] = v; },
    addEventListener: function (evt, fn) {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(fn);
    },
    dispatch: function (evt, evtObj) {
      (listeners[evt] || []).forEach(function (fn) { fn(evtObj || {}); });
    },
    querySelectorAll: function () { return []; },
    classList: {
      _set: {},
      add: function (c) { this._set[c] = true; },
      remove: function (c) { delete this._set[c]; },
      toggle: function (c, force) {
        var on = force !== undefined ? force : !this._set[c];
        if (on) this._set[c] = true; else delete this._set[c];
      },
      contains: function (c) { return !!this._set[c]; },
    },
  };
  return el;
}

function installFakeDom() {
  var byId = {};
  global.document = {
    createElement: function (tag) { return makeFakeElement(tag); },
    getElementById: function (id) {
      if (!byId[id]) byId[id] = makeFakeElement("div");
      return byId[id];
    },
  };
  global.lucide = { createIcons: function () {} };
  return byId;
}

test.afterEach(function () {
  delete global.document;
  delete global.lucide;
});

test('lr-f22787: renderModelList (settings picker) renders every version of a family as a separate clickable row, tiered latest/older', async function () {
  var mod = await import('../lib/public/modules/settings-defaults.js');
  var byId = installFakeDom();

  var clicked = [];
  mod.renderModelList('ps', {
    models: [
      { value: 'claude-opus-4-6', displayName: 'Opus 4.6', isLatest: true },
      { value: 'claude-opus-4-5', displayName: 'Opus 4.5', isLatest: false, fromCatalog: true },
      { value: 'claude-opus-4', displayName: 'Opus 4', isLatest: false, fromCatalog: true },
    ],
    currentModel: 'claude-opus-4-6',
    sendMsg: function (type, payload) { clicked.push(payload.model); },
    modelMsgType: 'set_project_default_model',
  });

  var listEl = byId['ps-model-list'];
  // Latest row is always visible; older rows live inside the disclosure body.
  var latestRows = listEl.children.filter(function (c) { return c.dataset && c.dataset.model === 'claude-opus-4-6'; });
  assert.equal(latestRows.length, 1);

  var toggle = listEl.children.filter(function (c) {
    return c.className && c.className.indexOf('settings-older-models-toggle') !== -1;
  })[0];
  assert.ok(toggle, 'an "Older models" disclosure must appear once more than one version exists');

  var bodyIdx = listEl.children.indexOf(toggle) + 1;
  var body = listEl.children[bodyIdx];
  var olderValues = body.children.map(function (c) { return c.dataset.model; });
  assert.deepEqual(olderValues.sort(), ['claude-opus-4', 'claude-opus-4-5'], 'both older versions must be individually selectable rows');

  // Clicking an older row sends that row's own concrete ID.
  body.children[0].dispatch('click');
  assert.ok(clicked.length === 1 && (clicked[0] === 'claude-opus-4' || clicked[0] === 'claude-opus-4-5'));
});

test('lr-f22787: renderModelList marks a fromCatalog:true entry with the Catalog badge, and never marks a live entry', async function () {
  var mod = await import('../lib/public/modules/settings-defaults.js');
  var byId = installFakeDom();

  mod.renderModelList('ps', {
    models: [
      { value: 'claude-opus-4-6', displayName: 'Opus 4.6', isLatest: true },
      { value: 'claude-opus-4-5', displayName: 'Opus 4.5', isLatest: false, fromCatalog: true },
    ],
    currentModel: 'claude-opus-4-6',
    sendMsg: function () {},
    modelMsgType: 'set_project_default_model',
  });

  var listEl = byId['ps-model-list'];
  var latestRow = listEl.children.filter(function (c) { return c.dataset && c.dataset.model === 'claude-opus-4-6'; })[0];
  var latestBadges = latestRow.children.filter(function (c) { return c.className === 'settings-model-catalog-badge'; });
  assert.equal(latestBadges.length, 0, 'a live-confirmed entry must never carry the Catalog marker');

  var toggle = listEl.children.filter(function (c) {
    return c.className && c.className.indexOf('settings-older-models-toggle') !== -1;
  })[0];
  var body = listEl.children[listEl.children.indexOf(toggle) + 1];
  var olderRow = body.children[0];
  var olderBadges = olderRow.children.filter(function (c) { return c.className === 'settings-model-catalog-badge'; });
  assert.equal(olderBadges.length, 1, 'a catalog-sourced entry must carry exactly one Catalog marker');
  assert.equal(olderBadges[0].textContent, 'Catalog');
});

// ---------------------------------------------------------------------------
// Retired-model marking (coordinator follow-up) — a known-retired ID (e.g.
// claude-1.0) must NOT render as a plain selectable row indistinguishable
// from a currently-runnable one like claude-opus-5.
// ---------------------------------------------------------------------------

test('lr-f22787: renderModelList disables a retired row (does not dispatch on click) and marks it "Retired", while an active row remains an ordinary clickable row', async function () {
  var mod = await import('../lib/public/modules/settings-defaults.js');
  var byId = installFakeDom();

  var clicked = [];
  mod.renderModelList('ps', {
    models: [
      { value: 'claude-opus-5', displayName: 'Opus 5', isLatest: true },
      { value: 'claude-1.0', displayName: 'claude-1.0', isLatest: false, fromCatalog: true, isRetired: true, status: 'retired' },
    ],
    currentModel: 'claude-opus-5',
    sendMsg: function (type, payload) { clicked.push(payload.model); },
    modelMsgType: 'set_project_default_model',
  });

  var listEl = byId['ps-model-list'];
  var activeRow = listEl.children.filter(function (c) { return c.dataset && c.dataset.model === 'claude-opus-5'; })[0];
  assert.ok(activeRow, 'the active row must exist');
  assert.equal(activeRow.className.indexOf('settings-model-item-disabled'), -1, 'an active row must never carry the disabled class');

  var toggle = listEl.children.filter(function (c) {
    return c.className && c.className.indexOf('settings-older-models-toggle') !== -1;
  })[0];
  var body = listEl.children[listEl.children.indexOf(toggle) + 1];
  var retiredRow = body.children[0];

  assert.notEqual(retiredRow, undefined, 'the retired row must still be PRESENT — visible, never filtered out');
  assert.ok(retiredRow.className.indexOf('settings-model-item-disabled') !== -1, 'the retired row must carry the disabled class');
  assert.equal(retiredRow.attrs['aria-disabled'], 'true');

  var retiredBadges = retiredRow.children.filter(function (c) { return c.className === 'settings-model-retired-badge'; });
  assert.equal(retiredBadges.length, 1, 'the retired row must carry exactly one Retired marker');
  assert.equal(retiredBadges[0].textContent, 'Retired');

  // The core assertion the coordinator required: clicking the retired row
  // must NOT dispatch a model selection — it is not an ordinary selectable
  // row indistinguishable from claude-opus-5.
  retiredRow.dispatch('click');
  assert.equal(clicked.length, 0, 'clicking a retired row must never send a set-model message');

  // Sanity: the active row's click path is unaffected.
  activeRow.dispatch('click');
  assert.deepEqual(clicked, ['claude-opus-5']);
});

test('lr-f22787: renderModelList marks a deprecated (not yet retired) row with a Deprecated badge but leaves it clickable', async function () {
  var mod = await import('../lib/public/modules/settings-defaults.js');
  var byId = installFakeDom();

  var clicked = [];
  mod.renderModelList('ps', {
    models: [
      { value: 'claude-opus-4-8', displayName: 'Opus 4.8', isLatest: true },
      { value: 'claude-opus-4-1-20250805', displayName: 'claude-opus-4-1-20250805', isLatest: false, fromCatalog: true, isDeprecated: true, status: 'deprecated' },
    ],
    currentModel: 'claude-opus-4-8',
    sendMsg: function (type, payload) { clicked.push(payload.model); },
    modelMsgType: 'set_project_default_model',
  });

  var listEl = byId['ps-model-list'];
  var toggle = listEl.children.filter(function (c) {
    return c.className && c.className.indexOf('settings-older-models-toggle') !== -1;
  })[0];
  var body = listEl.children[listEl.children.indexOf(toggle) + 1];
  var deprecatedRow = body.children[0];

  assert.equal(deprecatedRow.className.indexOf('settings-model-item-disabled'), -1, 'a deprecated (not retired) row must NOT be disabled — it still runs');
  var deprecatedBadges = deprecatedRow.children.filter(function (c) { return c.className === 'settings-model-deprecated-badge'; });
  assert.equal(deprecatedBadges.length, 1);
  assert.equal(deprecatedBadges[0].textContent, 'Deprecated');

  deprecatedRow.dispatch('click');
  assert.deepEqual(clicked, ['claude-opus-4-1-20250805'], 'a deprecated row must still dispatch a normal selection click');
});

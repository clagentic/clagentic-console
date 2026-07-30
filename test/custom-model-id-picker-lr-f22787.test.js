// Regression tests for lr-f22787 — the model picker must let a user select a
// versioned model ID the vendor's enumeration API never lists (older
// releases), not just the aliases stream.supportedModels() reports.
//
// Root cause (empirically confirmed, not guessed): Query.supportedModels()
// (@anthropic-ai/claude-agent-sdk sdk.d.ts) is the SDK's only model-list API
// and it reports exactly one entry per family — the live probe fixture in
// test/claude-model-capability-lr-af9d66.test.js shows this directly. There
// is no richer enumeration surface in the SDK: Query's full method list
// (sdk.d.ts) has no second model-list call. But Query.setModel(model?:
// string) and the wire-level SDKControlSetModelRequest both take a free
// string with no client-side allowlist — the same mechanism the CLI's own
// /model command relies on when a user types a specific older version. This
// is the fix: every model picker offers a free-text "Use a specific
// version" field that routes through the exact same set_model message an
// enumerated-list click already uses, so the runtime (not this codebase)
// decides whether the typed ID is valid.
//
// lib/public/modules/settings-defaults.js and app-panels.js touch `document`
// only inside function bodies (never at module-eval time — confirmed by the
// existing lr-e03635 tests importing this same module with no DOM present),
// so a minimal same-file `document` stub is sufficient to exercise the new
// buildCustomModelForm() logic without adding a jsdom dependency.
// refreshIcons() (lib/public/modules/icons.js) calls the global `lucide`
// (normally loaded from a CDN script tag), so the stub also fakes that.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- Minimal DOM stub -------------------------------------------------
// Just enough of the Element/Document surface for renderModelList's element
// tree: createElement, className, dataset, textContent, appendChild,
// classList (add/remove/toggle/contains), setAttribute, addEventListener,
// querySelectorAll (used by buildModelItem's click handler, unused by the
// custom-model form itself but present for parity).

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
    placeholder: "",
    spellcheck: true,
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

// Returns the `byId` map so tests can look up the same elements
// renderModelList() populated via document.getElementById.
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

// Locates the "Use a specific version" toggle + its collapsible body among a
// model-list element's appended children, given renderModelList's known
// append order (older-models toggle+body, if any, then the custom-model
// toggle+body).
function findCustomModelToggle(listEl) {
  var toggles = listEl.children.filter(function (c) {
    return c.className && c.className.indexOf('settings-older-models-toggle') !== -1;
  });
  return toggles[toggles.length - 1];
}

test('lr-f22787: renderModelList always appends a "Use a specific version" custom-model disclosure, even with a populated tiered list', async function () {
  var mod = await import('../lib/public/modules/settings-defaults.js');
  var byId = installFakeDom();

  mod.renderModelList('ps', {
    models: [{ value: 'sonnet', displayName: 'Sonnet', isLatest: true }],
    currentModel: 'sonnet',
    sendMsg: function () {},
    modelMsgType: 'set_project_default_model',
    scopeLabel: 'Default for new sessions in this project',
  });

  // getElementById lazily creates+caches the element, so it must be looked
  // up AFTER renderModelList runs — a lookup taken before the call would
  // capture the pre-creation `undefined`, not a live reference into byId.
  var listEl = byId['ps-model-list'];

  // No older versions in this input, so the sole toggle present must be the
  // custom-model one.
  var toggles = listEl.children.filter(function (c) {
    return c.className && c.className.indexOf('settings-older-models-toggle') !== -1;
  });
  assert.equal(toggles.length, 1);
  assert.equal(toggles[0].children[0].textContent, 'Use a specific version');
});

test('lr-f22787: renderModelList offers the custom-model form even when models is empty (no-models-available case)', async function () {
  var mod = await import('../lib/public/modules/settings-defaults.js');
  var byId = installFakeDom();

  mod.renderModelList('ss', {
    models: [],
    currentModel: '',
    sendMsg: function () {},
    modelMsgType: 'set_server_default_model',
  });

  var listEl = byId['ss-model-list'];

  // The empty-state branch appends the custom-model row directly (no
  // wrapping toggle) after the "No models available" placeholder text.
  var customRows = listEl.children.filter(function (c) {
    return c.className === 'settings-custom-model-row';
  });
  assert.equal(customRows.length, 1);
});

test('lr-f22787: submitting the custom-model form sends the typed model ID through the same modelMsgType as an enumerated-list click', async function () {
  var mod = await import('../lib/public/modules/settings-defaults.js');
  var byId = installFakeDom();

  var sent = [];
  var selected = [];
  mod.renderModelList('ps', {
    models: [{ value: 'sonnet', displayName: 'Sonnet', isLatest: true }],
    currentModel: 'sonnet',
    sendMsg: function (type, data) { sent.push({ type: type, data: data }); },
    modelMsgType: 'set_project_default_model',
    onModelSelect: function (model) { selected.push(model); },
  });

  var listEl = byId['ps-model-list'];
  var toggle = findCustomModelToggle(listEl);
  var body = listEl.children[listEl.children.indexOf(toggle) + 1];
  var row = body.children[0];
  var input = row.children[0];
  var btn = row.children[1];

  input.value = 'claude-opus-4-6';
  btn.dispatch('click');

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { type: 'set_project_default_model', data: { model: 'claude-opus-4-6' } });
  assert.deepEqual(selected, ['claude-opus-4-6']);
});

test('lr-f22787: submitting an empty/whitespace-only custom model ID is a no-op (never sends a blank model)', async function () {
  var mod = await import('../lib/public/modules/settings-defaults.js');
  var byId = installFakeDom();

  var sent = [];
  mod.renderModelList('ps', {
    models: [{ value: 'sonnet', displayName: 'Sonnet', isLatest: true }],
    currentModel: 'sonnet',
    sendMsg: function (type, data) { sent.push({ type: type, data: data }); },
    modelMsgType: 'set_project_default_model',
  });

  var listEl = byId['ps-model-list'];
  var toggle = findCustomModelToggle(listEl);
  var body = listEl.children[listEl.children.indexOf(toggle) + 1];
  var row = body.children[0];
  var input = row.children[0];
  var btn = row.children[1];

  input.value = '   ';
  btn.dispatch('click');

  assert.equal(sent.length, 0);
});

test('lr-f22787: Enter key in the custom-model input submits the same as clicking the button', async function () {
  var mod = await import('../lib/public/modules/settings-defaults.js');
  var byId = installFakeDom();

  var sent = [];
  mod.renderModelList('ps', {
    models: [{ value: 'sonnet', displayName: 'Sonnet', isLatest: true }],
    currentModel: 'sonnet',
    sendMsg: function (type, data) { sent.push({ type: type, data: data }); },
    modelMsgType: 'set_project_default_model',
  });

  var listEl = byId['ps-model-list'];
  var toggle = findCustomModelToggle(listEl);
  var body = listEl.children[listEl.children.indexOf(toggle) + 1];
  var row = body.children[0];
  var input = row.children[0];

  input.value = 'claude-sonnet-4-5';
  input.dispatch('keydown', { key: 'Enter', preventDefault: function () {} });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.model, 'claude-sonnet-4-5');
});

test('lr-f22787: the "Older models" disclosure and the custom-model disclosure both appear, in that order, when older versions exist', async function () {
  var mod = await import('../lib/public/modules/settings-defaults.js');
  var byId = installFakeDom();

  mod.renderModelList('ps', {
    models: [
      { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', isLatest: true },
      { value: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5', isLatest: false },
    ],
    currentModel: 'claude-sonnet-4-6',
    sendMsg: function () {},
    modelMsgType: 'set_project_default_model',
  });

  var listEl = byId['ps-model-list'];
  var toggles = listEl.children.filter(function (c) {
    return c.className && c.className.indexOf('settings-older-models-toggle') !== -1;
  });
  assert.equal(toggles.length, 2, 'both the older-models toggle and the custom-model toggle must be present');
  assert.equal(toggles[0].children[0].textContent, 'Older models');
  assert.equal(toggles[1].children[0].textContent, 'Use a specific version');
});

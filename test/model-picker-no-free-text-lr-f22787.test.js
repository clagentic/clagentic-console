// Regression tests for lr-f22787 — the model picker must be an enumerated,
// clickable list only. No free-text model-ID input, no "Use a specific
// version" disclosure, in either picker surface (project/server settings
// via renderModelList in settings-defaults.js, or the session chip via
// rebuildModelList in app-panels.js).
//
// A prior iteration of this task added a free-text escape-hatch input
// alongside the enumerated list, reasoning that the vendor's model-list API
// (Claude `stream.supportedModels()`) never reports prior versions. That
// direction was explicitly rejected: a text field the user must already
// know an exact model ID to use does not solve "Andy sees no options" — it
// reproduces the same discoverability problem in a different shape. The
// free-text form (buildCustomModelForm / buildConfigCustomModelForm) was
// removed entirely; these tests pin its absence so it cannot silently
// return in a future edit.
//
// See the PR body for lr-f22787 for the accompanying needs-decision on
// model enumeration (Finding 1). A prior pass here concluded no version
// table existed at all in the installed CLI; that was wrong and was
// retracted. A second, deeper investigation (control-flow tracing of the
// compiled claude-agent-sdk-linux-x64 binary's own /model option-builder,
// not just the SDK's public type surface) found a real, complete,
// hardcoded version table (`vz` — every Claude family/version with its
// per-provider model ID) baked into the CLI. The reason it never reaches
// this codebase is narrower than "no data exists": the option-builder only
// reads that table's legacy-version rows on the bedrock/foundry/mantle/
// vertex enterprise-gateway auth branches — never on the firstParty
// (plain ANTHROPIC_API_KEY) or OAuth (Claude.ai subscription) branches this
// codebase's Claude subprocess sessions actually use. Query.supportedModels()
// / initializationResult().models (the SDK's only exposed enumeration
// surface) reflect exactly that same gated output, so they inherit the same
// gap. No sourcemap or readable manifest ships alongside the compiled CLI to
// read the table from at runtime, and no control-protocol request or CLI
// flag exposes it either — the only way to reach it is scraping compiled
// binary offsets, which is neither a stable API nor something this repo
// can rely on build-to-build.

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

test('lr-f22787: renderModelList never appends a "Use a specific version" disclosure or a free-text model input', async function () {
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
  // Only the real "Older models" disclosure should exist — never a second
  // "Use a specific version" toggle.
  assert.equal(toggles.length, 1);
  assert.equal(toggles[0].children[0].textContent, 'Older models');

  var customRows = listEl.children.filter(function (c) {
    return c.className === 'settings-custom-model-row';
  });
  assert.equal(customRows.length, 0, 'no free-text custom-model row must ever be appended');

  var hasTextInput = listEl.children.some(function (c) { return c.tagName === 'input'; });
  assert.equal(hasTextInput, false, 'no text input of any kind belongs in the model list');
});

test('lr-f22787: renderModelList with an empty models array shows only the "No models available" placeholder, no free-text fallback form', async function () {
  var mod = await import('../lib/public/modules/settings-defaults.js');
  var byId = installFakeDom();

  mod.renderModelList('ss', {
    models: [],
    currentModel: '',
    sendMsg: function () {},
    modelMsgType: 'set_server_default_model',
  });

  var listEl = byId['ss-model-list'];
  assert.equal(listEl.children.length, 0, 'the empty-state branch sets innerHTML directly and appends nothing else');
  assert.match(listEl.innerHTML, /No models available/);
});

test('lr-f22787: renderModelList with no older versions appends no disclosure at all (not even a hidden one)', async function () {
  var mod = await import('../lib/public/modules/settings-defaults.js');
  var byId = installFakeDom();

  mod.renderModelList('ps', {
    models: [{ value: 'sonnet', displayName: 'Sonnet', isLatest: true }],
    currentModel: 'sonnet',
    sendMsg: function () {},
    modelMsgType: 'set_project_default_model',
  });

  var listEl = byId['ps-model-list'];
  var toggles = listEl.children.filter(function (c) {
    return c.className && c.className.indexOf('settings-older-models-toggle') !== -1;
  });
  assert.equal(toggles.length, 0, 'no toggle of any kind when there are no older versions to disclose');
});

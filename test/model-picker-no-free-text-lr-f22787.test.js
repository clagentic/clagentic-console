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
// model enumeration (Finding 1). Two prior passes here reached conflicting,
// unverified conclusions about *why* older versions weren't enumerated
// (first: no table exists; second: a gated `opus4X`-style enterprise-auth
// branch). Both were retracted after independent re-verification found
// their cited internals (e.g. an `opus4X` flag) simply do not exist in
// either installed binary.
//
// A third pass ran a live, verbatim-logged empirical probe instead of
// static/binary analysis, spawning the CLI through the exact resolution
// path claude-worker.js uses (pathToClaudeCodeExecutable = the globally
// resolved `claude` binary):
//   1. A versioned model ID (claude-opus-4-6) DOES run under plain
//      firstParty/OAuth auth, both at spawn time (options.model) and via
//      queryInstance.setModel() mid-session — modelUsage.provider was
//      "firstParty" in both cases, confirming no enterprise-gateway
//      involvement. Older-version execution is not blocked.
//   2. Query.supportedModels() / initializationResult().models — the only
//      typed, documented SDK enumeration surface — returns ONLY the current
//      alias set (default/opus/sonnet/haiku/fable[+[1m] variants]) on a
//      live query. No `additional_model_options` field exists anywhere in
//      the SDK's .d.ts surface (confirmed by direct file read, not string
//      search of a compiled binary).
//   3. Sending the literal "/model" command through the same control
//      protocol this codebase drives returns: "Available: sonnet, opus,
//      haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan,
//      default, or a full model ID." — i.e. /model's own enumerated output
//      is identical to supportedModels(); the only path to an older version
//      is the user already knowing and typing its exact ID, which the CLI
//      accepts without listing it anywhere.
//
// Net: there is no vendor-exposed enumeration of legacy Claude versions
// reachable from this codebase, by any path (typed SDK method, live
// control-protocol query, or the CLI's own /model text). The task's
// "no hardcoded model ID list — enumerate from the vendor" requirement and
// its acceptance criterion ("older versions are selectable") are therefore
// in direct tension: satisfying discoverability requires a list this repo
// maintains itself (the same posture as the existing, narrower
// lib/model-context-windows.js KNOWN_CONTEXT_WINDOWS fallback table,
// lr-336f), not a runtime source that does not exist. Escalated as
// needs-decision rather than choosing unilaterally, since maintaining an
// evergreen version list is a real, ongoing maintenance-cost trade-off.

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

// Regression / coverage tests for lr-3af675: the context meter reported
// wrong numbers because a hardcoded model-name -> context-window table was
// consulted BEFORE the vendor's own reported window, contradicting its own
// documented fallback-only contract. Operator direction: delete the table
// entirely, invert resolution to vendor-first, and render the meter as
// unknown/indeterminate (never a guessed number) when no vendor value is
// available.
//
// Before this task there was ZERO coverage for accumulateUsage,
// accumulateContext, updateContextPanel, renderCtxPopover,
// resolveContextWindow, the Claude message_start usage extraction, or the
// post-compaction re-read. This file covers:
//   (A) resolveContextWindow / getEffectiveContextFill — vendor-first,
//       unknown/indeterminate state (lib/public/modules/app-panels.js)
//   (B) accumulateContext / accumulateUsage — cache_creation_input_tokens
//       now counted toward context fill (lib/public/modules/app-panels.js)
//   (C) claude.js's message_start usage extraction — cache_creation
//       inclusion at the source (lib/yoke/adapters/claude.js)
//   (D) codex.js's getContextUsage — no longer returns a fabricated rich-
//       usage-shaped object (lib/yoke/adapters/codex.js)
//   (E) post-compaction re-read (lib/sdk-message-processor.js)
//
// (A)/(B) reuse the same minimal-DOM-stub + dynamic-import pattern as
// test/custom-model-capability-fallback-lr-f22787.test.js (app-panels.js
// has no top-level DOM access itself, but its import graph transitively
// reaches modules that do).

import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeFakeElement() {
  var el = {
    style: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    appendChild: function (c) { return c; },
    removeChild: function () {},
    setAttribute: function () {},
    getAttribute: function () { return null; },
    addEventListener: function () {},
    removeEventListener: function () {},
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    getBoundingClientRect: function () { return { width: 0, height: 0, top: 0, left: 0 }; },
    textContent: "",
    innerHTML: "",
    dataset: {},
    removeAttribute: function () {},
  };
  return el;
}

global.document = {
  addEventListener: function () {},
  removeEventListener: function () {},
  createElement: function () { return makeFakeElement(); },
  getElementById: function () { return makeFakeElement(); },
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  body: makeFakeElement(),
};
global.window = { innerWidth: 1024, innerHeight: 768, addEventListener: function () {}, removeEventListener: function () {} };
global.lucide = { createIcons: function () {} };
global.requestAnimationFrame = function () { return 0; };
global.cancelAnimationFrame = function () {};
global.localStorage = {
  _data: {},
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
  setItem: function (k, v) { this._data[k] = String(v); },
  removeItem: function (k) { delete this._data[k]; },
};
global.marked = { use: function () {}, parse: function (s) { return s; }, setOptions: function () {} };
global.mermaid = { initialize: function () {}, render: function () { return Promise.resolve({ svg: '' }); } };

var appPanels = await import('../lib/public/modules/app-panels.js');
var storeMod = await import('../lib/public/modules/store.js');

var resolveContextWindow = appPanels.resolveContextWindow;
var getEffectiveContextFill = appPanels.getEffectiveContextFill;
var accumulateContext = appPanels.accumulateContext;
var accumulateUsage = appPanels.accumulateUsage;
var getContextData = appPanels.getContextData;
var getSessionUsage = appPanels.getSessionUsage;
var createStore = storeMod.createStore;

test.beforeEach(function () {
  createStore({ replayingHistory: false });
});

// ---------------------------------------------------------------------------
// (A) resolveContextWindow / getEffectiveContextFill — vendor-first,
//     unknown/indeterminate state
// ---------------------------------------------------------------------------

test('lr-3af675: resolveContextWindow returns the vendor value unchanged when positive', function () {
  assert.equal(resolveContextWindow(200000), 200000);
  assert.equal(resolveContextWindow(1000000), 1000000);
});

test('lr-3af675: resolveContextWindow returns 0 (unknown) for a missing/zero/non-numeric vendor value — never a guessed default', function () {
  assert.equal(resolveContextWindow(0), 0);
  assert.equal(resolveContextWindow(null), 0);
  assert.equal(resolveContextWindow(undefined), 0);
  assert.equal(resolveContextWindow('claude-sonnet-4'), 0, 'a model NAME must never be treated as a window size');
  assert.equal(resolveContextWindow(-1), 0);
});

test('lr-3af675: no hardcoded model-name table is consulted — a model whose name substring-matches a former table entry resolves to unknown without an explicit vendor value', function () {
  // Regression pin for FINDING 1: claude-sonnet-4-5 used to substring-match
  // the old "claude-sonnet-4" table key and silently resolve to 1,000,000
  // even though its real window is 200,000. There is no table anymore, so
  // resolution depends ONLY on the vendor value passed in.
  createStore({ currentModel: 'claude-sonnet-4-5', replayingHistory: false });
  accumulateContext(0.01, { input_tokens: 1000, output_tokens: 10 }, null, null);
  var cd = getContextData();
  assert.equal(cd.contextWindow, 0, 'with no modelUsage.contextWindow reported, the window must be unknown (0), never inferred from the model name');
});

test('lr-3af675: getEffectiveContextFill reports (0, 0) before any turn has completed — the meter must render blank, not a fabricated 0/200K/0%', function () {
  createStore({ richContextUsage: null, replayingHistory: false });
  // Fresh contextData (module state) — resetContextData() would also reach
  // this state; accumulateContext has not been called in this test.
  appPanels.resetContextData();
  var fill = getEffectiveContextFill();
  assert.equal(fill.win, 0, 'no vendor window known yet -> unknown, not a guess');
});

test('lr-3af675: getEffectiveContextFill prefers the rich context-usage breakdown when present', function () {
  createStore({
    replayingHistory: false,
    richContextUsage: { totalTokens: 55000, maxTokens: 200000, categories: [] },
  });
  appPanels.resetContextData();
  // Also populate contextData via accumulateContext with a DIFFERENT figure,
  // to prove richContextUsage wins when both are present.
  createStore({
    replayingHistory: false,
    richContextUsage: { totalTokens: 55000, maxTokens: 200000, categories: [] },
    currentModel: 'claude-sonnet-4-6',
  });
  accumulateContext(0.02, { input_tokens: 40000 }, { 'claude-sonnet-4-6': { contextWindow: 200000 } }, null);

  var fill = getEffectiveContextFill();
  assert.equal(fill.used, 55000, 'the rich breakdown\'s totalTokens must win over contextData.input when both are available');
  assert.equal(fill.win, 200000);
});

test('lr-3af675: getEffectiveContextFill falls back to contextData when richContextUsage has no usable maxTokens', function () {
  createStore({
    replayingHistory: false,
    richContextUsage: { totalTokens: 999, maxTokens: 0, categories: [] }, // vendor reported no window here
    currentModel: 'claude-sonnet-4-6',
  });
  appPanels.resetContextData();
  accumulateContext(0.02, { input_tokens: 12345 }, { 'claude-sonnet-4-6': { contextWindow: 200000 } }, null);

  var fill = getEffectiveContextFill();
  assert.equal(fill.used, 12345, 'must fall back to contextData.input when the rich breakdown has no positive maxTokens');
  assert.equal(fill.win, 200000);
});

// ---------------------------------------------------------------------------
// (B) accumulateContext / accumulateUsage — vendor-first window + cache_creation
// ---------------------------------------------------------------------------

test('lr-3af675: accumulateContext takes the window straight from vendor-reported modelUsage.contextWindow', function () {
  createStore({ currentModel: 'gpt-5.5', replayingHistory: false });
  appPanels.resetContextData();
  accumulateContext(0.03, { input_tokens: 500 }, { 'gpt-5.5': { contextWindow: 1048576 } }, null);
  var cd = getContextData();
  assert.equal(cd.contextWindow, 1048576, 'the vendor-reported window must be used verbatim, no table lookup involved');
});

test('lr-3af675: accumulateContext falls back input to input_tokens + cache_read_input_tokens + cache_creation_input_tokens when no lastStreamInputTokens is given (all three usage fields are disjoint and occupy the window)', function () {
  createStore({ currentModel: 'claude-sonnet-4-6', replayingHistory: false });
  appPanels.resetContextData();
  accumulateContext(0.05, {
    input_tokens: 1000,
    cache_read_input_tokens: 2000,
    cache_creation_input_tokens: 3000,
    output_tokens: 50,
  }, null, null);
  var cd = getContextData();
  assert.equal(cd.input, 6000, 'FINDING 3: cache_creation_input_tokens was previously omitted from the context-fill sum');
});

test('lr-3af675: accumulateUsage sessionUsage.context also includes cache_creation_input_tokens in its fallback sum', function () {
  createStore({ replayingHistory: false });
  appPanels.resetUsage();
  accumulateUsage(0.05, {
    input_tokens: 100,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 300,
    output_tokens: 10,
  }, null);
  var su = getSessionUsage();
  assert.equal(su.context, 600, 'the usage-panel context figure must also count cache_creation_input_tokens');
});

test('lr-3af675: accumulateContext prefers lastStreamInputTokens over the summed fallback when both are available', function () {
  createStore({ currentModel: 'claude-sonnet-4-6', replayingHistory: false });
  appPanels.resetContextData();
  accumulateContext(0.05, {
    input_tokens: 1000,
    cache_read_input_tokens: 2000,
    cache_creation_input_tokens: 3000,
  }, null, 9999);
  var cd = getContextData();
  assert.equal(cd.input, 9999, 'lastStreamInputTokens (the accurate per-call figure) must still win when present');
});

// ---------------------------------------------------------------------------
// (C) claude.js's message_start usage extraction — cache_creation inclusion
//     at the source (this is the field that becomes lastStreamInputTokens)
// ---------------------------------------------------------------------------

test('lr-3af675: claude.js flattenEvent message_start includes cache_creation_input_tokens in inputTokens', async function () {
  var claudeAdapter = await import('../lib/yoke/adapters/claude.js');
  var flattenEvent = claudeAdapter._test_flattenEvent;
  assert.equal(typeof flattenEvent, 'function', '_test_flattenEvent must be exported from lib/yoke/adapters/claude.js');

  var raw = {
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 1000,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 3000,
        },
      },
    },
  };
  var result = flattenEvent(raw);
  assert.equal(result.yokeType, 'turn_start');
  assert.equal(result.inputTokens, 6000,
    'input_tokens + cache_read_input_tokens + cache_creation_input_tokens -- all three are disjoint and occupy the window (the input_tokens + cache_read_input_tokens sum was already correct; cache_creation_input_tokens was the omission)');
});

test('lr-3af675: claude.js flattenEvent message_start with no cache_creation_input_tokens still sums correctly (field absent, not present-as-zero-in-a-different-shape)', async function () {
  var claudeAdapter = await import('../lib/yoke/adapters/claude.js');
  var flattenEvent = claudeAdapter._test_flattenEvent;

  var raw = {
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: { usage: { input_tokens: 500, cache_read_input_tokens: 100 } },
    },
  };
  var result = flattenEvent(raw);
  assert.equal(result.inputTokens, 600);
});

// ---------------------------------------------------------------------------
// (D) codex.js's getContextUsage — no fabricated rich-usage shape
// ---------------------------------------------------------------------------

test('lr-3af675: codex.js QueryHandle.getContextUsage() resolves null instead of a flat usage object masquerading as rich context data', async function () {
  var codexAdapter = await import('../lib/yoke/adapters/codex.js');
  var createHandle = codexAdapter._test_createCodexQueryHandle;
  assert.equal(typeof createHandle, 'function', '_test_createCodexQueryHandle must be exported from lib/yoke/adapters/codex.js');

  var handle = createHandle(
    { started: false, send: function () { return Promise.resolve({}); } },
    { model: 'gpt-5.5' }
  );

  var usage = await handle.getContextUsage();
  assert.equal(usage, null,
    'FINDING 5: returning state.lastUsage here made the frontend richContextUsage truthiness check pass ' +
    'and render a confident but fabricated "0 / 200K - 0%" popover for Codex sessions. Must resolve null so ' +
    'the frontend falls through to its unknown/unsupported state instead.');
});

// ---------------------------------------------------------------------------
// (E) post-compaction re-read (lib/sdk-message-processor.js)
// ---------------------------------------------------------------------------

test('lr-3af675: the compacting -> not-compacting transition re-reads vendor context usage and pushes a fresh context_usage message', async function () {
  var { attachMessageProcessor } = await import('../lib/sdk-message-processor.js');

  var sent = [];
  var sm = {
    skillMeta: [], workflowMeta: [], skillNames: [], slashCommands: null,
    currentModel: null, _savedDefaultModel: null,
    sendAndRecord: function (session, obj) { sent.push(obj); },
    sendToSession: function (session, obj) { sent.push(obj); },
    saveSessionFile: function () {}, broadcastSessionList: function () {},
    modelsByVendor: {}, availableModels: [], availableVendors: [], installedVendors: [],
  };

  var processor = attachMessageProcessor({
    sm: sm,
    send: function (obj) { sent.push(obj); },
    slug: 'test-slug', cwd: '/tmp', pushModule: null,
    getNotificationsModule: function () { return null; },
    adapter: { vendor: 'claude' },
    onProcessingChanged: function () {}, onTurnDone: null, onAutoTitle: null,
    opts: {},
    discoverSkillDirs: function () { return []; },
    mergeSkills: function () { return []; },
    discoverWorkflows: function () { return []; },
    discoverSkillsWithMeta: function () { return []; },
    mergeSkillsWithMeta: function () { return []; },
    getSDK: null,
  });

  var postCompactUsage = { totalTokens: 12000, maxTokens: 200000, categories: [] };
  var session = {
    localId: 's1', cliSessionId: null, vendor: 'claude', history: [],
    messageUUIDs: [], blocks: {}, sentToolResults: {}, pendingPermissions: {},
    pendingElicitations: {}, pendingAskUser: {}, activeTaskToolIds: {},
    taskIdMap: {}, streamedText: false, responsePreview: '', isProcessing: false,
    loop: null,
    // A compaction is already in progress when the "no longer compacting"
    // status event arrives -- this is the transition the fix targets.
    compacting: true,
    queryInstance: {
      getContextUsage: function () { return Promise.resolve(postCompactUsage); },
    },
  };

  processor.processSDKMessage(session, { yokeType: 'status', status: 'idle' });
  // getContextUsage() is fire-and-forget (a .then chain); flush microtasks.
  await new Promise(function (r) { setImmediate(r); });

  var compactingOff = sent.filter(function (m) { return m.type === 'compacting' && m.active === false; });
  assert.equal(compactingOff.length, 1, 'the compacting:false transition message must still be sent');

  var ctxMsgs = sent.filter(function (m) { return m.type === 'context_usage'; });
  assert.equal(ctxMsgs.length, 1, 'exactly one context_usage re-read must be pushed on the compacting -> not-compacting transition');
  assert.deepEqual(ctxMsgs[0].data, postCompactUsage, 'the pushed data must be the freshly re-read vendor usage, not the stale pre-compaction figure');
  assert.deepEqual(session.lastContextUsage, postCompactUsage, 'session.lastContextUsage must be updated so a later synchronous read (e.g. the next turn\'s soft context-window warn) sees the fresh value');
});

test('lr-3af675: no compaction was in progress -> no extra context_usage re-read fires on an ordinary status event', async function () {
  var { attachMessageProcessor } = await import('../lib/sdk-message-processor.js');

  var sent = [];
  var sm = {
    skillMeta: [], workflowMeta: [], skillNames: [], slashCommands: null,
    currentModel: null, _savedDefaultModel: null,
    sendAndRecord: function (session, obj) { sent.push(obj); },
    sendToSession: function (session, obj) { sent.push(obj); },
    saveSessionFile: function () {}, broadcastSessionList: function () {},
    modelsByVendor: {}, availableModels: [], availableVendors: [], installedVendors: [],
  };

  var processor = attachMessageProcessor({
    sm: sm,
    send: function (obj) { sent.push(obj); },
    slug: 'test-slug', cwd: '/tmp', pushModule: null,
    getNotificationsModule: function () { return null; },
    adapter: { vendor: 'claude' },
    onProcessingChanged: function () {}, onTurnDone: null, onAutoTitle: null,
    opts: {},
    discoverSkillDirs: function () { return []; },
    mergeSkills: function () { return []; },
    discoverWorkflows: function () { return []; },
    discoverSkillsWithMeta: function () { return []; },
    mergeSkillsWithMeta: function () { return []; },
    getSDK: null,
  });

  var getContextUsageCalls = 0;
  var session = {
    localId: 's1', cliSessionId: null, vendor: 'claude', history: [],
    messageUUIDs: [], blocks: {}, sentToolResults: {}, pendingPermissions: {},
    pendingElicitations: {}, pendingAskUser: {}, activeTaskToolIds: {},
    taskIdMap: {}, streamedText: false, responsePreview: '', isProcessing: false,
    loop: null,
    compacting: false, // never compacting
    queryInstance: {
      getContextUsage: function () { getContextUsageCalls++; return Promise.resolve({}); },
    },
  };

  processor.processSDKMessage(session, { yokeType: 'status', status: 'idle' });
  await new Promise(function (r) { setImmediate(r); });

  assert.equal(getContextUsageCalls, 0, 'getContextUsage must only be re-read on a genuine compacting -> not-compacting transition');
});

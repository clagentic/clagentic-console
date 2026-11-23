// The effort, betas and thinking pickers (session popover and the Settings
// pages) each state their scope through renderScopeLabel(), the Settings
// Thinking pickers save a default rather than the live session's setting, and
// the 1M-context beta identifier has one source that both toggles send.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function makeFakeElement(id) {
  var listeners = {};
  var children = [];
  return {
    id: id,
    tagName: "div",
    className: "",
    textContent: "",
    innerHTML: "",
    value: "",
    checked: false,
    dataset: {},
    style: {},
    children: children,
    listeners: listeners,
    classList: {
      _set: {},
      add: function (c) { this._set[c] = true; },
      remove: function (c) { delete this._set[c]; },
      toggle: function (c, force) { if (force === undefined ? !this._set[c] : force) this._set[c] = true; else delete this._set[c]; return !!this._set[c]; },
      contains: function (c) { return !!this._set[c]; },
    },
    appendChild: function (c) { children.push(c); return c; },
    removeChild: function () {},
    setAttribute: function () {},
    getAttribute: function () { return null; },
    removeAttribute: function () {},
    addEventListener: function (evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
    removeEventListener: function () {},
    dispatch: function (evt, arg) { (listeners[evt] || []).forEach(function (fn) { fn.call(this, arg || { stopPropagation: function () {} }); }, this); },
    contains: function () { return false; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    getBoundingClientRect: function () { return { width: 0, height: 0, top: 0, left: 0 }; },
  };
}

var byId = {};
global.document = {
  addEventListener: function () {},
  removeEventListener: function () {},
  createElement: function () { return makeFakeElement(""); },
  getElementById: function (id) { if (!byId[id]) byId[id] = makeFakeElement(id); return byId[id]; },
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  body: makeFakeElement("body"),
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

var defaults = await import('../lib/public/modules/settings-defaults.js');
var appPanels = await import('../lib/public/modules/app-panels.js');
var storeMod = await import('../lib/public/modules/store.js');
var wsRef = await import('../lib/public/modules/ws-ref.js');
var beta = await import('../lib/public/modules/context-1m-beta.js');

test.beforeEach(function () {
  byId = {};
});

// --- the settings pages ----------------------------------------------------

var SETTINGS_SURFACES = [
  { prefix: "ss", label: "Server default", thinkingMsgType: "set_server_default_thinking" },
  { prefix: "ps", label: "Default for new sessions in this project", thinkingMsgType: "set_project_default_thinking" },
];

SETTINGS_SURFACES.forEach(function (row) {
  test(row.prefix + " settings: effort, thinking and beta each state the scope, and Thinking saves a default", function () {
    var sent = [];
    var opts = {
      currentEffort: "medium", currentThinking: "adaptive", currentThinkingBudget: 10000, currentBetas: [],
      currentModel: "claude-sonnet-4-6", scopeLabel: row.label, thinkingMsgType: row.thinkingMsgType,
      sendMsg: function (type, data) { sent.push([type, data]); },
      effortMsgType: "x", betasMsgType: "y",
    };
    defaults.renderEffortBar(row.prefix, opts);
    defaults.renderThinkingBar(row.prefix, opts);
    defaults.renderBetaCard(row.prefix, opts);

    assert.equal(byId[row.prefix + "-effort-scope"].textContent, row.label);
    assert.equal(byId[row.prefix + "-thinking-scope"].textContent, row.label);
    assert.equal(byId[row.prefix + "-beta-scope"].textContent, row.label);

    var buttons = byId[row.prefix + "-thinking-bar"].children;
    buttons[buttons.length - 1].dispatch("click");
    assert.equal(sent[0][0], row.thinkingMsgType, "the Thinking control sends the default's message, not set_thinking");
  });
});

test("a Thinking picker given no message type keeps sending the session's (the loop pickers intercept it)", function () {
  var sent = [];
  defaults.renderThinkingBar("rp", { currentThinking: "adaptive", sendMsg: function (type) { sent.push(type); } });
  byId["rp-thinking-bar"].children[0].dispatch("click");
  assert.deepEqual(sent, ["set_thinking"]);
});

// --- what the default pickers show ------------------------------------------

// The pickers show the saved defaults, not the viewed session's values. A
// project falls back to the server's default for what it has not set.
var SAVED = {
  server: { model: "claude-sonnet-4-6", mode: "acceptEdits", effort: "high", betas: ["server-beta"], thinking: "budget", thinkingBudget: 4096 },
  project: { model: null, mode: null, effort: null, betas: [], thinking: null, thinkingBudget: null },
};
var SESSION_VIEW = { currentModel: "claude-haiku-4-5", currentMode: "plan", currentEffort: "low", currentBetas: ["own-beta"], currentThinking: "disabled", currentThinkingBudget: 2048 };

[
  { name: "server page", level: "server", saved: SAVED, expect: { currentModel: "claude-sonnet-4-6", currentMode: "acceptEdits", currentEffort: "high", currentBetas: ["server-beta"], currentThinking: "budget", currentThinkingBudget: 4096 } },
  { name: "project page with nothing of its own", level: "project", saved: SAVED, expect: { currentModel: "claude-sonnet-4-6", currentMode: "acceptEdits", currentEffort: "high", currentBetas: ["server-beta"], currentThinking: "budget", currentThinkingBudget: 4096 } },
  {
    name: "project page with its own defaults",
    level: "project",
    saved: { server: SAVED.server, project: { model: "claude-opus-4-7", mode: "plan", effort: "max", betas: ["project-beta"], thinking: "adaptive", thinkingBudget: null } },
    expect: { currentModel: "claude-opus-4-7", currentMode: "plan", currentEffort: "max", currentBetas: ["project-beta"], currentThinking: "adaptive", currentThinkingBudget: 10000 },
  },
  { name: "server page with nothing saved", level: "server", saved: { server: {}, project: {} }, expect: { currentModel: "", currentMode: "default", currentEffort: "medium", currentBetas: [], currentThinking: "adaptive", currentThinkingBudget: 10000 } },
].forEach(function (row) {
  test("default pickers show the saved defaults, not the session's: " + row.name, function () {
    var picked = defaults.defaultPickerValues(row.saved, row.level);
    assert.deepEqual(picked, row.expect);

    var opts = Object.assign({}, SESSION_VIEW, picked, {
      models: [{ value: "claude-haiku-4-5" }, { value: "claude-sonnet-4-6" }, { value: "claude-opus-4-7" }],
      sendMsg: function () {}, effortMsgType: "x", betasMsgType: "y",
    });
    defaults.renderModelList("ss", opts);
    assert.deepEqual(byId["ss-model-list"].children.filter(function (c) { return /active/.test(c.className); }).map(function (c) { return c.dataset.model; }),
      row.expect.currentModel ? [row.expect.currentModel] : []);
    defaults.renderEffortBar("ss", opts);
    defaults.renderThinkingBar("ss", opts);
    defaults.renderBetaCard("ss", opts);
    var active = function (id) {
      return byId[id].children.filter(function (c) { return /active/.test(c.className); }).map(function (c) { return c.textContent; });
    };
    assert.deepEqual(active("ss-effort-bar"), [row.expect.currentEffort.charAt(0).toUpperCase() + row.expect.currentEffort.slice(1)]);
    assert.deepEqual(active("ss-thinking-bar"), [{ disabled: "Off", adaptive: "Adaptive", budget: "Budget" }[row.expect.currentThinking]]);
    assert.equal(byId["ss-thinking-budget"].value, row.expect.currentThinkingBudget);
    assert.equal(byId["ss-beta-1m"].checked, false, "no 1M beta among the saved defaults");
  });
});

test("the saved 1M beta default is what the Settings toggle shows, whatever the session holds", function () {
  var saved = { server: { betas: [beta.CONTEXT_1M_BETA_FALLBACK], model: "claude-sonnet-4-6" }, project: {} };
  var picked = defaults.defaultPickerValues(saved, "server");
  defaults.renderBetaCard("ss", Object.assign({ currentBetas: [] }, SESSION_VIEW, picked));
  assert.equal(byId["ss-beta-1m"].checked, true);
});

// --- the 1M-context identifier --------------------------------------------

test("the Settings toggle sends the shared 1M identifier, and switching it off removes every form of it", function () {
  var sent = [];
  var opts = { currentBetas: ["other-beta"], currentModel: "claude-sonnet-4-6", sendMsg: function (type, data) { sent.push([type, data]); }, betasMsgType: "set_server_default_betas" };
  defaults.renderBetaCard("ss", opts);
  var toggle = byId["ss-beta-1m"];
  toggle.checked = true;
  toggle.onchange();
  assert.deepEqual(sent[0][1].betas, ["other-beta", beta.CONTEXT_1M_BETA_FALLBACK]);

  opts.currentBetas = ["other-beta", "context-1m-some-later-date"];
  defaults.renderBetaCard("ss", opts);
  assert.equal(byId["ss-beta-1m"].checked, true, "any 1M identifier reads as on");
  byId["ss-beta-1m"].checked = false;
  byId["ss-beta-1m"].onchange();
  assert.deepEqual(sent[1][1].betas, ["other-beta"]);
});

test("the session popover toggle sends the same shared identifier", function () {
  storeMod.createStore({ currentBetas: ["other-beta"], currentModel: "claude-sonnet-4-6", currentModels: [], currentEffort: "medium", currentThinking: "adaptive", currentThinkingBudget: 10000 });
  var sent = [];
  wsRef.setWs({ readyState: 1, send: function (data) { sent.push(JSON.parse(data)); } });
  appPanels.initPanels();
  byId["config-beta-1m"].dispatch("click", { stopPropagation: function () {} });
  assert.equal(sent[0].type, "set_betas");
  assert.deepEqual(sent[0].betas, ["other-beta", beta.CONTEXT_1M_BETA_FALLBACK]);
  wsRef.setWs(null);
});

test("the dated 1M identifier is written once in lib/, in the shared fallback constant", function () {
  var root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib");
  var hits = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
      var full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); return; }
      if (!/\.(js|html)$/.test(entry.name)) return;
      var count = fs.readFileSync(full, "utf8").split(beta.CONTEXT_1M_BETA_FALLBACK).length - 1;
      if (count > 0) hits.push([path.relative(root, full), count]);
    });
  })(root);
  assert.deepEqual(hits, [[path.join("public", "modules", "context-1m-beta.js"), 1]]);
});

// --- the session popover ---------------------------------------------------

test("the session popover states 'This session only' for effort, thinking and beta through the shared label helper", function () {
  storeMod.createStore({
    currentModel: "claude-sonnet-4-6",
    currentModels: [{ value: "claude-sonnet-4-6", displayName: "Sonnet", supportsEffort: true }],
    currentEffort: "medium", currentThinking: "adaptive", currentThinkingBudget: 10000, currentBetas: [],
  });
  appPanels.initPanels();
  appPanels.updateConfigChip();
  assert.equal(byId["config-effort-scope"].textContent, "This session only");
  assert.equal(byId["config-thinking-scope"].textContent, "This session only");
  assert.equal(byId["config-beta-scope"].textContent, "This session only");
});

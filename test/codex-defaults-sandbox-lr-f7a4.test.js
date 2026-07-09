// Regression test for lr-f7a4 — Codex sandbox must not default to
// "danger-full-access". That default removed all filesystem guardrails for
// every Codex session that never explicitly touched the sandbox setting.
//
// Imports the real CODEX_DEFAULTS / getCodexConfig from lib/codex-defaults.js
// rather than inlining a copy, so reverting the default back to
// "danger-full-access" fails this test.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var { CODEX_DEFAULTS, getCodexConfig } = require("../lib/codex-defaults");

test("lr-f7a4: default sandbox is not danger-full-access", function () {
  assert.notEqual(CODEX_DEFAULTS.sandbox, "danger-full-access");
});

test("lr-f7a4: getCodexConfig falls back to the safe default sandbox when session-manager has no explicit setting", function () {
  var config = getCodexConfig(null);
  assert.notEqual(config.sandbox, "danger-full-access");
  assert.equal(config.sandbox, CODEX_DEFAULTS.sandbox);
});

test("lr-f7a4: getCodexConfig still honors an explicit danger-full-access opt-in", function () {
  var sm = { codexSandbox: "danger-full-access" };
  var config = getCodexConfig(sm);
  assert.equal(config.sandbox, "danger-full-access");
});

test("lr-f7a4: getCodexConfig does not force a fixed approval policy — it passes through whatever is configured", function () {
  var smOnRequest = { codexApproval: "on-request" };
  assert.equal(getCodexConfig(smOnRequest).approval, "on-request");

  var smDefault = null;
  assert.equal(getCodexConfig(smDefault).approval, CODEX_DEFAULTS.approval);
  assert.notEqual(CODEX_DEFAULTS.approval, "never");
});

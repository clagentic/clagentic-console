"use strict";
/**
 * Regression test for lr-db0437: setModel() used to write the chosen model
 * into BOTH session.model AND the shared sm.currentModel. Since sm.currentModel
 * is what new_session (lib/project-sessions.js) seeds a brand-new session's
 * model from, any session picking a model silently became the de-facto
 * project default for every session created afterward.
 *
 * Fix mirrors the existing setPermissionMode pattern (lib/sdk-bridge.js,
 * same file): a session-only write. sm.currentModel is now only ever
 * updated by the explicit default-setter handlers
 * (set_project_default_model / set_server_default_model in
 * project-sessions.js), never by a plain per-session setModel call.
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var { createSDKBridge } = require("../lib/sdk-bridge");

function makeBridge(smOverrides) {
  var sent = [];
  var sm = Object.assign({
    currentModel: null,
    modelsByVendor: {},
  }, smOverrides);
  var bridge = createSDKBridge({
    cwd: "/tmp/test-db0437",
    slug: "test-db0437",
    sessionManager: sm,
    send: function (msg) { sent.push(msg); },
    adapter: { vendor: "claude" },
    adapters: {},
  });
  return { bridge: bridge, sm: sm, sent: sent };
}

test("lr-db0437: setModel on a session with no active query writes session.model only, never sm.currentModel", async function () {
  var { bridge, sm } = makeBridge({ currentModel: "sonnet" });
  var session = { localId: 1, queryInstance: null, model: null };

  await bridge.setModel(session, "opus");

  assert.strictEqual(session.model, "opus", "session.model must reflect the new choice");
  assert.strictEqual(sm.currentModel, "sonnet",
    "sm.currentModel (the project/global default) must be untouched by a per-session setModel call");
});

test("lr-db0437: setModel on a session with an active query writes session.model only, never sm.currentModel", async function () {
  var { bridge, sm } = makeBridge({ currentModel: "haiku" });
  var setModelCalls = [];
  var session = {
    localId: 2,
    model: "sonnet",
    vendor: "claude",
    queryInstance: {
      setModel: function (model) { setModelCalls.push(model); return Promise.resolve(); },
    },
  };

  await bridge.setModel(session, "opus");

  assert.deepStrictEqual(setModelCalls, ["opus"], "the live query must still be told to switch model");
  assert.strictEqual(session.model, "opus");
  assert.strictEqual(sm.currentModel, "haiku",
    "sm.currentModel (the project/global default) must be untouched even when a live query is running");
});

test("lr-db0437: two sessions setting different models never bleed into each other via sm.currentModel", async function () {
  var { bridge, sm } = makeBridge({ currentModel: null });
  var sessionA = { localId: 1, queryInstance: null, model: null };
  var sessionB = { localId: 2, queryInstance: null, model: null };

  await bridge.setModel(sessionA, "opus");
  await bridge.setModel(sessionB, "haiku");

  assert.strictEqual(sessionA.model, "opus");
  assert.strictEqual(sessionB.model, "haiku");
  assert.strictEqual(sm.currentModel, null,
    "no per-session setModel call should ever populate the shared project/global default");
});

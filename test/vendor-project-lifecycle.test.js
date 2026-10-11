"use strict";
// The project context, end to end over a real WebSocket: what a non-default
// agent's live session advertises is recorded and re-sent to the clients, and
// a project shuts down the runtimes that belong to it and only those. Both
// agents here are fakes whose ids are neither of the shipped agents', so the
// outcome can only come from what they declare.

var test = require("node:test");
var assert = require("node:assert/strict");
var harness = require("./access-harness");

var PER_PROJECT = "acme-project";
var SHARED = "acme-shared";

var H = null;
var shutdownCalls = [];

function fakeDescriptor(id, perProjectRuntime) {
  return {
    id: id,
    displayName: id,
    priority: 99,
    binaryNames: [id],
    probeInstalled: function () { return true; },
    checkAuth: function () { return true; },
    installHint: "Install " + id + ".",
    loginCommand: id + " signin",
    osUsersSupported: false,
    needsRuntimeEnv: false,
    perProjectRuntime: perProjectRuntime,
    ownedEnvNames: [],
    nativeInstructionFiles: [],
    interruptMessage: "Stopped.",
    capabilities: { agentInjection: true, permissionModes: ["default", "auto"] },
    createAdapter: function () {
      return {
        vendor: id,
        // The live session withdraws agent injection and one permission mode.
        init: function () {
          return Promise.resolve({ models: [], skills: [], capabilities: { agentInjection: false, permissionModes: ["default"] } });
        },
        supportedModels: function () { return Promise.resolve([]); },
        createToolServer: function () { return {}; },
        createQuery: function () { return Promise.resolve({}); },
        shutdown: function () { shutdownCalls.push(id); return Promise.resolve(true); },
      };
    },
  };
}

test.before(async function () {
  H = await harness.start({
    users: [{ key: "alice", username: "alice" }],
    projects: [{ slug: "life", visibility: "public", ownerKey: "alice" }],
    beforeServer: function () {
      var registry = require("../lib/yoke").registry;
      registry.register(fakeDescriptor(PER_PROJECT, true));
      registry.register(fakeDescriptor(SHARED, false));
    },
  });
});

test.after(async function () {
  if (H) await H.stop();
});

function entryFor(message, id) {
  return message.vendors.filter(function (v) { return v.id === id; })[0];
}

test("get_vendor_models records a non-default agent's live capabilities and re-sends the registry to the clients", async function () {
  var c = await H.connect("life", "alice");
  var observer = await H.connect("life", "alice");
  c.send({ type: "get_vendor_models", vendor: PER_PROJECT });
  function narrowed(m) {
    return m.type === "vendor_registry" && entryFor(m, PER_PROJECT).capabilities.agentInjection === false;
  }
  var mine = await c.waitFor(narrowed);
  assert.deepEqual(entryFor(mine, PER_PROJECT).capabilities.permissionModes, ["default"], "the live session's list narrows the declaration");
  var theirs = await observer.waitFor(narrowed);
  assert.equal(entryFor(theirs, PER_PROJECT).capabilities.agentInjection, false, "every client of the project is told");
});

test("removing a project shuts down the runtimes that belong to it and leaves a shared one running", async function () {
  assert.equal(shutdownCalls.indexOf(SHARED), -1);
  H.relay.removeProject("life");
  await harness.settle(200);
  assert.deepEqual(shutdownCalls.filter(function (id) { return id === PER_PROJECT; }), [PER_PROJECT], "the per-project runtime is shut down once");
  assert.equal(shutdownCalls.indexOf(SHARED), -1, "the shared runtime keeps running");
});

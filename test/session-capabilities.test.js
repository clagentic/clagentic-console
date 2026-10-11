"use strict";
// The one accessor every session-facing decision reads: resolved capabilities
// per vendor, never a declaration, and none at all where nothing is recorded.

var test = require("node:test");
var assert = require("node:assert/strict");
var yoke = require("../lib/yoke");
var sessionCapabilities = require("../lib/session-capabilities");

test("nothing recorded means nothing allowed, for a registered and an unregistered vendor alike", function () {
  var sm = {};
  ["claude", "ghost", null, undefined, "__proto__"].forEach(function (vendor) {
    var caps = sessionCapabilities.capabilitiesFor(sm, vendor);
    assert.equal(caps.agentInjection, false, String(vendor));
    assert.deepEqual(caps.permissionModes, [], String(vendor));
    assert.deepEqual(Object.keys(caps).sort(), Object.keys(yoke.registry.declaredCapabilities("claude")).sort());
  });
});

test("seeding gives every registered vendor its declaration once, and keeps what a live session recorded", function () {
  var sm = {};
  sessionCapabilities.seedCapabilities(sm);
  assert.deepEqual(Object.keys(sm.capabilitiesByVendor).sort(), yoke.registry.ids().sort());
  sessionCapabilities.recordCapabilities(sm, "claude", { agentInjection: false });
  sessionCapabilities.seedCapabilities(sm);
  assert.equal(sessionCapabilities.capabilitiesFor(sm, "claude").agentInjection, false, "a later seed does not restore the declaration");
});

test("a recorded set is the declaration narrowed by the live session, and a read is a copy", function () {
  var sm = {};
  var recorded = sessionCapabilities.recordCapabilities(sm, "claude", { effort: false, permissionModes: ["default", "auto"] });
  assert.equal(recorded.effort, false);
  assert.deepEqual(recorded.permissionModes, ["default", "auto"]);
  assert.equal(recorded.rewind, true, "left as declared");
  var read = sessionCapabilities.capabilitiesFor(sm, "claude");
  read.permissionModes.push("mutated");
  assert.deepEqual(sessionCapabilities.capabilitiesFor(sm, "claude").permissionModes, ["default", "auto"]);
});

test("the effective vendor is the session's own, then its adapter's, then the project default", function () {
  var sm = { defaultVendor: "codex" };
  assert.equal(sessionCapabilities.effectiveVendorId(sm, { vendor: "claude" }, "codex"), "claude");
  assert.equal(sessionCapabilities.effectiveVendorId(sm, { vendor: null }, "claude"), "claude");
  assert.equal(sessionCapabilities.effectiveVendorId(sm, {}, null), "codex");
  assert.equal(sessionCapabilities.effectiveVendorId({}, null, null), null);
});

"use strict";

// The notification core's public surface. notifyFor(push) returns the core
// bound to a push module; every caller holding the same push module shares one
// core, so a notification raised in one place is closed from another.

var { createTypeRegistry } = require("./type-registry");
var { registerBuiltins } = require("./types");
var { createNotifyCore } = require("./core");
var target = require("./target");

var registry = registerBuiltins(createTypeRegistry());
var cores = new WeakMap();
var detached = null;

/**
 * @param {?object} push the push module; null gives a core that records
 *   nothing deliverable (no push configured).
 */
function notifyFor(push) {
  if (!push) {
    if (!detached) detached = createNotifyCore({ registry: registry, push: null });
    return detached;
  }
  var core = cores.get(push);
  if (!core) {
    core = createNotifyCore({ registry: registry, push: push });
    cores.set(push, core);
  }
  return core;
}

module.exports = {
  notifyFor: notifyFor,
  registerType: registry.register,
  getType: registry.get,
  targetKey: target.targetKey,
  makeTarget: target.makeTarget,
  createNotifyCore: createNotifyCore,
  createTypeRegistry: createTypeRegistry,
};

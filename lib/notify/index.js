"use strict";

// The notification core's public surface. notifyFor(push, inApp) returns the
// core bound to a push module and the in-app banner store.

var { createTypeRegistry } = require("./type-registry");
var { registerBuiltins } = require("./types");
var { createNotifyCore } = require("./core");
var target = require("./target");

var registry = registerBuiltins(createTypeRegistry());

/**
 * The core is stateless (every tag derives from the target), so a notification
 * raised through one instance is closed through another.
 * @param {?object} push the push module; null for no push.
 * @param {?object} [inApp] the in-app banner store (lib/project-notifications.js).
 */
function notifyFor(push, inApp) {
  return createNotifyCore({ registry: registry, push: push || null, inApp: inApp || null });
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

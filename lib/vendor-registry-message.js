// vendor-registry-message.js - the agent registry as the browser receives it:
// every registered agent with its display data, whether it is installed, the
// login command and the capabilities its controls are gated on. The agent
// picker and every capability-gated control render from this message, so a
// newly registered agent appears without a front-end change.

var registry = require("./yoke").registry;

/**
 * @param {object} sm  the session manager (installedVendors, availableVendors,
 *   capabilitiesByVendor)
 * @returns {{type: string, vendors: object[], reasons: object}}
 */
function buildVendorRegistryMessage(sm) {
  return {
    type: "vendor_registry",
    vendors: registry.describeForClient({
      installed: sm.installedVendors || [],
      available: sm.availableVendors || [],
      capabilities: sm.capabilitiesByVendor || {},
    }),
    reasons: registry.capabilityReasons(),
  };
}

module.exports = { buildVendorRegistryMessage: buildVendorRegistryMessage };

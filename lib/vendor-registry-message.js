// vendor-registry-message.js - the agent registry as the browser receives it:
// every registered agent with its display data, whether it is installed, the
// login command and the capabilities its controls are gated on. The agent
// picker and every capability-gated control render from this message, so a
// newly registered agent appears without a front-end change.
//
// Install state belongs to an OS identity: what is on one user's PATH says
// nothing about another's. The session manager keeps it per identity
// (installStateByUser, keyed by Linux user name, "" for the daemon account).

var registry = require("./yoke").registry;

var DAEMON_IDENTITY_KEY = "";

/**
 * Records what an install lookup found for one OS identity.
 * @param {object} sm
 * @param {?string} linuxUser  null for the daemon's own account
 * @param {{installed: string[], failures: object}} state
 */
function recordInstallState(sm, linuxUser, state) {
  sm.installStateByUser = sm.installStateByUser || {};
  sm.installStateByUser[linuxUser || DAEMON_IDENTITY_KEY] = state;
  if (!linuxUser) sm.installedVendors = state.installed;
}

/**
 * What is known about installed agents for an OS identity. An identity not
 * looked up yet gets the project-wide list from the last warm-up.
 * @param {object} sm
 * @param {?string} linuxUser
 * @returns {{installed: string[], failures: object}}
 */
function installStateFor(sm, linuxUser) {
  var byUser = sm.installStateByUser || {};
  var key = linuxUser || DAEMON_IDENTITY_KEY;
  if (Object.prototype.hasOwnProperty.call(byUser, key)) return byUser[key];
  return { installed: sm.installedVendors || [], failures: {} };
}

/**
 * @param {object} sm  the session manager (installedVendors, availableVendors,
 *   capabilitiesByVendor, installStateByUser)
 * @param {?string} [linuxUser]  the OS identity the message is for
 * @returns {{type: string, vendors: object[], reasons: object}}
 */
function buildVendorRegistryMessage(sm, linuxUser) {
  var state = installStateFor(sm, linuxUser);
  return {
    type: "vendor_registry",
    vendors: registry.describeForClient({
      installed: state.installed,
      probeFailures: state.failures,
      available: sm.availableVendors || [],
      capabilities: sm.capabilitiesByVendor || {},
    }),
    reasons: registry.capabilityReasons(),
  };
}

module.exports = {
  buildVendorRegistryMessage: buildVendorRegistryMessage,
  recordInstallState: recordInstallState,
  installStateFor: installStateFor,
};

// session-capabilities.js - what each agent can do in this project right now,
// kept on the session manager as sm.capabilitiesByVendor.
//
// The value is always a RESOLVED set (yoke/capabilities.js): the agent's
// declaration, overlaid by a connection, narrowed by what its live session
// advertised. Every session-facing runtime decision reads it through
// capabilitiesFor and nothing else, so no site can act on a declaration the live
// agent has already withdrawn. Declarations enter only here, through
// resolveCapabilities, never read directly.

var yoke = require("./yoke");

/**
 * The vendor a session's decisions are made for: the session's own, else the
 * adapter that serves it, else the project default.
 * @param {object} sm
 * @param {?{vendor: ?string}} session
 * @param {?string} [adapterVendor]
 * @returns {?string}
 */
function effectiveVendorId(sm, session, adapterVendor) {
  return (session && session.vendor) || adapterVendor || (sm && sm.defaultVendor) || null;
}

/**
 * The resolved capabilities recorded for a vendor, as a copy. A vendor with
 * nothing recorded (or not registered) has none: every flag off, every list
 * empty, so a control gated on it stays disabled and a guard fails closed.
 * @param {object} sm
 * @param {?string} vendorId
 * @returns {object} every ledger key
 */
function capabilitiesFor(sm, vendorId) {
  var recorded = sm && sm.capabilitiesByVendor;
  var has = typeof vendorId === "string" && recorded
    && Object.prototype.hasOwnProperty.call(recorded, vendorId);
  return yoke.completeCapabilities(has ? recorded[vendorId] : {});
}

/**
 * Records the resolved capabilities of one vendor from what its live session
 * advertised (the capabilities member of init()'s result; none when the
 * adapter reported none).
 * @param {object} sm
 * @param {string} vendorId
 * @param {?object} advertised
 * @param {?object} [effectiveEnv]  the composed environment the vendor's
 *   runtime starts with; what it takes away (a provider, a gateway) narrows the
 *   declaration, with the reason kept in sm.capabilityReasonsByVendor
 * @param {boolean} [osUsers]  os-users mode: the daemon reads no settings file
 *   to complete that environment
 * @returns {object} what was recorded
 */
function recordCapabilities(sm, vendorId, advertised, effectiveEnv, osUsers) {
  sm.capabilitiesByVendor = sm.capabilitiesByVendor || {};
  sm.capabilityReasonsByVendor = sm.capabilityReasonsByVendor || {};
  var resolved;
  var reasons = {};
  if (yoke.registry.isKnown(vendorId)) {
    var descriptor = yoke.registry.get(vendorId);
    var declared = descriptor.capabilities;
    // Only the agent that reads the environment's variables declares how they
    // narrow it; any other agent is left as it declared itself.
    var narrowing = typeof descriptor.narrowCapabilities === "function"
      ? descriptor.narrowCapabilities(effectiveEnv, osUsers)
      : { overrides: {}, reasons: {} };
    var overrides = {};
    // Narrowing only: a capability the agent never declared stays as it is.
    Object.keys(narrowing.overrides).forEach(function (key) {
      if (declared[key] === true) {
        overrides[key] = narrowing.overrides[key];
        reasons[key] = narrowing.reasons[key];
      }
    });
    resolved = yoke.resolveCapabilities(
      yoke.registry.get(vendorId),
      Object.keys(overrides).length ? { capabilityOverrides: overrides } : null,
      advertised || null
    );
  } else {
    resolved = advertised || {};
  }
  sm.capabilitiesByVendor[vendorId] = resolved;
  sm.capabilityReasonsByVendor[vendorId] = reasons;
  return resolved;
}

/**
 * Gives every registered vendor an entry before any session has reported, so a
 * session on a vendor other than the project default is gated on what its own
 * agent can do. An entry already recorded from a live session is kept.
 * @param {object} sm
 */
function seedCapabilities(sm) {
  sm.capabilitiesByVendor = sm.capabilitiesByVendor || {};
  yoke.registry.list().forEach(function (vendor) {
    if (!sm.capabilitiesByVendor[vendor.id]) recordCapabilities(sm, vendor.id, null);
  });
}

module.exports = {
  effectiveVendorId: effectiveVendorId,
  capabilitiesFor: capabilitiesFor,
  recordCapabilities: recordCapabilities,
  seedCapabilities: seedCapabilities,
};

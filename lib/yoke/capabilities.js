// capabilities.js - what one agent can do right now: the yoke's declaration,
// overlaid with a connection's overrides, narrowed by what the live session
// advertises. The result is what the UI gates controls on.

var iface = require("./interface");

function intersect(a, b) {
  return a.filter(function (item) { return b.indexOf(item) !== -1; });
}

/**
 * @param {{capabilities: object}} yoke  a registered vendor descriptor; its
 *   declared capabilities are the starting point
 * @param {?{capabilityOverrides: object}} connection  optional. Overrides may
 *   widen or narrow the declaration: a connection knows which model sits
 *   behind the agent.
 * @param {?object} sessionAdvertised  optional. What the running session
 *   reports. It can only narrow: a flag it reports false turns the capability
 *   off, a list it reports restricts the entries to those it names, and a key
 *   it does not report is left as it was. Keys outside the ledger are ignored.
 * @returns {object} every ledger key, flags as booleans, lists as arrays
 */
function resolveCapabilities(yoke, connection, sessionAdvertised) {
  if (!yoke || typeof yoke !== "object") {
    throw new Error("[YOKE] resolveCapabilities needs a yoke declaration");
  }
  var out = iface.completeCapabilities(yoke.capabilities);

  var overrides = connection && connection.capabilityOverrides;
  if (overrides) {
    iface.validateCapabilities(overrides, "capabilityOverrides");
    Object.keys(overrides).forEach(function (key) {
      out[key] = iface.CAPABILITIES[key].kind === "list" ? overrides[key].slice() : overrides[key];
    });
  }

  if (sessionAdvertised) {
    iface.validateCapabilities(sessionAdvertised, "the session's advertised", { ignoreUnknown: true });
    Object.keys(sessionAdvertised).forEach(function (key) {
      if (!iface.isCapabilityKey(key)) return;
      if (iface.CAPABILITIES[key].kind === "list") out[key] = intersect(out[key], sessionAdvertised[key]);
      else out[key] = out[key] && sessionAdvertised[key];
    });
  }

  return out;
}

module.exports = { resolveCapabilities: resolveCapabilities };

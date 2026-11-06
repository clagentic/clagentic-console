// vendor-auth.js - the "not logged in" facts for one agent, read from the YOKE
// registry so the title and the login command are written once and every
// surface (chat message, notification, terminal launcher) agrees.

var registry = require("./yoke").registry;
var providerCredentials = require("./yoke/provider-credentials");

/**
 * @param {string} vendor  a registered vendor id
 * @returns {{vendor: string, displayName: string, title: string, loginCommand: string}}
 * @throws {Error} code YOKE_UNKNOWN_VENDOR when the vendor is not registered
 */
function authRequiredFacts(vendor) {
  var descriptor = registry.get(vendor);
  return {
    vendor: descriptor.id,
    displayName: descriptor.displayName,
    title: descriptor.displayName + " is not logged in.",
    loginCommand: descriptor.loginCommand,
  };
}

/**
 * When the agent talks to a cloud provider (Bedrock, Vertex, Foundry) the
 * session's environment selects, an auth-like error is that provider's
 * credentials failing, not a missing sign-in: there is no login to offer.
 * Only an agent that owns the provider's credential group is attributed to it.
 *
 * @param {string} vendor  a registered vendor id
 * @param {?object} env    the composed environment the session runs with
 * @returns {?{provider: string, label: string, message: string}}
 */
function providerAuthFailure(vendor, env) {
  if (!registry.isKnown(vendor)) return null;
  var descriptor = registry.get(vendor);
  var seen = typeof descriptor.effectiveRuntimeEnv === "function" ? descriptor.effectiveRuntimeEnv(env) : env;
  var provider = providerCredentials.configuredProvider(seen);
  if (!provider) return null;
  var groups = descriptor.credentialGroups || [];
  var owns = groups.some(function (g) { return g.id === provider; });
  if (!owns) return null;
  var label = providerCredentials.PROVIDER_LABELS[provider];
  return {
    provider: provider,
    label: label,
    message: label + " is configured for " + registry.get(vendor).displayName + " on this host, and its credentials failed. " +
      "Check them in Settings (environment) or on the host. Signing in is not the fix.",
  };
}

module.exports = { authRequiredFacts: authRequiredFacts, providerAuthFailure: providerAuthFailure };

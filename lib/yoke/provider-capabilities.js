// provider-capabilities.js - what the environment a session runs with takes
// away from an agent. A cloud provider or a gateway behind a custom base URL
// does not offer everything the first-party service does; the narrowing is read
// from the same composed environment the spawn receives, so the controls the
// session shows match what its runtime can do.
//
// Narrowing only: every override here turns a capability off. The caller
// applies one only to an agent that declares that capability.

var FIRST_PARTY_HOSTS = ["api.anthropic.com"];

function isFirstPartyBaseUrl(raw) {
  var host;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch (e) {
    // A value that is not a URL cannot be the first-party service.
    return false;
  }
  return FIRST_PARTY_HOSTS.indexOf(host) !== -1;
}

/**
 * @param {?object} env  the composed runtime environment
 * @returns {{overrides: object, reasons: object}}  capability key -> false, and
 *   key -> the one line shown beside the disabled control
 */
function capabilityNarrowing(env) {
  var overrides = {};
  var reasons = {};
  if (!env) return { overrides: overrides, reasons: reasons };

  if (env.CLAUDE_CODE_USE_BEDROCK === "1") {
    overrides.webSearch = false;
    reasons.webSearch = "Web search is not available when the agent runs on Amazon Bedrock.";
  }

  var baseUrl = env.ANTHROPIC_BASE_URL;
  if (typeof baseUrl === "string" && baseUrl !== "" && !isFirstPartyBaseUrl(baseUrl)) {
    overrides.mcpToolSearch = false;
    reasons.mcpToolSearch = "MCP tool search is off while ANTHROPIC_BASE_URL points at a gateway.";
    overrides.remoteControl = false;
    reasons.remoteControl = "Remote Control is off while ANTHROPIC_BASE_URL points at a gateway.";
  }
  return { overrides: overrides, reasons: reasons };
}

module.exports = { capabilityNarrowing: capabilityNarrowing, isFirstPartyBaseUrl: isFirstPartyBaseUrl };

// provider-credentials.js - the environment variables Claude Code reads to
// reach a cloud provider (Bedrock, Vertex, Foundry), and the rule for when a
// provider counts as configured. The same table feeds the vendor descriptor's
// owned variables, so a credential set is owned whole and never in part: a
// variable the console does not own would leak from the daemon's environment
// into a session that was meant to use its own.

var BEDROCK_ENV = [
  "CLAUDE_CODE_USE_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
];

var VERTEX_ENV = [
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

var FOUNDRY_ENV = [
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_FOUNDRY_BASE_URL",
];

/** Credential sets that must each be owned whole (see registry.register). */
var CREDENTIAL_GROUPS = [
  { id: "bedrock", envNames: BEDROCK_ENV },
  { id: "vertex", envNames: VERTEX_ENV },
  { id: "foundry", envNames: FOUNDRY_ENV },
];

function has(env, name) {
  return typeof env[name] === "string" && env[name] !== "";
}

/**
 * Which cloud provider is selected AND carries a complete credential source,
 * or null. A provider switched on with an incomplete set (an access key id
 * without its secret, a project without credentials) is not authenticated: the
 * caller falls through to the normal login probe.
 * @param {object} env  process.env-shaped
 * @returns {?string} "bedrock" | "vertex" | "foundry" | null
 */
function completeProvider(env) {
  if (env.CLAUDE_CODE_USE_BEDROCK === "1"
      && (has(env, "AWS_BEARER_TOKEN_BEDROCK")
          || has(env, "AWS_PROFILE")
          || (has(env, "AWS_ACCESS_KEY_ID") && has(env, "AWS_SECRET_ACCESS_KEY")))) {
    return "bedrock";
  }
  if (env.CLAUDE_CODE_USE_VERTEX === "1"
      && has(env, "ANTHROPIC_VERTEX_PROJECT_ID")
      && has(env, "GOOGLE_APPLICATION_CREDENTIALS")) {
    return "vertex";
  }
  if (env.CLAUDE_CODE_USE_FOUNDRY === "1"
      && has(env, "ANTHROPIC_FOUNDRY_API_KEY")
      && (has(env, "ANTHROPIC_FOUNDRY_RESOURCE") || has(env, "ANTHROPIC_FOUNDRY_BASE_URL"))) {
    return "foundry";
  }
  return null;
}

/** Every variable in every credential group, without repeats. */
function allCredentialEnvNames() {
  var names = [];
  CREDENTIAL_GROUPS.forEach(function (group) {
    group.envNames.forEach(function (n) { if (names.indexOf(n) === -1) names.push(n); });
  });
  return names;
}

module.exports = {
  CREDENTIAL_GROUPS: CREDENTIAL_GROUPS,
  completeProvider: completeProvider,
  allCredentialEnvNames: allCredentialEnvNames,
};

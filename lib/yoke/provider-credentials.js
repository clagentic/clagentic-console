// provider-credentials.js - the cloud providers Claude Code can reach
// (Bedrock, Vertex, Foundry): the namespaces of environment variables each one
// reads, and the rule for when a provider counts as configured. The namespaces
// feed the vendor descriptor's owned prefixes, so a credential set is owned
// whole by namespace and an unlisted variable (AWS_ROLE_ARN, AWS_CA_BUNDLE,
// GOOGLE_CLOUD_PROJECT) is owned the same as a listed one.

var envOwnership = require("./env-ownership");

/**
 * Credential sets that must each be owned whole (see registry.register). A
 * group owns every variable under its prefixes plus its exact names.
 */
var CREDENTIAL_GROUPS = [
  { id: "bedrock", prefixes: ["AWS_"], envNames: ["CLAUDE_CODE_USE_BEDROCK"] },
  {
    id: "vertex",
    prefixes: ["GOOGLE_", "GCLOUD_", "CLOUDSDK_", "CLOUD_ML_", "ANTHROPIC_VERTEX_"],
    envNames: ["CLAUDE_CODE_USE_VERTEX"],
  },
  { id: "foundry", prefixes: ["ANTHROPIC_FOUNDRY_"], envNames: ["CLAUDE_CODE_USE_FOUNDRY"] },
];

/**
 * The one matcher: which credential group owns a variable name, or null.
 * Owned-name resolution, the registry's whole-group check and every env cleanup
 * go through this or through env-ownership.owns, never a name list.
 * @param {string} name
 * @returns {?string} the group id
 */
function groupOf(name) {
  for (var i = 0; i < CREDENTIAL_GROUPS.length; i++) {
    var group = CREDENTIAL_GROUPS[i];
    if (envOwnership.owns({ names: group.envNames, prefixes: group.prefixes }, name)) return group.id;
  }
  return null;
}

/** Every namespace prefix of every group, without repeats. */
function allCredentialPrefixes() {
  var out = [];
  CREDENTIAL_GROUPS.forEach(function (group) {
    group.prefixes.forEach(function (p) { if (out.indexOf(p) === -1) out.push(p); });
  });
  return out;
}

/** Every exact name of every group, without repeats. */
function allCredentialNames() {
  var out = [];
  CREDENTIAL_GROUPS.forEach(function (group) {
    group.envNames.forEach(function (n) { if (out.indexOf(n) === -1) out.push(n); });
  });
  return out;
}

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
          || (has(env, "AWS_ACCESS_KEY_ID") && has(env, "AWS_SECRET_ACCESS_KEY"))
          || (has(env, "AWS_ROLE_ARN") && has(env, "AWS_WEB_IDENTITY_TOKEN_FILE")))) {
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

module.exports = {
  CREDENTIAL_GROUPS: CREDENTIAL_GROUPS,
  groupOf: groupOf,
  completeProvider: completeProvider,
  allCredentialPrefixes: allCredentialPrefixes,
  allCredentialNames: allCredentialNames,
};

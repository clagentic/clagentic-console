// Registers the Claude Code vendor with the YOKE registry.
//
// Kept apart from claude.js on purpose: that module does work when it is first
// loaded (it opens up the package directory for OS-user workers), so merely
// asking the registry which agents exist must not load it. The adapter module is
// required only when an adapter is actually created.

var registry = require("../registry");
var authChecks = require("../auth-checks");
var providerCredentials = require("../provider-credentials");
var claudeSettingsEnv = require("../../claude-settings-env");
var claudeCapabilities = require("./claude-capabilities").claudeCapabilities;

// The provider variables are Claude Code's, read after its settings file's env
// block is applied; so the classification is declared here, by the agent that
// reads them.
// osUsers: the daemon reads no settings file for another account's session.
function effectiveRuntimeEnv(env, osUsers) {
  return claudeSettingsEnv.applyUserSettingsEnv(env || {}, { osUsers: !!osUsers });
}

registry.register({
  id: "claude",
  displayName: "Claude Code",
  icon: "/claude-code-avatar.png",
  priority: 10,
  binaryNames: ["claude"],
  probeInstalled: function(ctx) { return ctx.lookupBinary("claude"); },
  checkAuth: authChecks.checkClaudeAuth,
  effectiveRuntimeEnv: effectiveRuntimeEnv,
  installHint: "Install Claude Code (npm install -g @anthropic-ai/claude-code), then sign in.",
  loginCommand: "claude auth login",
  // The login prints a sign-in URL and then asks for the code the sign-in
  // page shows.
  loginPatterns: {
    url: "https:\\/\\/[^\\s'\"\\]>)}{]+",
    codePrompt: "[Pp]aste code here",
  },
  osUsersSupported: true,
  needsRuntimeEnv: false,
  perProjectRuntime: false,
  activityTokens: false,
  ownedEnvNames: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].concat(providerCredentials.allCredentialNames()),
  ownedEnvPrefixes: providerCredentials.allCredentialPrefixes(),
  credentialGroups: providerCredentials.CREDENTIAL_GROUPS,
  nativeInstructionFiles: ["CLAUDE.md"],
  interruptMessage: "Interrupted · What should Claude do instead?",
  capabilities: claudeCapabilities(),
  createAdapter: function(opts) { return require("./claude").createClaudeAdapter(opts); },
});

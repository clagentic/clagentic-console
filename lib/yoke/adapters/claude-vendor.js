// Registers the Claude Code vendor with the YOKE registry.
//
// Kept apart from claude.js on purpose: that module does work when it is first
// loaded (it opens up the package directory for OS-user workers), so merely
// asking the registry which agents exist must not load it. The adapter module is
// required only when an adapter is actually created.

var registry = require("../registry");
var authChecks = require("../auth-checks");
var claudeCapabilities = require("./claude-capabilities").claudeCapabilities;

registry.register({
  id: "claude",
  displayName: "Claude Code",
  icon: "/claude-code-avatar.png",
  priority: 10,
  binaryNames: ["claude"],
  probeInstalled: function(ctx) { return ctx.lookupBinary("claude"); },
  checkAuth: authChecks.checkClaudeAuth,
  installHint: "Install Claude Code (npm install -g @anthropic-ai/claude-code), then sign in.",
  loginCommand: "claude login",
  osUsersSupported: true,
  needsRuntimeEnv: false,
  ownedEnvNames: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_PROFILE",
    "AWS_SESSION_TOKEN",
  ],
  nativeInstructionFiles: ["CLAUDE.md"],
  interruptMessage: "Interrupted · What should Claude do instead?",
  capabilities: claudeCapabilities(),
  createAdapter: function(opts) { return require("./claude").createClaudeAdapter(opts); },
});

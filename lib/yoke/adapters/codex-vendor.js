// Registers the Codex vendor with the YOKE registry. Kept apart from codex.js so
// that asking the registry which agents exist does not load the adapter; it is
// required only when an adapter is actually created.

var registry = require("../registry");
var authChecks = require("../auth-checks");
var codexBinary = require("../codex-binary");
var codexCapabilities = require("./codex-capabilities").codexCapabilities;

// The console ships no Codex: the agent is installed when the user's own Codex
// resolves and is new enough. When it does not, the picker shows the reason
// (not installed, too old, an override that points nowhere) and, when one is
// usable, which binary and version will run.
function probeCodexInstalled() {
  return codexBinary.describe(codexBinary.resolveCached());
}

registry.register({
  id: "codex",
  displayName: "Codex",
  icon: "/codex-avatar.png",
  priority: 20,
  binaryNames: ["codex"],
  probeInstalled: probeCodexInstalled,
  recheck: codexBinary.invalidate,
  checkAuth: authChecks.checkCodexAuth,
  installHint: "Install the Codex CLI (npm install -g @openai/codex), then sign in.",
  loginCommand: "codex login --device-auth",
  // The app-server is not started per OS user, so under per-user isolation the
  // agent is disabled (yoke/index.js, install-probe.js) and never started.
  osUsersSupported: false,
  needsRuntimeEnv: true,
  perProjectRuntime: true,
  activityTokens: true,
  ownedEnvNames: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  credentialGroups: [{ id: "openai-endpoint", envNames: ["OPENAI_API_KEY", "OPENAI_BASE_URL"] }],
  nativeInstructionFiles: ["AGENTS.md"],
  interruptMessage: "■ Conversation interrupted - tell the model what to do differently.",
  // Rewinding a Codex thread in place is not offered yet.
  capabilityReasons: {
    rewind: "Rewind is not available for Codex sessions yet",
    rollback: "Rewind is not available for Codex sessions yet",
  },
  capabilities: codexCapabilities(),
  createAdapter: function(opts) { return require("./codex").createCodexAdapter(opts); },
});

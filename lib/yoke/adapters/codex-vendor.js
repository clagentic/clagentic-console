// Registers the Codex vendor with the YOKE registry. Kept apart from codex.js so
// that asking the registry which agents exist does not load the adapter; it is
// required only when an adapter is actually created.

var fs = require("fs");
var registry = require("../registry");
var authChecks = require("../auth-checks");
var codexCapabilities = require("./codex-capabilities").codexCapabilities;

// A bundled app-server binary counts as installed even when no `codex`
// executable is on PATH.
function probeCodexInstalled(ctx) {
  try {
    var bundled = require("../codex-app-server").findCodexPath();
    if (bundled && fs.existsSync(bundled)) return true;
  } catch (e) {
    // No bundled binary: fall through to the PATH lookup.
  }
  return ctx.lookupBinary("codex");
}

registry.register({
  id: "codex",
  displayName: "Codex",
  icon: "/codex-avatar.png",
  priority: 20,
  binaryNames: ["codex"],
  probeInstalled: probeCodexInstalled,
  checkAuth: authChecks.checkCodexAuth,
  installHint: "Install the Codex CLI (npm install -g @openai/codex), then sign in.",
  loginCommand: "codex login --device-auth",
  osUsersSupported: false,
  needsRuntimeEnv: true,
  ownedEnvNames: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  nativeInstructionFiles: ["AGENTS.md"],
  interruptMessage: "■ Conversation interrupted - tell the model what to do differently.",
  capabilities: codexCapabilities(),
  createAdapter: function(opts) { return require("./codex").createCodexAdapter(opts); },
});

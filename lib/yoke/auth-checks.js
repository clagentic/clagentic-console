// auth-checks.js - per-agent "is a login in place" probes. Each registered
// vendor points at one of these through its descriptor's checkAuth.

var fs = require("fs");
var execSync = require("child_process").execSync;
var execFileSync = require("child_process").execFileSync;
var installProbe = require("./install-probe");

function parseClaudeAuthStatusJson(out) {
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch (e) {
    return null;
  }
}

function isClaudeLoggedInText(out) {
  if (!out) return false;
  var text = String(out).toLowerCase();
  if (text.indexOf("not logged in") !== -1) return false;
  if (text.indexOf("login method:") !== -1) return true;
  if (text.indexOf("logged in") !== -1) return true;
  return false;
}

function hasThirdPartyProviderAuth() {
  // Claude Code supports third-party providers via env vars. When these are set,
  // `claude auth status` reports "not logged in" because there is no OAuth session,
  // but Claude Code itself authenticates directly through the provider.
  var env = process.env;
  if (env.CLAUDE_CODE_USE_BEDROCK === "1"
      && (env.AWS_BEARER_TOKEN_BEDROCK
          || env.AWS_ACCESS_KEY_ID
          || env.AWS_PROFILE
          || env.AWS_SESSION_TOKEN)) {
    return "bedrock";
  }
  if (env.CLAUDE_CODE_USE_VERTEX === "1") return "vertex";
  if (env.ANTHROPIC_API_KEY) return "api_key";
  if (env.ANTHROPIC_AUTH_TOKEN) return "auth_token";
  return null;
}

function checkClaudeAuth() {
  var provider = hasThirdPartyProviderAuth();
  if (provider) {
    console.log("[yoke] Claude auth via third-party provider: " + provider);
    return true;
  }

  try {
    var out = execSync("claude auth status --json", { timeout: 5000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    var parsed = parseClaudeAuthStatusJson(out);
    if (parsed) return !!parsed.loggedIn;
    console.warn("[yoke] Claude auth status JSON parse failed; falling back to text output");
  } catch (e) {
    var stdout = e && e.stdout ? String(e.stdout) : "";
    if (stdout) {
      var parsedFallback = parseClaudeAuthStatusJson(stdout);
      if (parsedFallback) return !!parsedFallback.loggedIn;
    }
    console.warn("[yoke] Claude auth status JSON check failed; falling back to text output:", e.message);
  }

  try {
    var textOut = execSync("claude auth status --text", { timeout: 5000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return isClaudeLoggedInText(textOut);
  } catch (e) {
    return false;
  }
}

function resolveCodexBinary() {
  var findCodexPath = require("./codex-app-server").findCodexPath;

  try {
    var codexBin = findCodexPath();
    if (codexBin && fs.existsSync(codexBin)) return codexBin;
  } catch (e) {}

  return installProbe.findBinaryPath("codex") || null;
}

function checkCodexAuth() {
  try {
    var codexBin = resolveCodexBinary();
    if (!codexBin) return false;
    execFileSync(codexBin, ["login", "status"], { timeout: 5000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  checkClaudeAuth: checkClaudeAuth,
  checkCodexAuth: checkCodexAuth,
};

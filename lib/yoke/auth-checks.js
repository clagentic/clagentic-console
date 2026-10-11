// auth-checks.js - per-agent "is a login in place" probes. Each registered
// vendor points at one of these through its descriptor's checkAuth.

var fs = require("fs");
var execSync = require("child_process").execSync;
var execFileSync = require("child_process").execFileSync;
var installProbe = require("./install-probe");
var providerCredentials = require("./provider-credentials");

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

function hasThirdPartyProviderAuth(env) {
  // Claude Code supports third-party providers via env vars. When these are set,
  // `claude auth status` reports "not logged in" because there is no OAuth session,
  // but Claude Code itself authenticates directly through the provider.
  env = env || process.env;
  var cloud = providerCredentials.completeProvider(env);
  if (cloud) return cloud;
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
  var appServer = require("./codex-app-server");

  try {
    var codexBin = appServer.findCodexPath();
    if (codexBin && fs.existsSync(codexBin)) return codexBin;
  } catch (e) {
    if (!appServer.isBundleAbsent(e)) throw e;
  }

  return installProbe.findBinaryPath("codex") || null;
}

function checkCodexAuth() {
  var codexBin;
  try {
    codexBin = resolveCodexBinary();
  } catch (e) {
    // Not an absent bundle (that falls back to PATH): a defect worth seeing.
    console.error("[yoke] Codex binary lookup failed:", e && e.message ? e.message : e);
    return false;
  }
  if (!codexBin) return false;
  try {
    execFileSync(codexBin, ["login", "status"], { timeout: 5000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  hasThirdPartyProviderAuth: hasThirdPartyProviderAuth,
  checkClaudeAuth: checkClaudeAuth,
  checkCodexAuth: checkCodexAuth,
};

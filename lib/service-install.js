// service-install.js — pure helpers for scripts/postinstall.js (systemd unit
// install). Kept free of side effects so each decision can be tested without
// touching /etc/systemd or /usr/local/bin.

var path = require("path");

var BIN_NAME = "clagentic-console";
var LEGACY_WRAPPER_PATH = "/usr/local/bin/clagentic-daemon.sh";

// Exact text of the hand-placed wrapper that earlier releases told operators to
// create. It is removed only when the file matches this byte for byte (modulo
// line endings and trailing whitespace); an operator-modified copy is theirs.
var LEGACY_WRAPPER_CONTENT = [
  "#!/bin/bash",
  "# Run Clagentic Console daemon directly so systemd can track the process",
  "# Prefer global npm install, fall back to npx cache",
  "",
  "# Safety: refuse to start if a workspace symlink exists at the unscoped package name.",
  "# npm link / npm install -g <workspace-path> creates exactly this trap — workspace edits",
  "# become live in the daemon without going through pack/install. If this fires, remove the",
  "# symlink with: rm /usr/lib/node_modules/clagentic-console",
  "SYMLINK_TRAP=\"/usr/lib/node_modules/clagentic-console\"",
  "if [ -L \"$SYMLINK_TRAP\" ]; then",
  "  echo \"ERROR: $SYMLINK_TRAP is a symlink (npm link trap). Remove it before starting:\" >&2",
  "  echo \"  rm $SYMLINK_TRAP\" >&2",
  "  echo \"Then reinstall via: npm pack --pack-destination /tmp/ && npm install -g /tmp/clagentic-console-*.tgz\" >&2",
  "  exit 1",
  "fi",
  "",
  "DAEMON_LIB=\"/usr/lib/node_modules/@clagentic/console/lib/daemon.js\"",
  "if [ ! -f \"$DAEMON_LIB\" ]; then",
  "  DAEMON_LIB=$(node -e \"console.log(require.resolve('@clagentic/console/lib/daemon'))\" 2>/dev/null || \\",
  "               ls /root/.npm/_npx/*/node_modules/@clagentic/console/lib/daemon.js 2>/dev/null | tail -1)",
  "fi",
  "exec /usr/bin/node \"$DAEMON_LIB\"",
].join("\n");

function normalize(text) {
  return String(text).replace(/\r\n/g, "\n").split("\n").map(function (l) { return l.replace(/[ \t]+$/, ""); }).join("\n").replace(/\n+$/, "");
}

function isLegacyWrapperContent(content) {
  return normalize(content) === normalize(LEGACY_WRAPPER_CONTENT);
}

/**
 * npm exposes its config to lifecycle scripts as npm_config_* variables.
 * `npm install -g` sets npm_config_global=true (and npm_config_location=global
 * on npm 8+); a local `npm ci` / `npm install` sets neither.
 */
function isGlobalInstall(env) {
  return env.npm_config_global === "true" || env.npm_config_location === "global";
}

/**
 * Absolute path of the globally installed bin symlink, or null when it cannot
 * be determined. Prefers npm's own prefix; otherwise derives it from the
 * package location <prefix>/lib/node_modules/@clagentic/console.
 */
function resolveCliBin(opts) {
  var prefix = opts.env.npm_config_prefix;
  if (!prefix || !path.isAbsolute(prefix)) {
    var scopeDir = path.dirname(opts.pkgDir);
    if (path.basename(scopeDir) !== "@clagentic") return null;
    var modulesDir = path.dirname(scopeDir);
    if (path.basename(modulesDir) !== "node_modules") return null;
    prefix = path.dirname(path.dirname(modulesDir));
  }
  return path.join(prefix, "bin", BIN_NAME);
}

var BIN_PLACEHOLDER = "@CLAGENTIC_CONSOLE_BIN@";
var BIN_DIR_PLACEHOLDER = "@CLAGENTIC_CONSOLE_BIN_DIR@";

/**
 * Fill the shipped unit template. Throws if a placeholder is left behind, so a
 * half-rendered unit is never written to /etc/systemd.
 */
function renderUnit(template, cliBin) {
  var out = template
    .split(BIN_PLACEHOLDER).join(cliBin)
    .split(BIN_DIR_PLACEHOLDER).join(path.dirname(cliBin));
  var left = out.match(/@CLAGENTIC_CONSOLE_[A-Z_]+@/);
  if (left) throw new Error("unit template has unfilled placeholder " + left[0]);
  return out;
}

module.exports = {
  BIN_NAME: BIN_NAME,
  LEGACY_WRAPPER_PATH: LEGACY_WRAPPER_PATH,
  LEGACY_WRAPPER_CONTENT: LEGACY_WRAPPER_CONTENT,
  isLegacyWrapperContent: isLegacyWrapperContent,
  isGlobalInstall: isGlobalInstall,
  resolveCliBin: resolveCliBin,
  renderUnit: renderUnit,
};

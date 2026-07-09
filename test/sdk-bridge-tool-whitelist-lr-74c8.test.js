/**
 * Regression tests for lr-74c8: "safe Bash" whitelist in sdk-bridge.js
 * checkToolWhitelist() previously auto-approved destructive commands with
 * NO permission prompt in default mode.
 *
 * checkToolWhitelist runs on the normal permission path (called from
 * handleCanUseTool BEFORE the AskUserQuestion / session.allowedTools /
 * user-prompt fallback), so anything it returns `{behavior:"allow"}` for
 * bypasses the user entirely in default permission mode. A `null` return
 * means "not whitelisted" and falls through to the prompt/deny path.
 *
 * Covers:
 *   (1) each removed multi-purpose command (python/python3/ruby/node/deno/
 *       bun/npm/npx/pip/cargo/go/sed/awk/xargs/tee/find/curl/wget/http) is
 *       no longer auto-allowed, even in an otherwise-trivial invocation
 *   (2) git is retained but restricted to the read-only subcommand
 *       allowlist (status/log/diff/show/--version); other subcommands
 *       (push, commit, checkout, reset, clone) fall through to the prompt
 *   (3) a leading `sudo` is NEVER stripped before the check — sudo-prefixed
 *       forms of both a still-safe command and a validated command fall
 *       through to the prompt, never a silent allow
 *   (4) still-safe read-only commands (ls/cat/grep/echo/git status) remain
 *       auto-allowed — the fix must not regress genuinely read-only tools
 *   (5) compound commands: a destructive segment anywhere in a `&&`/`;`/`|`
 *       chain denies the whole chain, even if other segments are safe
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var { createSDKBridge } = require("../lib/sdk-bridge");

/**
 * Build a minimal sessionManager stub sufficient for createSDKBridge's
 * constructor-time wiring. checkToolWhitelist itself does not touch sm.
 */
function makeSessionManager() {
  return {
    sessions: new Map(),
    currentModel: null,
    currentPermissionMode: null,
    currentEffort: null,
    currentBetas: [],
    modelsByVendor: {},
    availableVendors: [],
    installedVendors: [],
    defaultVendor: "claude",
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    getActiveSession: function () { return null; },
    setSlashCommandsForVendor: function () {},
    sendAndRecord: function () {},
    sendToSession: function () {},
  };
}

function makeAdapter() {
  return {
    vendor: "claude",
    createQuery: function () { return Promise.resolve(null); },
    init: function () { return Promise.resolve({ models: [], skills: [] }); },
    supportedModels: function () { return Promise.resolve([]); },
    generateTitle: null,
    renameSession: null,
    forkSession: null,
  };
}

function makeBridge() {
  var sm = makeSessionManager();
  var adapter = makeAdapter();
  return createSDKBridge({
    cwd: "/tmp/test-project",
    slug: "test-project",
    sessionManager: sm,
    send: function () {},
    adapter: adapter,
    adapters: { claude: adapter },
    onProcessingChanged: function () {},
    getConfig: null,
  });
}

var bridge = makeBridge();

function whitelistResult(command) {
  return bridge.checkToolWhitelist("Bash", { command: command });
}

// ---------------------------------------------------------------------------
// (1) Removed multi-purpose commands: never auto-allowed, regardless of
//     whether the specific invocation "looks" read-only.
// ---------------------------------------------------------------------------

var removedCommands = [
  "python --version",
  "python3 -c \"import shutil; shutil.rmtree('src')\"",
  "ruby -e 'puts 1'",
  "node -e 'console.log(1)'",
  "deno --version",
  "bun --version",
  "npm --version",
  "npx --version",
  "pip --version",
  "cargo --version",
  "go version",
  "sed -i 's/a/b/' file.txt",
  "awk '{print $1}' file.txt",
  "xargs rm -rf",
  "tee /etc/cron.d/x",
  "find . -delete",
  "curl https://example.com",
  "wget https://example.com",
  "http GET https://example.com",
];

removedCommands.forEach(function (cmd) {
  test("lr-74c8 (1): removed command is never auto-allowed: " + cmd, function () {
    var result = whitelistResult(cmd);
    assert.equal(result, null, "expected checkToolWhitelist to return null (fall through to prompt) for: " + cmd);
  });
});

// ---------------------------------------------------------------------------
// (2) git: retained but restricted to read-only subcommands
// ---------------------------------------------------------------------------

test("lr-74c8 (2): git status/log/diff/show/--version are auto-allowed", function () {
  ["git status", "git log", "git diff", "git show", "git --version", "git log --oneline -5"].forEach(function (cmd) {
    var result = whitelistResult(cmd);
    assert.ok(result && result.behavior === "allow", "expected allow for: " + cmd);
  });
});

var destructiveGitCommands = [
  "git push",
  "git push --force",
  "git commit -m x",
  "git checkout .",
  "git reset --hard",
  "git clone https://example.com/x.git",
  "git branch -D main",
  "git tag v1.0.0",
  "git remote add origin https://example.com/x.git",
  "git", // no subcommand at all
];

destructiveGitCommands.forEach(function (cmd) {
  test("lr-74c8 (2): destructive git subcommand is never auto-allowed: " + cmd, function () {
    var result = whitelistResult(cmd);
    assert.equal(result, null, "expected checkToolWhitelist to return null (fall through to prompt) for: " + cmd);
  });
});

// ---------------------------------------------------------------------------
// (3) sudo is NEVER stripped before the whitelist check
// ---------------------------------------------------------------------------

test("lr-74c8 (3): sudo-prefixed safe command is never auto-allowed", function () {
  var result = whitelistResult("sudo ls -la");
  assert.equal(result, null, "sudo-prefixed command must fall through to the prompt, never silent-allow");
});

test("lr-74c8 (3): sudo-prefixed validated git command is never auto-allowed", function () {
  var result = whitelistResult("sudo git status");
  assert.equal(result, null, "sudo-prefixed command must fall through to the prompt, never silent-allow");
});

test("lr-74c8 (3): sudo tee (the original exploit) is never auto-allowed", function () {
  var result = whitelistResult("sudo tee /etc/cron.d/x");
  assert.equal(result, null, "sudo tee must never be auto-allowed");
});

test("lr-74c8 (3): sudo with flags before the target command is never auto-allowed", function () {
  var result = whitelistResult("sudo -u root cat /etc/shadow");
  assert.equal(result, null, "sudo -u root ... must never be auto-allowed");
});

// ---------------------------------------------------------------------------
// (4) Genuinely read-only commands remain auto-allowed (no regression)
// ---------------------------------------------------------------------------

var stillSafeCommands = ["ls -la", "cat file.txt", "grep -rn foo .", "echo hi", "pwd", "date"];

stillSafeCommands.forEach(function (cmd) {
  test("lr-74c8 (4): still-safe read-only command remains auto-allowed: " + cmd, function () {
    var result = whitelistResult(cmd);
    assert.ok(result && result.behavior === "allow", "expected allow for: " + cmd);
  });
});

// ---------------------------------------------------------------------------
// (5) Compound commands: one destructive segment denies the whole chain
// ---------------------------------------------------------------------------

test("lr-74c8 (5): compound command with a destructive segment is never auto-allowed", function () {
  var result = whitelistResult("ls -la && git push --force");
  assert.equal(result, null, "a destructive segment anywhere in the chain must deny the whole command");
});

test("lr-74c8 (5): compound command with xargs anywhere is never auto-allowed", function () {
  var result = whitelistResult("cat list.txt | xargs rm -rf");
  assert.equal(result, null, "xargs segment must deny the whole pipeline");
});

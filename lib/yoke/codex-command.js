"use strict";

// codex-command.js - the one place a Codex binary is started from. On Windows
// the npm install leaves a .cmd or .bat shim, and a batch file cannot be run by
// execFile, execFileSync or spawn without the command interpreter. A native
// codex.exe is run directly; a shim is run through the interpreter
// (ComSpec /d /s /c) with every part of the command line quoted for it. The
// version check and the app-server start both go through here, so a shim that
// passes the one runs under the other.

var childProcess = require("child_process");

var SHIM_RE = /\.(cmd|bat)$/i;
var CMD_META_RE = /([()\][%!^"`<>&|;, *?])/g;
var FALLBACK_INTERPRETER = "cmd.exe";

function isShim(binary, platform) {
  return platform === "win32" && SHIM_RE.test(String(binary));
}

// One argument as cmd.exe will hand it to a batch file: quoted for the program
// (backslashes before a quote doubled, the quote escaped), then every character
// the interpreter treats specially escaped with ^. A shim re-reads its command
// line once more, so the escape is applied twice.
function quoteForShim(arg) {
  var text = String(arg);
  if (/[\0\r\n]/.test(text)) {
    throw new Error("[YOKE] a command line argument for a Windows shim cannot hold a line break or NUL");
  }
  text = text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  text = '"' + text + '"';
  return text.replace(CMD_META_RE, "^$1").replace(CMD_META_RE, "^$1");
}

function quoteCommandForShim(binary) {
  var text = String(binary);
  if (/[\0\r\n"]/.test(text)) {
    throw new Error("[YOKE] the path of a Windows shim cannot hold a quote, line break or NUL");
  }
  return text.replace(CMD_META_RE, "^$1");
}

/**
 * What to run so that `binary args...` starts, on a given platform.
 * @param {string} binary
 * @param {string[]} args
 * @param {{platform: ?string, comSpec: ?string}} [opts]
 * @returns {{file: string, args: string[], verbatim: boolean}}
 */
function invocationFor(binary, args, opts) {
  var o = opts || {};
  var platform = o.platform || process.platform;
  var list = args || [];
  if (!isShim(binary, platform)) return { file: binary, args: list.slice(), verbatim: false };
  var line = [quoteCommandForShim(binary)].concat(list.map(quoteForShim)).join(" ");
  var interpreter = o.comSpec || process.env.ComSpec || FALLBACK_INTERPRETER;
  return { file: interpreter, args: ["/d", "/s", "/c", '"' + line + '"'], verbatim: true };
}

function withVerbatim(options, invocation) {
  if (!invocation.verbatim) return options;
  return Object.assign({}, options, { windowsVerbatimArguments: true });
}

/**
 * execFileSync for a Codex binary. deps: { platform, comSpec, execFileSync }
 * are for tests; callers pass none.
 */
function execCodexSync(binary, args, options, deps) {
  var d = deps || {};
  var run = d.execFileSync || childProcess.execFileSync;
  var inv = invocationFor(binary, args, d);
  return run(inv.file, inv.args, withVerbatim(options, inv));
}

/** spawn for a Codex binary; deps as for execCodexSync, with spawn. */
function spawnCodex(binary, args, options, deps) {
  var d = deps || {};
  var start = d.spawn || childProcess.spawn;
  var inv = invocationFor(binary, args, d);
  return start(inv.file, inv.args, withVerbatim(options, inv));
}

module.exports = {
  isShim: isShim,
  invocationFor: invocationFor,
  execCodexSync: execCodexSync,
  spawnCodex: spawnCodex,
};

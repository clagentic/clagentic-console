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
// the interpreter treats specially escaped with ^, in two passes.
//
// Why two passes is right for `cmd.exe /d /s /c "<shim> <args>"`. The command
// interpreter parses the line twice before the program sees it: once for the
// /c string, which removes one layer of carets and hands the rest to the batch
// file as its arguments, and once more when the shim's own last line forwards
// them with %*, which removes the next layer. One pass would survive the first
// parse as live, unescaped text, and the quotes that program-level quoting
// puts around the argument would then toggle quoting inside the batch file's
// parse; a `\"` in the argument ends that quoting early, leaving an & or | next
// to it outside any quote. Two passes keep every quote and operator escaped
// through both parses, and the C runtime's argv rules (backslashes before a
// quote) then apply to the text left over. CMD_META_RE is this code's chosen
// set: a superset of the characters the cmd page names as needing ^
// (& | ( ) < > ^), which also escapes % ! ; , space, the quote, and wildcard
// and bracket characters. = + ' { } ~ are left unescaped because every
// argument is wrapped in quotes, so the arguments of a codex invocation
// (--config key=value) arrive unchanged.
//
// References (Microsoft Learn):
//   https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd
//     (with /s and /c, the first and last quotes are stripped; special
//     characters are escaped with ^ or quotation marks)
//   https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/call
//     (%* "refers to all the arguments")
//   https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments
//     (2n backslashes before a quote give n backslashes and the quote
//     delimits; 2n+1 give n backslashes and a literal quote; the caret is not
//     an escape for argv)
// The second parse of %* inside a .cmd file is NOT documented by Microsoft.
// The two-pass escaping rests on the general multi-pass model in Raymond Chen,
// https://devblogs.microsoft.com/oldnewthing/20091029-00/?p=16213, as an
// assumption. test/cmd-exe-parse-harness.js models that assumption and checks
// the round trip for every special character. A run on a real Windows host is
// still owed.
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

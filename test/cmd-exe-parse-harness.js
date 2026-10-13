"use strict";
// An emulation of how Windows hands a command line, run as
//   cmd.exe /d /s /c "<line>"
// to a .cmd shim whose last line forwards its arguments with %*, down to the
// argv the program at the end receives. It exists so the escaping in
// lib/yoke/codex-command.js can be checked for a round trip (the value the
// program receives equals the input) on a host without Windows. Shared helper,
// not a test file: the runner only collects test/*.test.js.
//
// SOURCES. The rules below are the ones Microsoft documents:
//   - cmd (Microsoft Learn, windows-server/administration/windows-commands/cmd):
//     with /s, the first and the last quote of the string after /c are removed
//     and the rest runs as typed; a caret (^) escapes the character after it;
//     a quoted region keeps its special characters literal; the special
//     characters are & ( ) [ ] { } ^ = ; ! ' + , ` ~ and white space, plus the
//     redirection and pipe characters < > |.
//   - Batch parameters (the same site, "call" and batch-file reference): %*
//     stands for all the arguments of the batch file, as typed.
//   - Parsing C command-line arguments (Microsoft Learn, cpp/c-language): the
//     rules that turn the final command line into argv.
// What those pages do not spell out, and this file therefore ASSUMES (the
// Windows real run is the check on it): the batch file's arguments are the
// text left after the /c line's own parse, and the line inside the batch file
// that expands %* parses that text a second time; text substituted for %* is
// not scanned for %name% again. Delayed expansion (!name!) is off, its default.
//
// This is a model, not cmd.exe. It reports an unescaped & | < > ( ) as an
// operator (that is command injection or redirection) instead of running it.

var OPERATORS = "&|<>()";

function lookup(env, name) {
  var keys = Object.keys(env || {});
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === name.toLowerCase()) return env[keys[i]];
  }
  return undefined;
}

// %name% in a command line (not a batch file): replaced when the variable is
// defined, left as typed when it is not.
function expandPercent(text, env) {
  var out = "";
  var i = 0;
  while (i < text.length) {
    if (text[i] !== "%") { out += text[i++]; continue; }
    var close = text.indexOf("%", i + 1);
    var value = close === -1 ? undefined : lookup(env, text.slice(i + 1, close));
    if (value === undefined) { out += "%"; i++; continue; }
    out += value;
    i = close + 1;
  }
  return out;
}

/**
 * One cmd parse: carets removed (the next character kept literally), quotes
 * kept and toggling a quoted region in which everything is literal.
 * @returns {{text: string, operators: string[]}}
 */
function cmdLayer(text, opts) {
  var o = opts || {};
  var source = o.percent ? expandPercent(text, o.env) : text;
  var out = "";
  var operators = [];
  var quoted = false;
  for (var i = 0; i < source.length; i++) {
    var c = source[i];
    if (!quoted && c === "^") {
      if (i + 1 < source.length) out += source[++i];
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && OPERATORS.indexOf(c) !== -1) operators.push(c);
    out += c;
  }
  return { text: out, operators: operators };
}

/**
 * argv as the C runtime builds it (Parsing C command-line arguments): white
 * space outside quotes separates arguments; 2n backslashes before a quote
 * become n backslashes and the quote toggles; 2n+1 become n backslashes and a
 * literal quote; backslashes elsewhere are literal.
 */
function parseArgv(text) {
  var argv = [];
  var current = "";
  var inToken = false;
  var quoted = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (c === "\\") {
      var run = 0;
      while (text[i] === "\\") { run++; i++; }
      if (text[i] === '"') {
        current += "\\".repeat(Math.floor(run / 2));
        if (run % 2 === 1) current += '"';
        else quoted = !quoted;
      } else {
        current += "\\".repeat(run);
        i--;
      }
      inToken = true;
    } else if (c === '"') {
      quoted = !quoted;
      inToken = true;
    } else if (!quoted && (c === " " || c === "\t")) {
      if (inToken) { argv.push(current); current = ""; inToken = false; }
    } else {
      current += c;
      inToken = true;
    }
  }
  if (inToken) argv.push(current);
  return argv;
}

/**
 * What a program behind a .cmd shim receives for the command line the console
 * builds.
 * @param {{file: string, args: string[]}} invocation  from invocationFor()
 * @param {string} shimPath  the shim's own path, which must hold nothing the
 *   interpreter reads specially, so the arguments can be located after it
 * @param {object} [env]  variables defined for %name% expansion
 * @returns {{argv: string[], operators: string[]}}
 */
function receivedArgs(invocation, shimPath, env) {
  var a = invocation.args;
  if (a[0] !== "/d" || a[1] !== "/s" || a[2] !== "/c" || a.length !== 4) {
    throw new Error("expected cmd.exe /d /s /c <one string>, got " + JSON.stringify(a));
  }
  var typed = a[3];
  if (typed.length < 2 || typed[0] !== '"' || typed[typed.length - 1] !== '"') {
    throw new Error("the /c string must be wrapped in one pair of quotes for /s to remove");
  }
  var first = cmdLayer(typed.slice(1, -1), { percent: true, env: env });
  if (first.text.indexOf(shimPath + " ") !== 0 && first.text !== shimPath) {
    throw new Error("the first parse did not leave the shim path in front: " + JSON.stringify(first.text));
  }
  var forwarded = first.text.slice(shimPath.length);
  var second = cmdLayer(forwarded, { percent: false });
  return { argv: parseArgv(second.text), operators: first.operators.concat(second.operators) };
}

module.exports = {
  cmdLayer: cmdLayer,
  parseArgv: parseArgv,
  receivedArgs: receivedArgs,
};

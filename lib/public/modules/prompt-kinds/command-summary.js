// How a shell command is named to the operator in a permission ask, a banner
// and a summary. One source for the browser and the server (the server loads
// this file through lib/prompt-kinds/codecs.js), so no surface names a call
// differently from another.
//
// A command that opens with environment assignments ("export NAME=value; cmd",
// "NAME=value cmd") would fill a short bound with the assignments and hide the
// command they prefix. commandHead() shortens those assignments to their names
// and keeps the rest verbatim. It never hides code: only a plain literal value
// (letters, digits, - _ . / : , @ % + =) is shortened; any other value leaves
// the whole command as it is.

var NAME = /^[A-Za-z_][A-Za-z0-9_]*=/;
var MAX_NAMES_SHOWN = 3;
var MAX_PREFIX = 40;

// What a line break reads as on a one-line surface: a mark, set off by spaces,
// that no command text is mistaken for.
export var LINE_BREAK = " ⏎ ";

// Bidirectional controls and marks, which reorder how text reads.
function isBidi(code) {
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) ||
    code === 0x200e || code === 0x200f || code === 0x061c;
}

function isControl(code) {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

function escapeCode(code) {
  var hex = code.toString(16).toUpperCase();
  return code <= 0xff ? "\\x" + hex.padStart(2, "0") : "\\u" + hex.padStart(4, "0");
}

/**
 * The text with every control and bidirectional-override character written
 * out as an escape (\x1B, ‮) so it is seen and not interpreted.
 *   keepLayout  keep newline and tab as they are (a block that shows lines);
 *               otherwise a tab becomes a space and each line break (LF, CR,
 *               CRLF, the Unicode line and paragraph separators) becomes a
 *               visible LINE_BREAK mark (a one-line ask). A line break is never
 *               a space: "echo ok # note" then "rm -rf data" on the next line
 *               must not read as one commented-out line.
 */
export function visibleChars(text, keepLayout) {
  var s = typeof text === "string" ? text : "";
  var out = "";
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i);
    if ((code === 10 || code === 9) && keepLayout) out += s.charAt(i);
    else if (!keepLayout && (code === 10 || code === 13 || code === 0x2028 || code === 0x2029)) {
      out += LINE_BREAK;
      if (code === 13 && s.charCodeAt(i + 1) === 10) i++;
    } else if (code === 10 || code === 9 || code === 13) out += " ";
    else if (isControl(code) || isBidi(code)) out += escapeCode(code);
    else out += s.charAt(i);
  }
  return out;
}

/**
 * The text as one printable line: visibleChars' one-line form (each line break
 * a LINE_BREAK mark, every other control or bidirectional character written
 * out as an escape), runs of spaces collapsed, the ends trimmed. It calls
 * visibleChars so the two can never differ on which characters are shown.
 */
export function oneLine(text) {
  return visibleChars(text, false).replace(/ {2,}/g, " ").trim();
}

function isSpace(ch) {
  return ch === " " || ch === "\t";
}

// Characters a shortened value may hold. Anything else (a quote, $, a backtick,
// a brace, a parenthesis, a backslash, & | < >) can hide or run code, so it
// is never read past: an allowlist, because a denylist misses the next shape.
var PLAIN_VALUE_CHAR = /[A-Za-z0-9_.\/:,@%+=-]/;

// End index of the value that starts at i: the first space, tab, ; or line
// break after a fully plain literal. -1 when the value is anything else.
function valueEnd(s, i) {
  for (; i < s.length; i++) {
    var ch = s.charAt(i);
    if (isSpace(ch) || ch === ";" || ch === "\n") break;
    if (!PLAIN_VALUE_CHAR.test(ch)) return -1;
  }
  return i;
}

/**
 * The leading assignments of a command and the rest. names is empty (and rest
 * is the whole command) when the command does not open with assignments that
 * can be shortened safely, or is nothing but assignments.
 * @returns {{names: string[], rest: string}}
 */
export function splitAssignments(command) {
  var s = typeof command === "string" ? command : "";
  var whole = { names: [], rest: s };
  var names = [];
  var i = 0;
  for (;;) {
    while (i < s.length && (isSpace(s.charAt(i)) || s.charAt(i) === "\n")) i++;
    var exported = /^export[ \t]+/.exec(s.slice(i));
    var at = exported ? i + exported[0].length : i;
    var count = 0;
    for (;;) {
      var m = NAME.exec(s.slice(at));
      if (!m) break;
      var end = valueEnd(s, at + m[0].length);
      if (end < 0) return whole;
      names.push(m[0].slice(0, -1));
      count++;
      at = end;
      while (at < s.length && isSpace(s.charAt(at))) at++;
    }
    if (!count) break;
    i = at;
    var next = s.charAt(i);
    if (next === ";" || next === "\n") {
      i++;
    } else if (s.slice(i, i + 2) === "&&") {
      i += 2;
    } else if (exported || i >= s.length || next === "&" || next === "|" || next === "<" || next === ">" || next === ")") {
      return whole;
    } else {
      break;
    }
  }
  var rest = s.slice(i).trim();
  return names.length && rest ? { names: names, rest: rest } : whole;
}

function prefixFor(names) {
  var shown = names.length > MAX_NAMES_SHOWN ? names.slice(0, MAX_NAMES_SHOWN).join(", ") + " +" + (names.length - MAX_NAMES_SHOWN) : names.join(", ");
  var prefix = "(sets " + shown + ")";
  return prefix.length > MAX_PREFIX ? "(sets " + names.length + " variables)" : prefix;
}

/**
 * The command as a short ask names it: leading assignments shortened to their
 * names ("(sets A, B) cmd args"), the command they prefix kept verbatim.
 * A command with no such assignments is returned unchanged.
 */
export function commandHead(command) {
  var parts = splitAssignments(command);
  return parts.names.length ? prefixFor(parts.names) + " " + parts.rest : (typeof command === "string" ? command : "");
}

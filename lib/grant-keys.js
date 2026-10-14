"use strict";

// What an "Allow for Session" answer grants, and how a later tool call is
// matched against it. One function builds the key for a call; the same key is
// what is stored when the operator grants it and what a later call is looked
// up by, so a grant covers exactly the calls that map to its key and no more.
//
// Key shapes (stored as keys of session.allowedTools, persisted in the session
// meta record):
//   <Tool>               whole tool. Older sessions hold these (the grant used
//                        to be the whole tool); they stay readable and in
//                        force until revoked. New grants never take this
//                        shape for a tool that has a narrower one.
//   Bash:<command>       commands starting with <command> (one word, or a
//                        subcommand pair such as "git status").
//   Bash=<command>       exactly this command line: the line is compound,
//                        redirects, starts with a wrapper that runs other
//                        programs, or carries a flag that makes an otherwise
//                        read-only command act (find -delete).
//   <Write|Edit|...>:<path>  exactly this file: the absolute path string as
//                        requested, matched by equality. The stored value is the
//                        file's realpath at grant time, and the grant stops
//                        matching if it changes. A file with no realpath yet is
//                        not stored at all (allow once).
//   Skill:<name>         one skill.
//   <other tool>         tool name (MCP tools already carry server and tool).
//
// A call with no usable key (a write with no absolute path, a command too long
// to persist) has key null: it can be allowed once, never for the session.

var fs = require("fs");
var path = require("path");

// The session meta record is read back from a 4 KiB chunk, so a grant map that
// grew without bound would make the whole session unloadable after a restart.
var MAX_KEY_LENGTH = 160;
var MAX_GRANTS = 16;
var MAX_GRANT_BYTES = 1600;

var PATH_FIELDS = {
  Write: ["file_path"],
  Edit: ["file_path", "path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
};

// The one table of tools that have scoped keys. A bare-name key for any of them
// is the legacy whole-tool grant that older sessions persisted; isGranted
// honours it for every tool listed here, so adding a scoped key to a tool
// cannot silently drop its persisted grants.
var SCOPED_TOOLS = Object.create(null);
SCOPED_TOOLS.Bash = true;
SCOPED_TOOLS.Skill = true;
Object.keys(PATH_FIELDS).forEach(function (t) { SCOPED_TOOLS[t] = true; });

function hasNarrowKey(toolName) {
  return SCOPED_TOOLS[toolName] === true;
}

// A command line that is exactly one simple command: none of these characters
// can chain, substitute, redirect or escape (a leading VAR=value fails the
// bare-name test below).
var COMPOUND_CHARS = /[;&|<>`$(){}\\\r\n]/;
// A bare program name: no slash, so a path never earns a prefix grant.
var BARE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.+\-]*$/;
// The word that picks a subcommand: not an option.
var SUBCOMMAND_WORD = /^[A-Za-z0-9][A-Za-z0-9\-]*$/;

// Programs that run other programs or arbitrary code: a prefix grant of one
// would allow anything, so only the exact line can be granted.
var RUNNER = /^(sudo|su|doas|env|sh|bash|zsh|dash|ksh|fish|csh|tcsh|eval|exec|xargs|nohup|time|timeout|nice|ionice|watch|command|builtin|busybox|ssh|npx|bunx|uvx|pipx|awk|gawk|perl|ruby|php|node|nodejs|deno|bun|(python|pypy)[0-9.]*)$/;

// Programs whose second word picks what they do.
var SUBCOMMAND_TOOLS = /^(git|npm|pnpm|yarn|docker|kubectl|systemctl|gh|go|cargo|make|lore)$/;

// Flags that make find (or a command like it) execute or write.
var ACTING_FLAGS = { "-exec": 1, "-execdir": 1, "-ok": 1, "-okdir": 1, "-delete": 1, "-fprint": 1, "-fprint0": 1, "-fprintf": 1, "-fls": 1 };

// The governing rule: a grant never covers a call the operator did not see, so
// whenever a prefix cannot be derived safely the key is the exact line.
function bashKey(input) {
  var command = input && typeof input.command === "string" ? input.command.trim() : "";
  if (!command) return null;
  var exact = command.length + 5 <= MAX_KEY_LENGTH ? "Bash=" + command : null;
  var tokens = command.split(/\s+/);
  var acting = tokens.some(function (t) { return Object.prototype.hasOwnProperty.call(ACTING_FLAGS, t); });
  var first = tokens[0];
  if (COMPOUND_CHARS.test(command) || acting || !BARE_NAME.test(first) || RUNNER.test(first)) return exact;
  if (SUBCOMMAND_TOOLS.test(first)) {
    if (!tokens[1] || !SUBCOMMAND_WORD.test(tokens[1])) return exact;
    return "Bash:" + first + " " + tokens[1];
  }
  return "Bash:" + first;
}

// The path a file tool asked for, exactly as written, or null when it is not
// absolute. It is never joined, resolved or normalised: a key computed from the
// string as written is a pure function of the request, so "link/../x" is its
// own key and cannot borrow the grant of the directory it collapses to.
function requestedPath(toolName, input) {
  var fields = PATH_FIELDS[toolName];
  for (var i = 0; i < fields.length; i++) {
    var v = input && input[fields[i]];
    if (typeof v === "string" && v) {
      return v.indexOf("\0") === -1 && path.isAbsolute(v) ? v : null;
    }
  }
  return null;
}

// Matched by string equality only: a sibling file, a subdirectory or a
// differently spelled path to the same file is another key and prompts.
function pathKey(toolName, input) {
  var raw = requestedPath(toolName, input);
  if (raw === null) return null;
  var key = toolName + ":" + raw;
  return key.length <= MAX_KEY_LENGTH ? key : null;
}

function isPathKey(key) {
  var i = key.indexOf(":");
  return i > 0 && Object.prototype.hasOwnProperty.call(PATH_FIELDS, key.slice(0, i));
}

// Where the file really is, or null when it does not exist (yet) or cannot be
// resolved.
function realPathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch (e) {
    return null;
  }
}

/**
 * What is stored under the key when the call is granted: true, or for a file
 * the realpath the target had at grant time, so a symlink swapped in later
 * makes the same name a different file and the call prompts again. A file that
 * does not exist yet, or whose realpath cannot be read, has nothing to bind to
 * and is never stored: an unbound grant would cover whatever the name comes to
 * lead to.
 * @returns {?(true|string)} null when nothing can be stored (allow once only).
 */
function grantValue(toolName, input) {
  var key = permissionGrantKey(toolName, input);
  if (key === null) return null;
  if (!isPathKey(key)) return true;
  var real = realPathOrNull(key.slice(key.indexOf(":") + 1));
  return real !== null && real.length <= MAX_KEY_LENGTH ? real : null;
}

/**
 * Whether a persisted value is one a grant under this key can hold: a file-tool
 * key holds only a realpath string, every other key holds true.
 */
function isGrantValue(key, value) {
  if (isPathKey(key)) {
    return typeof value === "string" && value !== "" && value.length <= MAX_KEY_LENGTH && path.isAbsolute(value);
  }
  return value === true;
}

/**
 * The key a call is granted and matched by, or null when it cannot be granted
 * for the session.
 * @param {string} toolName
 * @param {?object} input
 * @returns {?string}
 */
function permissionGrantKey(toolName, input) {
  if (toolName === "Bash") return bashKey(input);
  if (Object.prototype.hasOwnProperty.call(PATH_FIELDS, toolName)) return pathKey(toolName, input);
  // The Skill tool is one name over many skills; a bare "Skill" key would
  // authorize every one of them. Falls back to the bare name only when the
  // call names no skill.
  if (toolName === "Skill" && input && typeof input.skill === "string" && input.skill) {
    return "Skill:" + input.skill;
  }
  return toolName;
}

/**
 * Describe a stored key for the operator.
 * @param {string} key
 * @returns {{key: string, tool: string, wholeTool: boolean, text: string}}
 */
function describeGrantKey(key) {
  var m = /^([^:=]+)([:=])([\s\S]*)$/.exec(key);
  if (!m) {
    return {
      key: key, tool: key, wholeTool: true,
      text: "Every " + key + " call, whatever it does (whole-tool grant)",
    };
  }
  var tool = m[1];
  var value = m[3];
  var text;
  if (tool === "Bash") {
    text = m[2] === "=" ? "Bash: exactly this command: " + value : "Bash commands starting with " + value;
  } else if (tool === "Skill") {
    text = "Skill " + value;
  } else {
    text = tool + " on this file: " + value;
  }
  return { key: key, tool: tool, wholeTool: false, text: text };
}

/**
 * The sentence the card and banner show before the click, or null when the
 * call cannot be granted for the session.
 * @returns {?string}
 */
function grantScopeText(toolName, input) {
  var key = permissionGrantKey(toolName, input);
  if (key === null) return null;
  var d = describeGrantKey(key);
  if (d.wholeTool) return "Allow every " + toolName + " call in this session";
  if (d.tool === "Bash") {
    return key.charAt(4) === "="
      ? "Allow only this exact command in this session"
      : "Allow Bash commands starting with " + key.slice(5) + " in this session";
  }
  if (d.tool === "Skill") return "Allow the " + key.slice(6) + " skill in this session";
  if (realPathOrNull(key.slice(d.tool.length + 1)) === null) {
    return "This file does not exist yet, so this approval covers this call only";
  }
  return "Allow " + d.tool + " on this file only (" + key.slice(d.tool.length + 1) + ") in this session";
}

/** Whether a call is covered by a grant in the session's map. */
function isGranted(allowedTools, toolName, input) {
  if (!allowedTools) return false;
  var own = function (k) { return Object.prototype.hasOwnProperty.call(allowedTools, k); };
  var key = permissionGrantKey(toolName, input);
  if (key !== null && own(key)) {
    var stored = allowedTools[key];
    if (isGrantValue(key, stored)) {
      if (!isPathKey(key)) return true;
      // A file grant holds only while the name still leads to the file it was
      // bound to; a bare true under a file key is never accepted.
      return realPathOrNull(key.slice(key.indexOf(":") + 1)) === stored;
    }
  }
  // A whole-tool grant from before grants were scoped.
  return hasNarrowKey(toolName) && own(toolName) && allowedTools[toolName] === true;
}

/** Whether one more grant fits in the persisted record. */
function fitsBudget(allowedTools, key, value) {
  var keys = Object.keys(allowedTools || {});
  if (keys.indexOf(key) !== -1) return true;
  if (keys.length >= MAX_GRANTS) return false;
  var size = function (k, v) { return Buffer.byteLength(k) + (typeof v === "string" ? Buffer.byteLength(v) : 0) + 8; };
  var bytes = keys.reduce(function (n, k) { return n + size(k, allowedTools[k]); }, 0);
  return bytes + size(key, value) <= MAX_GRANT_BYTES;
}

module.exports = {
  permissionGrantKey: permissionGrantKey,
  describeGrantKey: describeGrantKey,
  grantScopeText: grantScopeText,
  isGranted: isGranted,
  grantValue: grantValue,
  isGrantValue: isGrantValue,
  fitsBudget: fitsBudget,
  MAX_KEY_LENGTH: MAX_KEY_LENGTH,
  MAX_GRANTS: MAX_GRANTS,
};

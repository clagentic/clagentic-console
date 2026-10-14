"use strict";

// What an "Allow for Session" answer grants, and how a later tool call is
// matched against it. One function builds the key for a call; the same key is
// what is stored when the operator grants it and what a later call is looked
// up by, so a grant covers exactly the calls that map to its key and no more.
//
// Key shapes (stored as keys of session.allowedTools, persisted in the session
// meta record, always with the value true):
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
//   Skill:<name>         one skill.
//   <other tool>         tool name (MCP tools already carry server and tool).
//
// File tools (Write, Edit, MultiEdit, NotebookEdit, the codex file change)
// have no key at all: every call is answered on its own, and only a legacy
// whole-tool grant persisted by an older session is honoured.
//
// A call with no usable key (a file-tool call, a command too long to persist)
// has key null: it can be allowed once, never for the session.

// The session meta record is read back from a 4 KiB chunk, so a grant map that
// grew without bound would make the whole session unloadable after a restart.
var MAX_KEY_LENGTH = 160;
var MAX_GRANTS = 16;
var MAX_GRANT_BYTES = 1600;

// Binding a file grant to the filesystem (lexical paths, then realpaths) left
// a new hole at every review, so file tools never produce a session grant: no
// key, no stored value, no filesystem read.
var FILE_TOOLS = Object.create(null);
FILE_TOOLS.Write = true;
FILE_TOOLS.Edit = true;
FILE_TOOLS.MultiEdit = true;
FILE_TOOLS.NotebookEdit = true;

function isFileTool(toolName) {
  return FILE_TOOLS[toolName] === true;
}

// The one table of tools that have scoped keys, or (file tools) none. A
// bare-name key for any of them is the legacy whole-tool grant that older
// sessions persisted; isGranted honours it for every tool listed here, so
// changing a tool's keys cannot silently drop its persisted grants.
var SCOPED_TOOLS = Object.create(null);
SCOPED_TOOLS.Bash = true;
SCOPED_TOOLS.Skill = true;
Object.keys(FILE_TOOLS).forEach(function (t) { SCOPED_TOOLS[t] = true; });

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

// A key a file tool once carried (Write:<path> in any form). Older sessions
// persisted these; they are dropped on load, never honoured.
function isFileScopedKey(key) {
  var m = /^([^:=]+)[:=]/.exec(key);
  return m !== null && isFileTool(m[1]);
}

/**
 * Whether a persisted value is one a grant under this key can hold: true, and
 * never under a file-scoped key.
 */
function isGrantValue(key, value) {
  return value === true && !isFileScopedKey(key);
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
  if (isFileTool(toolName)) return null;
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
    text = key;
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
  return null;
}

/** Whether a call is covered by a grant in the session's map. */
function isGranted(allowedTools, toolName, input) {
  if (!allowedTools) return false;
  var own = function (k) { return Object.prototype.hasOwnProperty.call(allowedTools, k); };
  var key = permissionGrantKey(toolName, input);
  if (key !== null && own(key) && isGrantValue(key, allowedTools[key])) return true;
  // A whole-tool grant from before grants were scoped.
  return hasNarrowKey(toolName) && own(toolName) && allowedTools[toolName] === true;
}

/** Whether one more grant fits in the persisted record. */
function fitsBudget(allowedTools, key) {
  var keys = Object.keys(allowedTools || {});
  if (keys.indexOf(key) !== -1) return true;
  if (keys.length >= MAX_GRANTS) return false;
  var size = function (k) { return Buffer.byteLength(k) + 8; };
  var bytes = keys.reduce(function (n, k) { return n + size(k); }, 0);
  return bytes + size(key) <= MAX_GRANT_BYTES;
}

module.exports = {
  permissionGrantKey: permissionGrantKey,
  describeGrantKey: describeGrantKey,
  grantScopeText: grantScopeText,
  isGranted: isGranted,
  isFileTool: isFileTool,
  isGrantValue: isGrantValue,
  fitsBudget: fitsBudget,
  MAX_KEY_LENGTH: MAX_KEY_LENGTH,
  MAX_GRANTS: MAX_GRANTS,
};

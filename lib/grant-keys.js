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
//   Bash=<command>       exactly this command line and nothing wider. A line
//                        too long to keep has no key. Bash:<anything> (the
//                        retired prefix shape) is dropped on load.
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

// Deriving a prefix from the command text (lexical rules over a shell grammar)
// missed shell semantics at two successive reviews, so a Bash grant is the
// exact line and nothing wider.
function bashKey(input) {
  var command = input && typeof input.command === "string" ? input.command.trim() : "";
  if (!command) return null;
  return command.length + 5 <= MAX_KEY_LENGTH ? "Bash=" + command : null;
}

// Key shapes older sessions persisted that no call produces any more: a file
// tool key (Write:<path> in any form) and a Bash prefix key (Bash:<command>).
// They are dropped on load, never honoured.
function isRetiredKey(key) {
  var m = /^([^:=]+)([:=])/.exec(key);
  if (m === null) return false;
  return isFileTool(m[1]) || (m[1] === "Bash" && m[2] === ":");
}

/**
 * Whether a persisted value is one a grant under this key can hold: true, and
 * never under a retired key.
 */
function isGrantValue(key, value) {
  return value === true && !isRetiredKey(key);
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
    text = "Bash: exactly this command: " + value;
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
    return "Allow only this exact command in this session";
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

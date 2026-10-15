"use strict";

// What an "Allow for Session" answer grants, and how a later tool call is
// matched against it. One function builds the key for a call; the same key is
// what is stored when the operator grants it and what a later call is looked
// up by.
//
// Key shapes (stored as keys of session.allowedTools, persisted in the session
// meta record, always with the value true):
//   <Tool>        the whole tool: every later call of it in the session skips
//                 the prompt. This holds for file tools and Bash alike.
//   Skill:<name>  one skill (the Skill tool is one name over many skills).
//
// Bash=<command> keys were written by builds that scoped a Bash grant to one
// command line. No call produces one now, so they are dropped on load rather
// than left as grants nothing can match.

var SCOPED_BASH_KEY = /^Bash=/;

/**
 * Whether a persisted value is one a grant under this key can hold: true, and
 * not the retired exact-command Bash key.
 */
function isGrantValue(key, value) {
  return value === true && !SCOPED_BASH_KEY.test(key);
}

/**
 * The key a call is granted and matched by.
 *
 * Most tools are discriminated by bare tool name alone: MCP tools already fold
 * server and tool into the name. The Claude `Skill` tool is the exception:
 * every skill arrives as toolName "Skill" with a different `input.skill`, so a
 * bare "Skill" key would authorize every skill. Falls back to the bare name
 * when the call names no skill.
 * @param {string} toolName
 * @param {?object} input
 * @returns {string}
 */
function permissionGrantKey(toolName, input) {
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
  if (key.indexOf("Skill:") === 0) {
    return { key: key, tool: "Skill", wholeTool: false, text: "Skill " + key.slice(6) };
  }
  return {
    key: key, tool: key, wholeTool: true,
    text: "Every " + key + " call, whatever it does (whole-tool grant)",
  };
}

module.exports = {
  permissionGrantKey: permissionGrantKey,
  describeGrantKey: describeGrantKey,
  isGrantValue: isGrantValue,
};

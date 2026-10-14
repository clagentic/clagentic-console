"use strict";

// The claude CLI has named the tool that dispatches a sub-agent both "Task"
// (older builds) and "Agent" (current builds). Every place that recognises a
// dispatch by tool name asks this predicate, so a rename cannot silently turn
// background-agent tracking off again.
//
// lib/public/modules/tools.js keeps a browser-side copy of this name set (the
// frontend is ESM and cannot require this file); a test asserts both accept
// the same names.
var AGENT_DISPATCH_TOOL_NAMES = ["Task", "Agent"];

function isAgentDispatchTool(name) {
  return typeof name === "string" && AGENT_DISPATCH_TOOL_NAMES.indexOf(name) !== -1;
}

module.exports = {
  AGENT_DISPATCH_TOOL_NAMES: AGENT_DISPATCH_TOOL_NAMES,
  isAgentDispatchTool: isAgentDispatchTool,
};

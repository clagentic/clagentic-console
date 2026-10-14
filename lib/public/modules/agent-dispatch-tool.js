// Browser-side copy of lib/agent-dispatch-tool.js (the backend is CJS and the
// frontend is ESM, so neither can import the other). The claude CLI names the
// sub-agent dispatch tool "Task" in older builds and "Agent" in current ones;
// a test asserts both copies accept the same names.
export var AGENT_DISPATCH_TOOL_NAMES = ["Task", "Agent"];

export function isAgentDispatchTool(name) {
  return typeof name === "string" && AGENT_DISPATCH_TOOL_NAMES.indexOf(name) !== -1;
}

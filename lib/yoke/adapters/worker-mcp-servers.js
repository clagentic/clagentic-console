// worker-mcp-servers.js - rebuilds the in-process MCP servers inside the
// worker process from the JSON-schema descriptors the daemon sends over IPC
// (the SDK's server objects are not serializable). A tool whose schema cannot
// be read (mcp-tool-input.js) is left out and reported; the other tools on its
// server, and the other servers, are still registered.

var mcpToolSchema = require("../../mcp-tool-schema");
var { prepareTool } = require("../../mcp-tool-input");

// Throws when zod cannot be loaded; the caller reports the cause per tool.
function loadZod() {
  var mod = require("zod");
  return mod.z || mod;
}

/**
 * @param {Array} descriptors  [{ serverName, tools: [{ name, description, inputSchema }] }]
 * @param {object} sdk         the SDK module (tool, createSdkMcpServer)
 * @param {object} hooks
 * @param {function(string, string): function} hooks.createHandler  (serverName, toolName) -> tool handler
 * @param {function(object): void} [hooks.onSkipped]  receives the diagnostic for a tool left out
 * @param {function(): ?object} [hooks.loadZod]  returns zod, or null/throws when it cannot be loaded; tests inject it
 * @returns {?object} serverName -> server, or null when none was built
 */
function buildMcpServersFromDescriptors(descriptors, sdk, hooks) {
  if (!descriptors || !descriptors.length) return null;
  var z = null;
  var zodLoadError = "";
  try {
    z = (hooks.loadZod || loadZod)();
  } catch (e) {
    zodLoadError = ": " + ((e && e.message) || String(e));
  }

  var servers = {};
  for (var i = 0; i < descriptors.length; i++) {
    var descriptor = descriptors[i];
    if (!descriptor || !descriptor.serverName || !descriptor.tools || !descriptor.tools.length) continue;
    var tools = [];
    for (var j = 0; j < descriptor.tools.length; j++) {
      var toolDescriptor = descriptor.tools[j];
      if (!toolDescriptor || !toolDescriptor.name) continue;
      var prepared;
      try {
        if (!z) throw new Error("zod could not be loaded in the worker" + zodLoadError);
        prepared = prepareTool(
          z,
          toolDescriptor.inputSchema,
          hooks.createHandler(descriptor.serverName, toolDescriptor.name)
        );
      } catch (e) {
        mcpToolSchema.reportSkippedTool(
          descriptor.serverName,
          toolDescriptor.name,
          (e && e.message) || String(e),
          hooks.onSkipped
        );
        continue;
      }
      tools.push(sdk.tool(
        toolDescriptor.name,
        toolDescriptor.description || toolDescriptor.name,
        prepared.inputSchema,
        prepared.handler
      ));
    }
    if (tools.length > 0) {
      servers[descriptor.serverName] = sdk.createSdkMcpServer({
        name: descriptor.serverName,
        version: "1.0.0",
        tools: tools,
      });
    }
  }

  return Object.keys(servers).length > 0 ? servers : null;
}

module.exports = {
  buildMcpServersFromDescriptors: buildMcpServersFromDescriptors,
};

// mcp-tool-schema.js - turns an in-process MCP tool's input schema into the
// JSON schema handed to a worker process or to the Codex bridge, and reports
// the tools that cannot be converted instead of publishing them with no
// parameters. A tool the model sees with an empty schema is called with
// guessed arguments, and nothing says why; skipping it and naming the cause
// is the one outcome the operator can act on.

var MCP_DIAGNOSTIC_SOURCE = "mcp";

/**
 * A converter that always fails with the reason the real one is unavailable, so
 * every tool left out names the actual cause (a corrupt or incompatible zod
 * install reads differently from a missing one).
 */
function unavailableConverter(cause) {
  return function () {
    throw new Error("the zod schema converter is unavailable: " + cause);
  };
}

/**
 * Loads zod's JSON schema converter. When zod cannot be loaded, or has no
 * converter, the function returned fails with that cause when used.
 * @param {function(): object} [loadZod]  how zod is loaded; tests inject it
 * @returns {function} toJSONSchema
 */
function loadToJSONSchema(loadZod) {
  var zod;
  try {
    zod = (loadZod || function () { return require("zod"); })();
  } catch (e) {
    return unavailableConverter((e && e.message) || String(e));
  }
  if (typeof zod.toJSONSchema !== "function") {
    return unavailableConverter("the installed zod has no toJSONSchema");
  }
  return zod.toJSONSchema;
}

/**
 * Converts one registered tool's input schema.
 * A tool declared without any input schema takes no parameters; that is a
 * valid declaration, not a failure. A schema that exists but cannot be
 * converted is a failure, including when the converter itself is missing.
 *
 * @param {?function} toJSONSchema  converter from loadToJSONSchema (null: none)
 * @param {object} toolDef          the registered tool ({ inputSchema, ... })
 * @returns {{ok: true, schema: object}|{ok: false, error: string}}
 */
function convertToolInputSchema(toJSONSchema, toolDef) {
  if (!toolDef || !toolDef.inputSchema) {
    return { ok: true, schema: { type: "object", properties: {} } };
  }
  if (typeof toJSONSchema !== "function") {
    return { ok: false, error: "the zod schema converter is not available" };
  }
  try {
    return { ok: true, schema: toJSONSchema(toolDef.inputSchema) };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * The diagnostic event that tells the operator a tool was left out.
 * @param {string} serverName
 * @param {string} toolName
 * @param {string} error
 * @returns {{type: string, severity: string, source: string, message: string}}
 */
function skippedToolDiagnostic(serverName, toolName, error) {
  return {
    type: "diagnostic",
    severity: "warning",
    source: MCP_DIAGNOSTIC_SOURCE,
    message: "The MCP tool " + (serverName ? serverName + "/" : "") + toolName
      + " was left out because its input schema could not be converted: " + error,
  };
}

/**
 * Logs a skipped tool and tells the caller's reporter about it.
 * @param {string} serverName
 * @param {string} toolName
 * @param {string} error
 * @param {?function} onSkipped  receives the diagnostic event
 */
function reportSkippedTool(serverName, toolName, error, onSkipped) {
  var diagnostic = skippedToolDiagnostic(serverName, toolName, error);
  console.error("[mcp] " + diagnostic.message);
  if (typeof onSkipped === "function") onSkipped(diagnostic);
  return diagnostic;
}

/**
 * The one place that reads the tool table of an SDK server object. The SDK
 * offers no public way to enumerate the tools of an in-process server, so the
 * table is read from its private field here and nowhere else in the listing
 * path. When the field is absent or no longer a plain table the result says so,
 * so a changed SDK surfaces as a diagnostic and not as tools that vanish.
 *
 * @param {?object} server  SDK server object ({ instance: { _registeredTools } })
 * @returns {{ok: true, tools: object}|{ok: false, error: string}}
 */
function readRegisteredTools(server) {
  // A server without an in-process instance (a plain config) has no tool table
  // to read; that is not an SDK change.
  if (!server || !server.instance) return { ok: true, tools: {} };
  var table = server.instance._registeredTools;
  if (table === undefined || table === null) {
    return { ok: false, error: "the SDK server no longer exposes its registered tool table" };
  }
  if (typeof table !== "object" || Array.isArray(table) || table instanceof Map) {
    return { ok: false, error: "the SDK server's registered tool table changed shape" };
  }
  return { ok: true, tools: table };
}

/**
 * Tells the operator that a whole server's tools could not be read.
 * @param {string} serverName
 * @param {string} error
 * @param {?function} onSkipped
 */
function reportToolsUnreadable(serverName, error, onSkipped) {
  var diagnostic = {
    type: "diagnostic",
    severity: "warning",
    source: MCP_DIAGNOSTIC_SOURCE,
    message: "The MCP server " + serverName + " was left out because its tools could not be listed: " + error,
  };
  console.error("[mcp] " + diagnostic.message);
  if (typeof onSkipped === "function") onSkipped(diagnostic);
  return diagnostic;
}

/**
 * The tools of one in-process MCP server, each with its input schema as JSON
 * schema. A tool whose schema cannot be converted is left out and reported.
 *
 * @param {string} serverName
 * @param {object} server  SDK server object ({ instance: { _registeredTools } })
 * @param {?function} toJSONSchema  converter from loadToJSONSchema
 * @param {?function} onSkipped     receives the diagnostic for a tool left out
 * @returns {Array<{name: string, description: string, inputSchema: object}>}
 */
function listServerTools(serverName, server, toJSONSchema, onSkipped) {
  var found = readRegisteredTools(server);
  if (!found.ok) {
    reportToolsUnreadable(serverName, found.error, onSkipped);
    return [];
  }
  var registered = found.tools;
  var tools = [];
  Object.keys(registered).forEach(function (toolName) {
    var toolDef = registered[toolName];
    var converted = convertToolInputSchema(toJSONSchema, toolDef);
    if (!converted.ok) {
      reportSkippedTool(serverName, toolName, converted.error, onSkipped);
      return;
    }
    tools.push({
      name: toolName,
      description: toolDef.description || toolName,
      inputSchema: converted.schema,
    });
  });
  return tools;
}

module.exports = {
  MCP_DIAGNOSTIC_SOURCE: MCP_DIAGNOSTIC_SOURCE,
  loadToJSONSchema: loadToJSONSchema,
  convertToolInputSchema: convertToolInputSchema,
  readRegisteredTools: readRegisteredTools,
  listServerTools: listServerTools,
  skippedToolDiagnostic: skippedToolDiagnostic,
  reportSkippedTool: reportSkippedTool,
};

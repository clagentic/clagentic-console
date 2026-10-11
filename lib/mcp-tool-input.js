// mcp-tool-input.js - recreates an in-process MCP tool from a descriptor (the
// worker process, the proxies for browser-extension and local MCP servers).
//
// Two jobs, kept apart on purpose:
//   - describing the parameters to the model uses a zod shape built by zod's
//     own converter (z.fromJSONSchema);
//   - deciding whether a call's arguments are valid uses ajv on the tool's
//     original JSON schema.
// zod's converter is documented as semi-experimental and widens some schemas
// (a `required` list next to no `properties`, an enum next to a `type`,
// `uniqueItems`), so it never decides validity. A tool whose schema either
// library cannot read is left out and reported by the caller; nothing is
// registered with a looser schema than the one the tool declared.

var Ajv2020 = require("ajv/dist/2020");

function UnsupportedSchemaError(what) {
  var err = new Error(what);
  err.code = "UNSUPPORTED_SCHEMA";
  return err;
}

// Keys that name the document, not a constraint; ajv refuses a second schema
// with the same $id and an unknown $schema, so neither is passed on.
var DOCUMENT_KEYS = ["$schema", "$id"];

/**
 * The shape an SDK tool() call takes: one zod field per top-level property.
 * Built from the properties, required list and definitions only; the SDK wraps
 * the shape in its own object, so root-level composition cannot be expressed
 * and is enforced by the validator instead.
 */
function describeShape(z, inputSchema) {
  if (!inputSchema.properties) return {};
  if (typeof z.fromJSONSchema !== "function") {
    throw UnsupportedSchemaError("the installed zod has no fromJSONSchema");
  }
  var described = { type: "object", properties: inputSchema.properties };
  ["required", "$defs", "definitions"].forEach(function (key) {
    if (inputSchema[key] !== undefined) described[key] = inputSchema[key];
  });
  // zod turns "format" into a check (z.url(), z.email()); the schema declares
  // it as an annotation and the validator ignores it, so the description must
  // not reject what the schema accepts. A string-valued "format" key is the
  // keyword; an object-valued one is a property of that name and stays.
  var withoutFormat = JSON.parse(JSON.stringify(described), function (key, value) {
    return key === "format" && typeof value === "string" ? undefined : value;
  });
  var converted = z.fromJSONSchema(withoutFormat);
  if (!converted || typeof converted.shape !== "object" || converted.shape === null) {
    throw UnsupportedSchemaError("zod did not produce an object schema for the tool's properties");
  }
  return converted.shape;
}

function compileValidator(inputSchema) {
  var copy = Object.assign({}, inputSchema);
  DOCUMENT_KEYS.forEach(function (key) { delete copy[key]; });
  // format is an annotation unless a validator opts in (JSON Schema 2020-12
  // section 7.2.1); strict:false lets keywords ajv does not know pass as the
  // annotations they are, while a malformed schema still throws on compile.
  var ajv = new Ajv2020({ strict: false, validateFormats: false });
  var validate = ajv.compile(copy);
  return function (args) {
    if (validate(args)) return null;
    return ajv.errorsText(validate.errors);
  };
}

/**
 * @param {object} z               zod
 * @param {?object} inputSchema    the tool's JSON input schema (none: no parameters)
 * @param {function} handler       (args, extra) -> result or promise
 * @returns {{shape: object, handler: function}} the zod shape to register and a
 *   handler that answers invalid arguments with an error result and otherwise
 *   calls `handler`
 * @throws {Error} when either library cannot read the schema; the caller leaves
 *   the tool out and reports it
 */
function prepareTool(z, inputSchema, handler) {
  if (inputSchema === undefined || inputSchema === null) return { shape: {}, handler: handler };
  if (typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    throw UnsupportedSchemaError("an input schema that is not an object");
  }
  var shape = describeShape(z, inputSchema);
  var invalid = compileValidator(inputSchema);
  return {
    shape: shape,
    handler: function (args, extra) {
      var problem = invalid(args);
      if (problem === null) return handler(args, extra);
      return Promise.resolve({
        isError: true,
        content: [{ type: "text", text: "Invalid arguments: " + problem }],
      });
    },
  };
}

module.exports = {
  prepareTool: prepareTool,
  UnsupportedSchemaError: UnsupportedSchemaError,
};

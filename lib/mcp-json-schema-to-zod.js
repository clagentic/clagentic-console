// mcp-json-schema-to-zod.js - rebuilds a zod schema from the JSON schema of an
// MCP tool, for the places that recreate an in-process tool from a descriptor
// (the worker process, the proxies for browser-extension and local MCP servers).
//
// The rebuilt schema must accept exactly what the JSON schema accepts: a field
// validated looser than declared lets a malformed tool call reach the handler.
// So the converter is exact or it refuses. Any keyword or shape it cannot
// reproduce throws UnsupportedSchemaError naming the path and the keyword, and
// the caller leaves that tool out and reports it; there is no "any" fallback
// for a shape that was merely not understood.

// Keywords that carry no validation, safe to ignore. "format" is an annotation
// unless a validator opts in (JSON Schema 2020-12 section 7.2.1).
var ANNOTATIONS = ["$schema", "$id", "description", "title", "default", "examples", "deprecated", "readOnly", "writeOnly", "format"];

function UnsupportedSchemaError(path, what) {
  var err = new Error("unsupported schema at " + (path || "(root)") + ": " + what);
  err.code = "UNSUPPORTED_SCHEMA";
  return err;
}

function requireApi(z, names, path) {
  names.forEach(function (name) {
    if (typeof z[name] !== "function") throw UnsupportedSchemaError(path, "the installed zod has no " + name);
  });
}

/** Throws unless every key of the node was consumed or is an annotation. */
function assertConsumed(node, consumed, path) {
  Object.keys(node).forEach(function (key) {
    if (consumed.indexOf(key) === -1 && ANNOTATIONS.indexOf(key) === -1) {
      throw UnsupportedSchemaError(path, "keyword '" + key + "'");
    }
  });
}

function literalUnion(z, values, path) {
  values.forEach(function (v) {
    if (v !== null && ["string", "number", "boolean"].indexOf(typeof v) === -1) {
      throw UnsupportedSchemaError(path, "an enum or const value that is not a string, number, boolean or null");
    }
  });
  requireApi(z, ["literal", "union"], path);
  if (values.length === 1) return z.literal(values[0]);
  return z.union(values.map(function (v) { return z.literal(v); }));
}

function buildString(z, node, path) {
  requireApi(z, ["string"], path);
  var field = z.string();
  if (node.minLength !== undefined) field = field.min(node.minLength);
  if (node.maxLength !== undefined) field = field.max(node.maxLength);
  if (node.pattern !== undefined) {
    var pattern;
    try {
      pattern = new RegExp(node.pattern);
    } catch (e) {
      throw UnsupportedSchemaError(path, "a pattern JavaScript cannot read (" + e.message + ")");
    }
    field = field.regex(pattern);
  }
  assertConsumed(node, ["type", "minLength", "maxLength", "pattern"], path);
  return field;
}

function buildNumber(z, node, integer, path) {
  requireApi(z, ["number"], path);
  var field = z.number();
  if (integer) field = field.int();
  if (node.minimum !== undefined) field = field.gte(node.minimum);
  if (node.maximum !== undefined) field = field.lte(node.maximum);
  if (typeof node.exclusiveMinimum === "number") field = field.gt(node.exclusiveMinimum);
  else if (node.exclusiveMinimum !== undefined) throw UnsupportedSchemaError(path, "keyword 'exclusiveMinimum' as a boolean");
  if (typeof node.exclusiveMaximum === "number") field = field.lt(node.exclusiveMaximum);
  else if (node.exclusiveMaximum !== undefined) throw UnsupportedSchemaError(path, "keyword 'exclusiveMaximum' as a boolean");
  if (node.multipleOf !== undefined) field = field.multipleOf(node.multipleOf);
  assertConsumed(node, ["type", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"], path);
  return field;
}

function buildArray(z, node, path) {
  requireApi(z, ["array", "any"], path);
  if (node.prefixItems !== undefined) throw UnsupportedSchemaError(path, "keyword 'prefixItems'");
  if (node.uniqueItems === true) throw UnsupportedSchemaError(path, "keyword 'uniqueItems'");
  // No "items" is the schema that accepts any item.
  var item = node.items === undefined ? z.any() : build(z, node.items, path + "[]");
  var field = z.array(item);
  if (node.minItems !== undefined) field = field.min(node.minItems);
  if (node.maxItems !== undefined) field = field.max(node.maxItems);
  assertConsumed(node, ["type", "items", "minItems", "maxItems", "uniqueItems"], path);
  return field;
}

function buildObject(z, node, path) {
  var props = node.properties || {};
  var required = Array.isArray(node.required) ? node.required : [];
  var keys = Object.keys(props);
  var extra = node.additionalProperties;
  assertConsumed(node, ["type", "properties", "required", "additionalProperties"], path);

  if (!keys.length && extra !== false) {
    requireApi(z, ["record", "string", "any"], path);
    if (extra && typeof extra === "object") return z.record(z.string(), build(z, extra, path + "{}"));
    return z.record(z.string(), z.any());
  }

  required.forEach(function (key) {
    if (keys.indexOf(key) === -1) throw UnsupportedSchemaError(path, "required property '" + key + "' with no schema");
  });
  var shape = {};
  keys.forEach(function (key) {
    var field = build(z, props[key], path + "." + key);
    shape[key] = required.indexOf(key) === -1 ? field.optional() : field;
  });

  if (extra === false) {
    requireApi(z, ["strictObject"], path);
    return z.strictObject(shape);
  }
  if (extra && typeof extra === "object") {
    requireApi(z, ["object"], path);
    return z.object(shape).catchall(build(z, extra, path + "{}"));
  }
  requireApi(z, ["looseObject"], path);
  return z.looseObject(shape);
}

/**
 * @param {object} z     zod
 * @param {*} node       a JSON schema (object or boolean)
 * @param {string} [path]  where the node sits, for the error
 * @returns {object} a zod schema accepting exactly what the node accepts
 * @throws {Error} code UNSUPPORTED_SCHEMA for anything not reproducible exactly
 */
function build(z, node, path) {
  path = path || "";
  if (node === true) {
    requireApi(z, ["any"], path);
    return z.any();
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw UnsupportedSchemaError(path, "a schema that is not an object");
  }
  var field = buildNode(z, node, path);
  return typeof node.description === "string" && node.description ? field.describe(node.description) : field;
}

function buildNode(z, node, path) {
  if (node.$ref !== undefined || node.$defs !== undefined || node.definitions !== undefined) {
    throw UnsupportedSchemaError(path, "keyword '$ref' or '$defs'");
  }
  ["oneOf", "not", "if"].forEach(function (keyword) {
    if (node[keyword] !== undefined) throw UnsupportedSchemaError(path, "keyword '" + keyword + "'");
  });
  if (node.const !== undefined) {
    assertConsumed(node, ["const"], path);
    return literalUnion(z, [node.const], path);
  }
  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || !node.enum.length) throw UnsupportedSchemaError(path, "an empty or malformed enum");
    assertConsumed(node, ["enum", "type"], path);
    return literalUnion(z, node.enum, path);
  }
  if (node.anyOf !== undefined) {
    if (!Array.isArray(node.anyOf) || !node.anyOf.length) throw UnsupportedSchemaError(path, "an empty anyOf");
    assertConsumed(node, ["anyOf"], path);
    requireApi(z, ["union"], path);
    var members = node.anyOf.map(function (member, i) { return build(z, member, path + "|" + i); });
    return members.length === 1 ? members[0] : z.union(members);
  }
  if (node.allOf !== undefined) {
    if (!Array.isArray(node.allOf) || !node.allOf.length) throw UnsupportedSchemaError(path, "an empty allOf");
    assertConsumed(node, ["allOf"], path);
    requireApi(z, ["intersection"], path);
    var parts = node.allOf.map(function (member, i) { return build(z, member, path + "&" + i); });
    return parts.reduce(function (left, right) { return z.intersection(left, right); });
  }
  if (Array.isArray(node.type)) {
    // A type list is a union of the single-type schemas sharing the other keywords.
    if (!node.type.length) throw UnsupportedSchemaError(path, "an empty type list");
    requireApi(z, ["union"], path);
    var alternatives = node.type.map(function (t) {
      return build(z, Object.assign({}, node, { type: t }), path);
    });
    return alternatives.length === 1 ? alternatives[0] : z.union(alternatives);
  }
  switch (node.type) {
    case "string": return buildString(z, node, path);
    case "number": return buildNumber(z, node, false, path);
    case "integer": return buildNumber(z, node, true, path);
    case "boolean":
      requireApi(z, ["boolean"], path);
      assertConsumed(node, ["type"], path);
      return z.boolean();
    case "null":
      requireApi(z, ["null"], path);
      assertConsumed(node, ["type"], path);
      return z.null();
    case "array": return buildArray(z, node, path);
    case "object": return buildObject(z, node, path);
    case undefined:
      // The empty schema accepts anything; a schema with keywords but no type
      // is a shape this converter does not read.
      requireApi(z, ["any"], path);
      assertConsumed(node, [], path);
      return z.any();
    default:
      throw UnsupportedSchemaError(path, "type '" + String(node.type) + "'");
  }
}

/**
 * The shape an SDK tool() call takes for a tool's input schema: one zod field
 * per top-level property. The SDK wraps the shape in its own object, so the
 * top level's additionalProperties cannot be expressed and is not read.
 * @param {object} z
 * @param {?object} inputSchema  the tool's JSON input schema
 * @returns {object} property name -> zod schema
 * @throws {Error} code UNSUPPORTED_SCHEMA when a property cannot be reproduced exactly
 */
function buildZodShape(z, inputSchema) {
  if (!inputSchema || !inputSchema.properties) return {};
  var required = inputSchema.required || [];
  var shape = {};
  Object.keys(inputSchema.properties).forEach(function (key) {
    var field = build(z, inputSchema.properties[key], key);
    shape[key] = required.indexOf(key) === -1 ? field.optional() : field;
  });
  return shape;
}

module.exports = {
  buildZodFromJsonSchema: build,
  buildZodShape: buildZodShape,
  UnsupportedSchemaError: UnsupportedSchemaError,
};

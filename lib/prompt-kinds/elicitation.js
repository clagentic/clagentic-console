"use strict";

// MCP elicitation (Claude's onElicitation and Codex's
// mcpServer/elicitation/request): the operator submits the requested form,
// approves the URL, or rejects. Submitted content is passed to the server but
// never recorded, since a form may carry secrets.

var limits = require("./answer-limits");

function plainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

// Whether value is acceptable for one property of the requested schema.
function conforms(prop, value) {
  if (Array.isArray(prop.enum)) return prop.enum.indexOf(value) !== -1;
  switch (prop.type) {
    case "boolean": return typeof value === "boolean";
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    default: return limits.boundedString(value, limits.lengthLimit(prop.maxLength)) !== null;
  }
}

// The submitted content limited to the requested schema: only its properties,
// each only when its value has the declared type. A property the operator
// left empty is absent, never a stand-in value.
function conformingContent(schema, content) {
  var props = schema && schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  var out = {};
  Object.keys(props).forEach(function (name) {
    if (!Object.prototype.hasOwnProperty.call(content, name)) return;
    var prop = props[name] && typeof props[name] === "object" ? props[name] : {};
    if (conforms(prop, content[name])) out[name] = content[name];
  });
  return out;
}

module.exports = {
  name: "elicitation",
  scope: "session",
  store: "pendingElicitations",
  journal: true,

  fields: function (req) {
    return {
      serverName: req.serverName,
      message: req.message,
      mode: req.mode || "form",
      url: req.url || null,
      elicitationId: req.elicitationId || null,
      requestedSchema: req.requestedSchema || null,
    };
  },

  requestFields: function (record) {
    return {
      serverName: record.serverName,
      message: record.message,
      mode: record.mode || "form",
      url: record.url || null,
      elicitationId: record.elicitationId || null,
      requestedSchema: record.requestedSchema || null,
    };
  },

  decisions: ["accept", "reject"],

  parse: function (msg, record) {
    if (msg.action !== "accept") return { action: "reject" };
    return { action: "accept", content: conformingContent(record && record.requestedSchema, plainObject(msg.content)) };
  },

  outcome: function (record, response) {
    if (response.action === "accept") return { action: "accept", content: response.content };
    return { action: "reject" };
  },

  grantsSession: function () { return false; },

  resolvedFields: function (response) {
    return { action: response.action };
  },

  cancelled: function () {
    return { action: "reject" };
  },
};

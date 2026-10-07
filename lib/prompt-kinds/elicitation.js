"use strict";

// MCP elicitation (Claude's onElicitation and Codex's
// mcpServer/elicitation/request): the operator submits the requested form,
// approves the URL, or rejects. Submitted content is passed to the server but
// never recorded, since a form may carry secrets.
//
// What an answer to a requested schema is, and when a URL may be approved,
// is defined once, in the card's elicitation-codec.js (./codecs.js).

var codecs = require("./codecs");

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

  // An acceptance that cannot stand - a URL approval for a URL that is not a
  // web page, a form whose schema is outside the supported subset, or a form
  // missing a required field - is invalid: the prompt stays pending, and
  // nothing unchecked or incomplete reaches the MCP server. A form outside
  // the subset can only be declined.
  parse: function (msg, record) {
    if (msg.action !== "accept") return { action: "reject" };
    var codec = codecs.elicitation();
    if (codec.requestMode(record) === "url") {
      return codec.isOpenableUrl(record && record.url)
        ? { action: "accept", content: {} }
        : { invalid: "the URL is not a web address that can be opened" };
    }
    var problem = codec.schemaProblem(record && record.requestedSchema);
    if (problem) return { invalid: "the requested form is outside the supported MCP elicitation schema (" + problem + "); it can only be declined" };
    var held = codec.contentForSchema(record && record.requestedSchema, msg.content);
    if (held.errors.length) return { invalid: held.errors.join("; ") };
    return { action: "accept", content: held.content };
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

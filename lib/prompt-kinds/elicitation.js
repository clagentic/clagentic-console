"use strict";

// MCP elicitation (Claude's onElicitation and Codex's
// mcpServer/elicitation/request): the operator submits the requested form,
// approves the URL, or rejects. Submitted content is passed to the server but
// never recorded, since a form may carry secrets.

function plainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
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

  parse: function (msg) {
    if (msg.action === "accept") return { action: "accept", content: plainObject(msg.content) };
    return { action: "reject" };
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

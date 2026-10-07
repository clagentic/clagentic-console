"use strict";

// Tool-call approval: allow this call, allow the tool for the rest of the
// session, or deny. Codex command, file-change and MCP approvals arrive here
// through the same canUseTool callback as Claude's.

var toolCall = require("./tool-call");
var { hasOwnKey } = require("./codecs");

var DECISIONS = { allow: true, allow_always: true, deny: true };

module.exports = {
  name: "permission",
  scope: "session",
  store: "pendingPermissions",
  journal: true,

  fields: function (req) {
    return {
      toolName: req.toolName,
      toolInput: req.toolInput,
      decisionReason: req.decisionReason || "",
      vendor: req.vendor,
    };
  },

  requestFields: function (record) {
    return {
      toolName: record.toolName,
      toolInput: record.toolInput,
      decisionReason: record.decisionReason || "",
      vendor: record.vendor,
    };
  },

  decisions: Object.keys(DECISIONS),

  // Anything but a known decision fails closed.
  parse: function (msg) {
    return { decision: hasOwnKey(DECISIONS, msg.decision) ? msg.decision : "deny" };
  },

  outcome: function (record, response, opts) {
    if (response.decision === "deny") return toolCall.deny(opts.denyMessage || "User denied permission");
    return toolCall.allow(record.toolInput);
  },

  grantsSession: function (response) {
    return response.decision === "allow_always";
  },

  resolvedFields: function (response) {
    return { decision: response.decision };
  },

  cancelled: toolCall.cancelled,
};

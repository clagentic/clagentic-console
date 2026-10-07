"use strict";

// Plan approval (ExitPlanMode): approve with or without auto-accepting edits,
// approve into a fresh context, reject, or reject with feedback. The session
// side effects of a decision (permission mode, the fresh session, the
// feedback message) belong to the WS handler; this adapter only decides what
// the vendor callback receives.

var toolCall = require("./tool-call");
var { hasOwnKey } = require("./codecs");

var DECISIONS = {
  allow: true,
  allow_accept_edits: true,
  allow_clear_context: true,
  deny: true,
  deny_with_feedback: true,
};

module.exports = {
  name: "plan",
  scope: "session",
  // Shares the tool-approval store: both kinds answer a canUseTool call.
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

  parse: function (msg) {
    // A page loaded before plan approval had its own kind offered "Allow for
    // session" on every approval banner; for a plan that meant approve.
    var requested = msg.decision === "allow_always" ? "allow" : msg.decision;
    var decision = hasOwnKey(DECISIONS, requested) ? requested : "deny";
    var out = { decision: decision };
    if (decision === "deny_with_feedback") out.feedback = typeof msg.feedback === "string" ? msg.feedback : "";
    if (decision === "allow_clear_context" && typeof msg.planContent === "string") out.planContent = msg.planContent;
    return out;
  },

  outcome: function (record, response, opts) {
    switch (response.decision) {
      case "allow":
      case "allow_accept_edits":
        return toolCall.allow(record.toolInput);
      case "allow_clear_context":
        return toolCall.deny("User chose to clear context and restart");
      case "deny_with_feedback":
        return toolCall.deny(response.feedback || "User provided feedback");
      default:
        return toolCall.deny(opts.denyMessage || "User denied permission");
    }
  },

  grantsSession: function () { return false; },

  resolvedFields: function (response) {
    return { decision: response.decision };
  },

  cancelled: toolCall.cancelled,
};

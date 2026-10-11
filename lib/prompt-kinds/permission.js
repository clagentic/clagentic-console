"use strict";

// Tool-call approval: allow this call, allow the tool for the rest of the
// session, or deny. Codex command, file-change and MCP approvals arrive here
// through the same canUseTool callback as Claude's.
//
// The Claude Agent SDK may attach presentation hints to an ask, and the
// console holds to them wherever it shows or answers one:
//   suppressAlwaysAllowRule  the ask must not offer a persistent choice, so
//                            an Allow-for-session answer is refused here, not
//                            just left off the card;
//   defaultToNo              the ask must not open on an approve choice;
//   matchedAskRule           a user-written ask rule forced the prompt, so no
//                            host-side auto-approval may answer it.
// An ask without hints (Codex approvals, older CLIs) is unchanged.

var toolCall = require("./tool-call");
var { hasOwnKey } = require("./codecs");

var DECISIONS = { allow: true, allow_always: true, deny: true };

// A rule's source and text are authored outside the console and shown to the
// operator, so they are held to a bound and to strings.
var RULE_TEXT_MAX = 200;

function ruleText(value) {
  return typeof value === "string" ? value.slice(0, RULE_TEXT_MAX) : "";
}

// A present rule that is not the expected shape is still a rule-forced ask:
// the hint fails closed.
function matchedRuleOf(raw) {
  if (!raw) return undefined;
  var rule = typeof raw === "object" ? raw : {};
  var out = { source: ruleText(rule.source), toolName: ruleText(rule.toolName) };
  if (typeof rule.ruleContent === "string") out.ruleContent = ruleText(rule.ruleContent);
  return out;
}

// The hints present on a request or a stored record, normalized; absent ones
// are left out so an ask without hints is described exactly as before.
function hintsOf(source) {
  var hints = {};
  if (source.suppressAlwaysAllowRule === true) hints.suppressAlwaysAllowRule = true;
  if (source.defaultToNo === true) hints.defaultToNo = true;
  var rule = matchedRuleOf(source.matchedAskRule);
  if (rule) hints.matchedAskRule = rule;
  return hints;
}

module.exports = {
  name: "permission",
  scope: "session",
  store: "pendingPermissions",
  journal: true,

  fields: function (req) {
    return Object.assign({
      toolName: req.toolName,
      toolInput: req.toolInput,
      decisionReason: req.decisionReason || "",
      vendor: req.vendor,
    }, hintsOf(req));
  },

  requestFields: function (record) {
    return Object.assign({
      toolName: record.toolName,
      toolInput: record.toolInput,
      decisionReason: record.decisionReason || "",
      vendor: record.vendor,
    }, hintsOf(record));
  },

  // What a banner needs to offer the same answers as the card.
  notificationFields: function (record) {
    var hints = hintsOf(record);
    return {
      suppressAlwaysAllowRule: hints.suppressAlwaysAllowRule,
      defaultToNo: hints.defaultToNo,
    };
  },

  decisions: Object.keys(DECISIONS),

  // Anything but a known decision fails closed. An Allow-for-session answer to
  // an ask that must not offer one settles nothing: the prompt stays pending
  // and is offered again to the responder.
  parse: function (msg, record) {
    var decision = hasOwnKey(DECISIONS, msg.decision) ? msg.decision : "deny";
    if (decision === "allow_always" && record && record.suppressAlwaysAllowRule === true) {
      return { invalid: "always_allow_not_offered" };
    }
    return { decision: decision };
  },

  outcome: function (record, response, opts) {
    if (response.decision === "deny") return toolCall.deny(opts.denyMessage || "User denied permission");
    return toolCall.allow(record.toolInput);
  },

  grantsSession: function (response) {
    return response.decision === "allow_always";
  },

  resolvedFields: function (response, record) {
    var hints = record ? hintsOf(record) : {};
    var fields = { decision: response.decision };
    if (hints.matchedAskRule) fields.matchedAskRule = hints.matchedAskRule;
    return fields;
  },

  cancelled: toolCall.cancelled,
};

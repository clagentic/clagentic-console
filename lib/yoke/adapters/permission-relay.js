"use strict";

// The wire shape of a tool-permission ask between a Claude worker process and
// the daemon. The worker builds the message from the options the SDK handed
// its canUseTool callback; the daemon turns it back into the options its own
// canUseTool callback takes. Both sides use these two functions so a field the
// SDK adds to an ask cannot be carried by one and dropped by the other.
//
// The presentation hints travel with the ask: suppressAlwaysAllowRule (no
// persistent "don't ask again" choice), defaultToNo (the ask must not open on
// an approve choice) and matchedAskRule (a user-written ask rule forced the
// prompt, so no host-side auto-approval may answer it). Only a literal true
// restricts, and a rule is data, not a flag: anything present but not an object
// is still a rule-forced ask.

/**
 * @param {string} requestId - the worker's id for this ask.
 * @param {string} toolName
 * @param {object} input
 * @param {object} opts - the SDK's canUseTool options.
 * @returns {object} the IPC message.
 */
function toRequestMessage(requestId, toolName, input, opts) {
  var msg = {
    type: "permission_request",
    requestId: requestId,
    toolName: toolName,
    input: input,
    toolUseId: opts.toolUseID || "",
    decisionReason: opts.decisionReason || "",
  };
  if (opts.suppressAlwaysAllowRule === true) msg.suppressAlwaysAllowRule = true;
  if (opts.defaultToNo === true) msg.defaultToNo = true;
  if (opts.matchedAskRule) msg.matchedAskRule = opts.matchedAskRule;
  // Which MCP server serves the tool and where its definition came from: the
  // daemon keys MCP auto-approval on it, so it must cross the process boundary.
  if (opts.mcpServer && typeof opts.mcpServer === "object") {
    msg.mcpServer = { name: String(opts.mcpServer.name), source: String(opts.mcpServer.source) };
  }
  return msg;
}

/**
 * @param {object} msg - a permission_request IPC message from a worker.
 * @param {AbortSignal} signal - ends the ask when the worker stops waiting.
 * @returns {object} canUseTool options for the daemon-side callback.
 */
function toCanUseToolOptions(msg, signal) {
  var opts = {
    toolUseID: msg.toolUseId,
    decisionReason: msg.decisionReason,
    signal: signal,
  };
  if (msg.suppressAlwaysAllowRule === true) opts.suppressAlwaysAllowRule = true;
  if (msg.defaultToNo === true) opts.defaultToNo = true;
  if (msg.matchedAskRule) opts.matchedAskRule = typeof msg.matchedAskRule === "object" ? msg.matchedAskRule : {};
  if (msg.mcpServer && typeof msg.mcpServer === "object"
      && typeof msg.mcpServer.name === "string" && typeof msg.mcpServer.source === "string") {
    opts.mcpServer = { name: msg.mcpServer.name, source: msg.mcpServer.source };
  }
  return opts;
}

module.exports = {
  toRequestMessage: toRequestMessage,
  toCanUseToolOptions: toCanUseToolOptions,
};

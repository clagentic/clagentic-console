"use strict";

// What a Codex session can do: the declaration the Codex adapter registers and
// the capabilities its init advertises. Every key is one of the YOKE
// capability ledger (lib/yoke/interface.js). A Codex thread is resumed,
// forked and rolled back through the app-server; it has no thinking budget,
// file checkpoints, beta switches or subagents, and no permission modes beyond
// the approval policy Codex owns, so those are declared off and the UI shows
// them disabled.
//
// The declaration is what the oldest supported Codex does. What the running
// Codex lacks narrows it through the session's advertisement: rolling back a
// conversation is thread/revert, which the app-server has from the supported
// floor on, and it is advertised off for a server that does not report it.

/**
 * @param {{features: ?object}} [options]  features: codex-protocol.js protocolFeatures()
 */
function codexCapabilities(options) {
  var features = options && options.features;
  return {
    thinking: false,
    betas: false,
    effort: true,
    rewind: false,
    fork: true,
    rollback: features ? features.threadRevert === true : true,
    sessionResume: true,
    sessionList: false,
    sessionRename: false,
    sessionArchive: false,
    promptSuggestions: true,
    elicitation: true,
    fileCheckpointing: false,
    contextCompacting: false,
    mcpPanel: true,
    backgroundTasks: false,
    steering: false,
    agentInjection: false,
    executionPolicy: true,
    toolPolicy: ["ask", "allow-all"],
    permissionModes: [],
  };
}

module.exports = { codexCapabilities: codexCapabilities };

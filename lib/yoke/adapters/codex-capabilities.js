"use strict";

// What a Codex session can do: the declaration the Codex adapter registers and
// the capabilities its init advertises. Every key is one of the YOKE
// capability ledger (lib/yoke/interface.js). A Codex thread is resumed,
// forked and rolled back through the app-server; it has no thinking budget,
// file checkpoints, beta switches or subagents, and no permission modes beyond
// the approval policy Codex owns, so those are declared off and the UI shows
// them disabled.

function codexCapabilities() {
  return {
    thinking: false,
    betas: false,
    effort: true,
    rewind: false,
    fork: true,
    rollback: true,
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
    perProjectRuntime: true,
    activityTokens: true,
    attestsHumanSessions: true,
    toolPolicy: ["ask", "allow-all"],
    permissionModes: [],
  };
}

module.exports = { codexCapabilities: codexCapabilities };

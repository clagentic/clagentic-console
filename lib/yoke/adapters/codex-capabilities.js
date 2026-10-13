"use strict";

// What a Codex session can do: the declaration the Codex adapter registers and
// the capabilities its init advertises. Every key is one of the YOKE
// capability ledger (lib/yoke/interface.js). A Codex thread is resumed and
// forked through the app-server; it has no thinking budget, file checkpoints,
// beta switches or subagents, and no permission modes beyond the approval
// policy Codex owns, so those are declared off and the UI shows them disabled.
//
// Rewinding a thread in place (rewind, rollback) is not offered: the app-server
// call the console used was removed from the supported releases, and its
// replacement cannot be made safe against a turn appended while it runs.

function codexCapabilities() {
  return {
    thinking: false,
    betas: false,
    effort: true,
    rewind: false,
    fork: true,
    rollback: false,
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

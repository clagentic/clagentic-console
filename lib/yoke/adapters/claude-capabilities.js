"use strict";

// What a Claude session can do, as the client sees it (sent with
// session_switched), and the declaration the Claude adapter registers. Every
// key is one of the YOKE capability ledger (lib/yoke/interface.js).
// permissionModes names the SDK permission modes the session accepts through
// setPermissionMode: the mode picker offers dontAsk and auto only for a vendor
// that lists them, so a vendor that cannot run one never shows it.

var PERMISSION_MODES = ["default", "plan", "acceptEdits", "dontAsk", "auto"];

function claudeCapabilities() {
  return {
    thinking: true,
    betas: true,
    effort: true,
    rewind: true,
    fork: true,
    rollback: false,
    sessionResume: true,
    sessionList: true,
    sessionRename: true,
    sessionArchive: false,
    promptSuggestions: true,
    elicitation: true,
    fileCheckpointing: true,
    contextCompacting: true,
    mcpPanel: true,
    backgroundTasks: true,
    steering: true,
    agentInjection: true,
    executionPolicy: false,
    perProjectRuntime: false,
    activityTokens: false,
    attestsHumanSessions: false,
    toolPolicy: ["ask", "allow-all"],
    permissionModes: PERMISSION_MODES.slice(),
  };
}

module.exports = { claudeCapabilities: claudeCapabilities, PERMISSION_MODES: PERMISSION_MODES };

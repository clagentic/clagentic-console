"use strict";

// What a Claude session can do, as the client sees it (sent with
// session_switched). permissionModes names the SDK permission modes the
// session accepts through setPermissionMode: the mode picker offers dontAsk
// and auto only for a vendor that lists them, so a vendor that cannot run one
// never shows it.

var PERMISSION_MODES = ["default", "plan", "acceptEdits", "dontAsk", "auto"];

function claudeCapabilities() {
  return {
    thinking: true,
    betas: true,
    rewind: true,
    sessionResume: true,
    promptSuggestions: true,
    elicitation: true,
    fileCheckpointing: true,
    contextCompacting: true,
    toolPolicy: ["ask", "allow-all"],
    permissionModes: PERMISSION_MODES.slice(),
  };
}

module.exports = { claudeCapabilities: claudeCapabilities, PERMISSION_MODES: PERMISSION_MODES };

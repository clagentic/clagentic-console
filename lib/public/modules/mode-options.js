// mode-options.js - the permission modes the config chip offers, and their
// labels. Import-free so it can be exercised without the frontend module
// graph.
//
// Default, Plan and Auto-accept edits are offered for every session. Don't
// ask and Auto exist only in Claude Code: they are offered for a session whose
// vendor declares them in capabilities.permissionModes, so a vendor that does
// not (Codex, or one whose capabilities are not known yet) never shows them.
// Full auto is offered when the daemon allows it. Labels follow the Claude
// Code CLI's wording.

var BASE_MODES = [
  { value: "default", label: "Default" },
  { value: "plan", label: "Plan" },
  { value: "acceptEdits", label: "Auto-accept edits" },
];

var CAPABILITY_MODES = [
  { value: "dontAsk", label: "Don’t ask" },
  { value: "auto", label: "Auto" },
];

var FULL_AUTO = { value: "bypassPermissions", label: "Full auto" };

/**
 * @param {?object} capabilities - the session vendor's capabilities.
 * @param {boolean} fullAutoEnabled
 * @returns {{value: string, label: string}[]}
 */
export function modeOptions(capabilities, fullAutoEnabled) {
  var declared = capabilities && Array.isArray(capabilities.permissionModes) ? capabilities.permissionModes : [];
  var options = BASE_MODES.slice();
  CAPABILITY_MODES.forEach(function (m) {
    if (declared.indexOf(m.value) !== -1) options.push(m);
  });
  if (fullAutoEnabled) options.push(FULL_AUTO);
  return options;
}

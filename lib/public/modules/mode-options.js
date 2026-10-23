// mode-options.js - the permission modes the config chip offers, with their
// labels and one-line hints. Import-free so it can be exercised without the
// frontend module graph.
//
// Default, Plan and Accept edits are offered whenever the session's agent
// declares permission modes at all (the caller gates on that capability); an
// agent that declares none is shown no mode list. Don't ask and Auto exist only
// in Claude Code: they are offered for a session whose vendor declares them in
// capabilities.permissionModes, so a vendor that does not (Codex, or one whose
// capabilities are not known yet) never shows them. Bypass permissions is
// offered when the daemon allows it. Labels and hints follow the Claude Agent
// SDK's PermissionMode definitions; only one label contains the word "auto",
// so the picker never shows two kinds of auto.

var BASE_MODES = [
  { value: "default", label: "Default", hint: "Asks before each action that needs permission." },
  { value: "plan", label: "Plan", hint: "Plans only and makes no changes until you approve the plan." },
  { value: "acceptEdits", label: "Accept edits", hint: "Approves file edits automatically and asks for everything else." },
];

var CAPABILITY_MODES = [
  { value: "dontAsk", label: "Don’t ask (deny)", hint: "Never asks. Denies any action that is not already approved." },
  { value: "auto", label: "Auto (model decides)", hint: "A model approves or denies each action and asks you only when it cannot decide." },
];

var FULL_AUTO = { value: "bypassPermissions", label: "Bypass permissions", hint: "Skips permission checks and approves every action." };

/**
 * The modes only some agents run (Don't ask, Auto), for the settings pages'
 * default-mode picker, which lists the base modes with its own wording: those
 * of them the agent declares, with the hint under the picker's `desc` name.
 * @param {?object} capabilities - the agent's capabilities.
 * @returns {{value: string, label: string, desc: string}[]}
 */
export function capabilityModeOptions(capabilities) {
  var declared = capabilities && Array.isArray(capabilities.permissionModes) ? capabilities.permissionModes : [];
  return CAPABILITY_MODES.filter(function (m) {
    return declared.indexOf(m.value) !== -1;
  }).map(function (m) {
    return { value: m.value, label: m.label, desc: m.hint };
  });
}

/**
 * @param {?object} capabilities - the session vendor's capabilities.
 * @param {boolean} fullAutoEnabled
 * @returns {{value: string, label: string, hint: string}[]}
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

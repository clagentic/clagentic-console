// permission-settings.js - the server-wide permission settings on the server
// settings page: "Auto-approve read-only tools" and "Mode for sessions opened
// by the CLI or a trigger". The server holds the values and sends them on
// connect and after every change; only an administrator's change is accepted.
// The two message handlers are registered by app-messages.js.

import { showToast } from './utils.js';
import { renderModeList } from './settings-defaults.js';
import { capabilitiesFor, defaultVendorId } from './vendor-registry.js';

// The defaults, which are also what the server runs with until it says otherwise.
var current = { autoApproveReadOnly: true, openedSessionMode: "acceptEdits" };
var sendSetting = null;

function change(values) {
  if (sendSetting) sendSetting("set_permission_settings", values);
}

/**
 * Draws both controls from the latest values. sendMsg(type, data) is the page's
 * WebSocket sender; it is kept for the controls to use.
 */
export function renderPermissionSettings(sendMsg) {
  if (sendMsg) sendSetting = sendMsg;

  var toggle = document.getElementById("ss-auto-approve-readonly");
  if (toggle) {
    toggle.checked = current.autoApproveReadOnly !== false;
    toggle.onchange = function () { change({ autoApproveReadOnly: toggle.checked }); };
  }

  renderModeList("ss-opened", {
    currentMode: current.openedSessionMode,
    capabilities: capabilitiesFor(defaultVendorId()),
    modeMsgType: "set_permission_settings",
    sendMsg: function (type, data) { change({ openedSessionMode: data.mode }); },
  });
}

export function handlePermissionSettings(msg) {
  current = {
    autoApproveReadOnly: msg.autoApproveReadOnly !== false,
    openedSessionMode: typeof msg.openedSessionMode === "string" && msg.openedSessionMode ? msg.openedSessionMode : "acceptEdits",
  };
  renderPermissionSettings();
}

// The result of choosing "Apply to running sessions" with a new default mode.
export function handlePermissionModeApplied(msg) {
  var skipped = Array.isArray(msg.skipped) ? msg.skipped : [];
  var text = "Mode applied to " + msg.applied + " session" + (msg.applied === 1 ? "" : "s") + ".";
  if (skipped.length > 0) {
    text += " " + skipped.length + " skipped: " + skipped.map(function (s) { return s.reason; }).filter(function (r, i, all) { return all.indexOf(r) === i; }).join("; ");
  }
  showToast(text, skipped.length > 0 ? "warn" : "info");
}

// user-shell.js - the composer's ! command line on the page: the request a ! line
// becomes, the card that shows a command and its outcome, and the setting that
// turns the mode off. The server decides everything that matters (the setting,
// OS-user isolation, plan mode, the permission gate); this module only sends the
// line and draws what comes back. Handlers are registered by app-messages.js.

import { store } from './store.js';
import { addToMessages, addSystemMessage, scrollToBottom } from './app-rendering.js';
import { setSendBtnMode } from './app-favicon.js';
import { parseShellLine } from './shell-line.js';
import { buildCard, fillCard, showRunning } from './shell-card.js';

export { parseShellLine };

// The server's defaults, which are also what it runs with until it says otherwise.
var settings = { enabled: true, timeoutMinutes: 10, maxOutputKiB: 256 };
var sendSetting = null;

// requestId -> the card drawn while the command runs, filled in when it lands.
var pending = new Map();

/** Whether a ! line is sent as a command (the setting is on). */
export function isShellModeOn() {
  return settings.enabled !== false;
}

/** Whether a command sent from this page has not finished yet. */
export function isShellPending() {
  return pending.size > 0;
}

function restoreStopMode() {
  setSendBtnMode(store.get("processing") || pending.size > 0 ? "stop" : "send");
}

function newRequestId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return String(Date.now()) + Math.random().toString(36).slice(2);
}

/**
 * Draws the card for a command that was just sent, and returns the request to
 * send. The page shows the command at once; the card fills in when it lands.
 * @param {string} command
 * @returns {object} the `shell` message
 */
export function startShellRequest(command) {
  var requestId = newRequestId();
  var card = buildCard(command, "pending");
  showRunning(card);
  addToMessages(card);
  scrollToBottom();
  pending.set(requestId, card);
  setSendBtnMode("stop");
  var payload = { type: "shell", command: command, requestId: requestId };
  var vendor = store.get("currentVendor");
  if (vendor) payload.vendor = vendor;
  return payload;
}

export function handleShellResult(msg) {
  var card = pending.get(msg.requestId);
  pending.delete(msg.requestId);
  if (msg.refused) {
    if (card) card.remove();
    addSystemMessage(msg.reason || "The command was not run.", true);
    // The line was never sent anywhere: give it back to the composer.
    var input = document.getElementById("input");
    if (input && !input.value && msg.command) input.value = "!" + msg.command;
  } else {
    if (!card) {
      card = buildCard(msg.command, "pending");
      addToMessages(card);
    }
    fillCard(card, msg);
    scrollToBottom();
  }
  restoreStopMode();
}

/** Draws the ! mode switch on the server settings page. */
export function renderUserShellSettings(sendMsg) {
  if (sendMsg) sendSetting = sendMsg;
  var toggle = document.getElementById("ss-user-shell-enabled");
  if (!toggle) return;
  toggle.checked = settings.enabled !== false;
  toggle.onchange = function () {
    if (sendSetting) sendSetting("set_user_shell_settings", { userShellEnabled: toggle.checked });
  };
  var hint = document.getElementById("ss-user-shell-limits");
  if (hint) {
    hint.textContent = "A command is stopped after " + settings.timeoutMinutes + " minutes and its output is cut at " +
      settings.maxOutputKiB + " KiB.";
  }
}

export function handleUserShellSettings(msg) {
  settings = {
    enabled: msg.userShellEnabled !== false,
    timeoutMinutes: typeof msg.userShellTimeoutMinutes === "number" ? msg.userShellTimeoutMinutes : 10,
    maxOutputKiB: typeof msg.userShellMaxOutputKiB === "number" ? msg.userShellMaxOutputKiB : 256,
  };
  renderUserShellSettings();
}

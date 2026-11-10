// shell-settings-controls.js - the ! command line's controls on the server
// settings page: on or off, the time a command may run, and how much of its
// output is kept. The server holds the values and sends them on connect and after
// every change; only an administrator's change is accepted, and the card is shown
// to administrators only. The values are read from the store, where
// user-shell.js puts what the server last sent.

import { store } from './store.js';

// The defaults the server runs with until it says otherwise, and the ranges it
// accepts (lib/user-shell-settings.js); a value outside a range is not sent.
var DEFAULTS = { enabled: true, timeoutMinutes: 10, maxOutputKiB: 256 };
var RANGES = { userShellTimeoutMinutes: [1, 24 * 60], userShellMaxOutputKiB: [1, 4096] };

var sendSetting = null;

function current() {
  return Object.assign({}, DEFAULTS, store.get("userShellSettings") || {});
}

function showProblem(text) {
  var el = document.getElementById("ss-user-shell-problem");
  if (el) el.textContent = text;
}

// Sends one numeric setting when the typed value is a whole number in range;
// otherwise says so and puts the current value back.
function changeCount(input, name, label, redraw) {
  var range = RANGES[name];
  var typed = input.value.trim();
  var n = Number(typed);
  if (typed === "" || !isFinite(n) || Math.floor(n) !== n || n < range[0] || n > range[1]) {
    showProblem(label + " must be a whole number from " + range[0] + " to " + range[1] + ".");
    redraw();
    return;
  }
  showProblem("");
  if (sendSetting) {
    var values = {};
    values[name] = n;
    sendSetting("set_user_shell_settings", values);
  }
}

/**
 * Draws the controls from the latest values. sendMsg(type, data) is the page's
 * WebSocket sender; it is kept for the controls to use.
 */
export function renderUserShellSettings(sendMsg) {
  if (sendMsg) sendSetting = sendMsg;
  var now = current();

  var toggle = document.getElementById("ss-user-shell-enabled");
  if (toggle) {
    toggle.checked = now.enabled !== false;
    toggle.onchange = function () {
      if (sendSetting) sendSetting("set_user_shell_settings", { userShellEnabled: toggle.checked });
    };
  }

  var timeout = document.getElementById("ss-user-shell-timeout");
  if (timeout) {
    timeout.value = String(now.timeoutMinutes);
    timeout.onchange = function () {
      changeCount(timeout, "userShellTimeoutMinutes", "The time limit", function () { timeout.value = String(current().timeoutMinutes); });
    };
  }

  var cap = document.getElementById("ss-user-shell-cap");
  if (cap) {
    cap.value = String(now.maxOutputKiB);
    cap.onchange = function () {
      changeCount(cap, "userShellMaxOutputKiB", "The output limit", function () { cap.value = String(current().maxOutputKiB); });
    };
  }
}

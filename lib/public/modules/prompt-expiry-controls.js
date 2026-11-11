// prompt-expiry-controls.js - the "Expire unanswered prompts after" input on the
// server settings page. The server holds the value and sends it on connect and
// after every change; only an administrator's change is accepted, and the card
// is shown to administrators only. The message handler is registered by
// app-messages.js.

// The default the server runs with until it says otherwise, and the largest
// value it accepts (lib/prompt-expiry.js); a value outside the range is not sent.
var DEFAULT_MINUTES = 30;
var MAX_MINUTES = 35791;

var currentMinutes = DEFAULT_MINUTES;
var sendSetting = null;

function showProblem(text) {
  var el = document.getElementById("ss-prompt-expiry-problem");
  if (el) el.textContent = text;
}

/**
 * Draws the input from the latest value. sendMsg(type, data) is the page's
 * WebSocket sender; it is kept for the control to use.
 */
export function renderPromptExpirySettings(sendMsg) {
  if (sendMsg) sendSetting = sendMsg;
  var input = document.getElementById("ss-prompt-expiry");
  if (!input) return;
  input.value = String(currentMinutes);
  input.onchange = function () {
    var typed = input.value.trim();
    var n = Number(typed);
    if (typed === "" || !isFinite(n) || Math.floor(n) !== n || n < 0 || n > MAX_MINUTES) {
      showProblem("The expiry must be a whole number of minutes from 0 to " + MAX_MINUTES + ". 0 turns expiry off.");
      input.value = String(currentMinutes);
      return;
    }
    showProblem("");
    if (sendSetting) sendSetting("set_prompt_expiry_settings", { promptExpiryMinutes: n });
  };
}

export function handlePromptExpirySettings(msg) {
  var n = msg.promptExpiryMinutes;
  currentMinutes = typeof n === "number" && isFinite(n) && n >= 0 ? n : DEFAULT_MINUTES;
  renderPromptExpirySettings();
}

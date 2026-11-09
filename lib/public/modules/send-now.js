// send-now.js - deliver a typed message into the running turn instead of
// queueing it for the next one. The decision is pure (state in, mode out) so
// the shortcut, the phone button and the tests share one rule, and nothing here
// names an agent: whether a turn can be steered is the `steering` capability.

import { store } from './store.js';
import { capabilityGate } from './vendor-registry.js';

/**
 * What send-now does right now.
 *  - "send":     no turn is running; it is a normal send.
 *  - "steer":    a turn is running and the agent can take a message into it.
 *  - "disabled": a turn is running and the agent cannot; `reason` says why.
 * @param {boolean} processing  a turn is running
 * @param {{enabled: boolean, reason: string}} gate  the steering capability gate
 * @returns {{mode: string, reason: string}}
 */
export function sendNowState(processing, gate) {
  if (!processing) return { mode: "send", reason: "" };
  if (gate && gate.enabled) return { mode: "steer", reason: "" };
  return { mode: "disabled", reason: (gate && gate.reason) || "This agent cannot take a message while it is working." };
}

/**
 * Whether a keydown is the send-now shortcut: Ctrl+Enter anywhere, and
 * Cmd+Enter on macOS. Shift and Alt variants are left to the composer.
 * @param {{key: string, ctrlKey: boolean, metaKey: boolean, shiftKey: boolean, altKey: boolean}} e
 * @param {boolean} isMac
 */
export function isSendNowKey(e, isMac) {
  if (e.key !== "Enter" || e.shiftKey || e.altKey) return false;
  return !!e.ctrlKey || (!!isMac && !!e.metaKey);
}

export function isMacPlatform() {
  var platform = (typeof navigator !== "undefined" && (navigator.platform || "")) || "";
  return /^Mac/i.test(platform);
}

/** The state for the live store and the current agent. */
export function currentSendNowState() {
  return sendNowState(!!store.get("processing"), capabilityGate("steering"));
}

/**
 * Keeps the send-now button in step with the turn and the agent. The button is
 * shown only while a turn is running; when the agent cannot steer it stays
 * visible as aria-disabled with the reason in its title, and tapping it
 * reports the reason instead of doing nothing.
 * @param {HTMLElement} btn
 * @param {function(): void} onSend     send now (the button is usable)
 * @param {function(string): void} notify  shows the reason to the user
 */
export function initSendNowButton(btn, onSend, notify) {
  if (!btn) return;
  function render() {
    var st = currentSendNowState();
    btn.classList.toggle("hidden", st.mode === "send");
    var off = st.mode === "disabled";
    btn.classList.toggle("unavailable", off);
    btn.setAttribute("aria-disabled", off ? "true" : "false");
    btn.title = off ? "Send now (unavailable): " + st.reason : "Send now: deliver this message into the running turn";
  }
  btn.addEventListener("click", function () {
    var st = currentSendNowState();
    if (st.mode === "disabled") { notify(st.reason); return; }
    onSend();
  });
  store.subscribe(["processing", "currentVendor", "vendorCapabilities", "vendorRegistry"], render);
  render();
}

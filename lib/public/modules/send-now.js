// send-now.js - deliver a typed message into the running turn instead of
// queueing it for the next one. The decision is pure (state in, mode out) so
// the shortcut, the queued items' controls, the touch long press and the tests share one rule, and nothing here
// names an agent: whether a turn can be steered is the `steering` capability.

import { store } from './store.js';
import { capabilityGate } from './vendor-registry.js';

// What Send now means for each kind of queued or typed item, in one place.
//  - chat:  into the running turn when the agent has the steering capability
//           (gate "steering"); a normal send when no turn runs.
//  - shell: a ! command never goes into a turn (no two writers on the session):
//           unavailable while a turn runs, and run next when the session is idle.
export var SEND_NOW_BY_KIND = {
  chat: {
    gate: "steering",
    running: "steer",
    idle: "send",
    unavailableReason: "This agent cannot take a message while it is working.",
  },
  shell: {
    gate: null,
    running: "disabled",
    idle: "run-next",
    unavailableReason: "a command runs after the turn",
  },
};

/**
 * What send-now does for one kind right now.
 *  - "send":     chat, no turn running: a normal send.
 *  - "steer":    chat, a turn is running and the agent can take a message into it.
 *  - "run-next": ! command, idle: it runs next.
 *  - "disabled": it cannot be sent now; `reason` says why.
 * @param {string} kind  a key of SEND_NOW_BY_KIND
 * @param {boolean} processing  a turn is running
 * @param {?{enabled: boolean, reason: string}} gate  the capability gate the kind names, if any
 * @returns {{mode: string, reason: string}}
 */
export function sendNowForKind(kind, processing, gate) {
  var rule = SEND_NOW_BY_KIND[kind];
  if (!rule) return { mode: "disabled", reason: "Unknown kind of item." };
  if (!processing) return { mode: rule.idle, reason: "" };
  if (rule.running === "disabled") return { mode: "disabled", reason: rule.unavailableReason };
  if (!rule.gate || (gate && gate.enabled)) return { mode: rule.running, reason: "" };
  return { mode: "disabled", reason: (gate && gate.reason) || rule.unavailableReason };
}

/** The chat rule: what send-now does to a typed message right now. */
export function sendNowState(processing, gate) {
  return sendNowForKind("chat", processing, gate);
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

/** The state for one kind, for the live store and the current agent. */
export function currentSendNowState(kind) {
  var k = kind || "chat";
  var rule = SEND_NOW_BY_KIND[k];
  return sendNowForKind(k, !!store.get("processing"), rule && rule.gate ? capabilityGate(rule.gate) : null);
}

/**
 * Send now for a touch screen, where there is no Ctrl key and no button of its
 * own: a long press on the send button, while a message is ready to go, sends
 * it now. The click that ends the press is swallowed so it does not also send.
 * Register this before the button's own click handler.
 * @param {HTMLElement} btn
 * @param {function(): boolean} canArm  a press may start send-now (a turn runs and a draft is ready)
 * @param {function(): void} onSendNow
 * @param {number} [ms]  how long a press counts as long
 */
export function initSendLongPress(btn, canArm, onSendNow, ms) {
  if (!btn) return;
  var delay = ms || 500;
  var timer = null;
  var fired = false;
  function clear() { if (timer !== null) { clearTimeout(timer); timer = null; } }
  btn.addEventListener("pointerdown", function (e) {
    if (e && e.pointerType === "mouse") return;
    fired = false;
    clear();
    if (!canArm()) return;
    timer = setTimeout(function () {
      timer = null;
      fired = true;
      onSendNow();
    }, delay);
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (name) { btn.addEventListener(name, clear); });
  btn.addEventListener("contextmenu", function (e) { if (fired || timer !== null) e.preventDefault(); });
  btn.addEventListener("click", function (e) {
    if (!fired) return;
    fired = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  });
}

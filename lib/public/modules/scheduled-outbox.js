// scheduled-outbox.js - the session's armed scheduled inputs, drawn in the
// composer's outbox beside the queued chat and ! items. The scheduled-input
// service is the store and the scheduler: the page draws the list the server
// sends (scheduled_input_list) and sends Fire now and Cancel back. Nothing here
// is kept or timed by the page except the countdown text.
//
// One rendering per schedule: this row is the only one in the composer (the
// schedule panel's list is a separate surface). The rows share one container,
// which addToMessages keeps at the end of the message list, after the queued
// items.

import { addToMessages, scrollToBottom } from './app-rendering.js';
import { sendScheduledNow, cancelScheduledInput } from './scheduled-input-actions.js';
import { countdownText } from './schedule-time.js';
import { currentSendNowState, sendNowLabel } from './send-now.js';
import { queuedButton } from './queued-button.js';

var containerEl = null;
var countdowns = [];
var countdownTimer = null;

function tickCountdowns() {
  var now = Date.now();
  countdowns.forEach(function (c) { c.el.textContent = countdownText(c.input, now); });
}

// Fire now follows the capability table like Send now of the other kinds; a
// disabled state is aria-disabled so a tap can still say why.
function paintFireNow(btn) {
  var st = currentSendNowState("scheduled");
  var off = st.mode === "disabled";
  btn.classList.toggle("unavailable", off);
  btn.setAttribute("aria-disabled", off ? "true" : "false");
  btn.title = off
    ? sendNowLabel("scheduled") + " (unavailable): " + st.reason
    : sendNowLabel("scheduled") + ": deliver this schedule now";
}

function buildRow(input) {
  var el = document.createElement("div");
  el.className = "shell-queued scheduled-queued";
  el.setAttribute("data-id", input.id);

  var tag = document.createElement("span");
  tag.className = "shell-queued-tag";
  tag.textContent = "Scheduled";

  var when = document.createElement("span");
  when.className = "scheduled-queued-time";

  var body = document.createElement("span");
  body.className = "shell-queued-text";
  body.textContent = input.text;
  body.setAttribute("title", input.text);

  var actions = document.createElement("span");
  actions.className = "shell-queued-actions";
  var fireBtn = queuedButton(sendNowLabel("scheduled"), "shell-queued-send-now scheduled-queued-fire");
  fireBtn.addEventListener("click", function () {
    var st = currentSendNowState("scheduled");
    if (st.mode === "disabled") return;
    sendScheduledNow(input.id);
  });
  var cancelBtn = queuedButton("Cancel", "shell-queued-cancel scheduled-queued-cancel");
  cancelBtn.addEventListener("click", function () { cancelScheduledInput(input.id); });
  actions.appendChild(fireBtn);
  actions.appendChild(cancelBtn);
  paintFireNow(fireBtn);

  el.appendChild(tag);
  el.appendChild(when);
  el.appendChild(body);
  el.appendChild(actions);
  return { el: el, when: when };
}

/**
 * Redraws the outbox rows of the session on screen from the server's list:
 * one row per armed input, in the list's order. Replaces what was drawn.
 * @param {Array<object>} inputs  the service's armed inputs for the session
 */
export function renderScheduledOutbox(inputs) {
  removeScheduledOutbox();
  if (!inputs || inputs.length === 0) return;
  var container = document.createElement("div");
  container.className = "scheduled-msgs";
  inputs.forEach(function (input) {
    var row = buildRow(input);
    container.appendChild(row.el);
    countdowns.push({ el: row.when, input: input });
  });
  addToMessages(container);
  containerEl = container;
  scrollToBottom();
  tickCountdowns();
  countdownTimer = setInterval(tickCountdowns, 1000);
}

/** Removes the drawn rows and their countdown; the session's list is untouched. */
export function removeScheduledOutbox() {
  if (containerEl) {
    containerEl.remove();
    containerEl = null;
  }
  countdowns = [];
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

/** The container of the drawn rows, or null when the session has none. */
export function getScheduledOutboxEl() { return containerEl; }

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
import { buildCollapsibleText, isNonTypedInput } from './collapsible-text.js';
import { refreshIcons } from './icons.js';

var containerEl = null;
var countdowns = [];
var countdownTimer = null;
// Rows with a Fire now or Cancel request sent and not yet answered: schedule id
// -> the request id sent. The server already refuses a second send; this only
// keeps a second click from being made. A row is freed by the server's answer
// to that request (scheduled_request_result, or an error carrying the same
// request id), by the list no longer having it, or by a reconnect.
var inFlight = {};
var failures = {};
var requestSeq = 0;

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

function paintBusy(row, id) {
  var busy = !!inFlight[id];
  row.fireBtn.disabled = busy;
  row.cancelBtn.disabled = busy;
  row.fireBtn.setAttribute("aria-busy", busy ? "true" : "false");
  row.cancelBtn.setAttribute("aria-busy", busy ? "true" : "false");
  row.errorEl.textContent = failures[id] || "";
}

function repaintRow(id) {
  if (!containerEl) return;
  rows.forEach(function (r) { if (r.id === id) paintBusy(r, id); });
}

var rows = [];

// Sends one request for the row; a refused send frees the row at once, the
// server's answer frees it through completeScheduledRequest or
// failScheduledRequests, matched on the request id.
function request(id, send) {
  if (inFlight[id]) return;
  var requestId = "sr_" + (++requestSeq);
  inFlight[id] = requestId;
  delete failures[id];
  repaintRow(id);
  if (send(id, requestId) === false) {
    delete inFlight[id];
    failures[id] = "Could not send the request: the connection is not open.";
    repaintRow(id);
  }
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
  var toggle = null;
  // A schedule is input the console pushes in later: the same rule as its delivery.
  // The card is one line, so Expand is always there: the next time, cadence and
  // remaining count (when) are shown only in the expanded view.
  if (isNonTypedInput({ initiator: "scheduled", senderKind: "automation" })) {
    var collapsible = buildCollapsibleText(input.text, {
      lines: 1,
      size: "compact",
      controls: "inline",
      onChange: function (collapsed) { el.classList.toggle("is-expanded", !collapsed); },
    });
    body.appendChild(collapsible.el);
    toggle = collapsible.button;
  } else {
    body.textContent = input.text;
  }

  var actions = document.createElement("span");
  actions.className = "shell-queued-actions";
  var fireBtn = queuedButton(sendNowLabel("scheduled"), "shell-queued-send-now scheduled-queued-fire", { icon: "play" });
  fireBtn.addEventListener("click", function () {
    var st = currentSendNowState("scheduled");
    if (st.mode === "disabled") return;
    request(input.id, sendScheduledNow);
  });
  var cancelBtn = queuedButton("Cancel", "shell-queued-cancel scheduled-queued-cancel", { icon: "x" });
  cancelBtn.addEventListener("click", function () { request(input.id, cancelScheduledInput); });
  actions.appendChild(fireBtn);
  actions.appendChild(cancelBtn);
  if (toggle) {
    toggle.classList.add("shell-queued-btn", "shell-queued-icon-btn");
    actions.appendChild(toggle);
  }
  paintFireNow(fireBtn);

  var errorEl = document.createElement("span");
  errorEl.className = "scheduled-queued-error";
  errorEl.setAttribute("role", "alert");

  el.appendChild(tag);
  el.appendChild(body);
  el.appendChild(actions);
  el.appendChild(when);
  el.appendChild(errorEl);
  var row = { id: input.id, el: el, when: when, fireBtn: fireBtn, cancelBtn: cancelBtn, errorEl: errorEl };
  paintBusy(row, input.id);
  return row;
}

function rowsOfRequest(requestId) {
  if (!requestId) return [];
  return Object.keys(inFlight).filter(function (id) { return inFlight[id] === requestId; });
}

/**
 * The server answered a Fire now or Cancel with an error that names the request
 * (requestId): only the row that sent it is freed and shows the failure. An
 * error without a request id, or with one this page is not waiting on, is not
 * about any row and frees none.
 * @param {string} text  the server's error text
 * @param {string} [requestId]  the request id the error carries
 */
export function failScheduledRequests(text, requestId) {
  rowsOfRequest(requestId).forEach(function (id) {
    delete inFlight[id];
    failures[id] = text || "The request failed.";
    repaintRow(id);
  });
}

/**
 * The server answered a Fire now or Cancel as done (scheduled_request_result):
 * the row that sent it is freed. A recurring schedule stays listed after Fire
 * now, so its controls are enabled again here, not by the list.
 * @param {string} requestId  the request id the answer carries
 */
export function completeScheduledRequest(requestId) {
  rowsOfRequest(requestId).forEach(function (id) {
    delete inFlight[id];
    repaintRow(id);
  });
}

/**
 * The connection came back: an answer lost with the old connection will never
 * arrive, so nothing stays waiting, and the rows are repainted enabled. The
 * server's list, requested on reconnect, redraws what is armed.
 */
export function clearScheduledOutboxOnReconnect() {
  inFlight = {};
  failures = {};
  rows.forEach(function (r) { paintBusy(r, r.id); });
}

/**
 * Redraws the outbox rows of the session on screen from the server's list:
 * one row per armed input, in the list's order. Replaces what was drawn.
 * @param {Array<object>} inputs  the service's armed inputs for the session
 */
export function renderScheduledOutbox(inputs) {
  removeScheduledOutbox();
  // A schedule the server no longer lists has left: nothing of it stays waiting.
  var listed = {};
  (inputs || []).forEach(function (i) { listed[i.id] = true; });
  Object.keys(inFlight).forEach(function (id) { if (!listed[id]) delete inFlight[id]; });
  Object.keys(failures).forEach(function (id) { if (!listed[id]) delete failures[id]; });
  if (!inputs || inputs.length === 0) return;
  var container = document.createElement("div");
  container.className = "scheduled-msgs";
  inputs.forEach(function (input) {
    var row = buildRow(input);
    container.appendChild(row.el);
    rows.push(row);
    countdowns.push({ el: row.when, input: input });
  });
  addToMessages(container);
  containerEl = container;
  refreshIcons(container);
  scrollToBottom();
  tickCountdowns();
  countdownTimer = setInterval(tickCountdowns, 1000);
}

/** Forgets the requests in flight and their failures (the view left the session). */
export function resetScheduledOutboxRequests() {
  inFlight = {};
  failures = {};
}

/** Removes the drawn rows and their countdown; the session's list is untouched. */
export function removeScheduledOutbox() {
  if (containerEl) {
    containerEl.remove();
    containerEl = null;
  }
  countdowns = [];
  rows = [];
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

/** The container of the drawn rows, or null when the session has none. */
export function getScheduledOutboxEl() { return containerEl; }

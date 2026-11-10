// shell-card.js - the card that shows a command typed with ! and how it ended.
// Everything a command or its output carries goes in as text (textContent), never
// as markup: output is whatever a program printed.

import { describeResult } from './shell-line.js';

/**
 * A card for a command, with no outcome yet.
 * @param {string} command
 * @param {string} state - the card's style: pending, ok, failed, error, denied, refused
 * @returns {HTMLElement}
 */
export function buildCard(command, state) {
  var card = document.createElement("div");
  card.className = "shell-result " + state;
  var cmd = document.createElement("div");
  cmd.className = "shell-cmd";
  var prompt = document.createElement("span");
  prompt.className = "shell-prompt";
  prompt.textContent = "!";
  var text = document.createElement("span");
  text.textContent = command || "";
  cmd.appendChild(prompt);
  cmd.appendChild(text);
  card.appendChild(cmd);
  return card;
}

function clearOutcome(card) {
  card.querySelectorAll(".shell-output, .shell-status, .shell-actions").forEach(function (el) { el.remove(); });
}

function addStatus(card, text) {
  var status = document.createElement("div");
  status.className = "shell-status";
  status.textContent = text;
  card.appendChild(status);
}

/** Shows a card as still running. */
export function showRunning(card) {
  clearOutcome(card);
  addStatus(card, "Running…");
}

/**
 * Fills a card with a shell_result: its style, its output and how it ended. A
 * refused command gets an Edit action, which hands the command to
 * hooks.onEdit; the page decides where it goes, so a draft is never overwritten.
 * @param {HTMLElement} card
 * @param {object} msg - a shell_result
 * @param {{onEdit: function(string): void}} [hooks]
 */
export function fillCard(card, msg, hooks) {
  var described = describeResult(msg);
  card.className = "shell-result " + described.state;
  clearOutcome(card);
  if (msg.output) {
    var out = document.createElement("pre");
    out.className = "shell-output";
    out.textContent = msg.output;
    card.appendChild(out);
  }
  addStatus(card, described.status);
  if (msg.refused && msg.command && hooks && hooks.onEdit) {
    var actions = document.createElement("div");
    actions.className = "shell-actions";
    var edit = document.createElement("button");
    edit.type = "button";
    edit.className = "shell-edit";
    edit.textContent = "Edit command";
    edit.addEventListener("click", function () { hooks.onEdit(msg.command); });
    actions.appendChild(edit);
    card.appendChild(actions);
  }
}

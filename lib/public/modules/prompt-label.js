// prompt-label.js - how a prompt says whose it is: its project, its session
// and, when a background agent raised it, that agent. The server builds the
// label (lib/prompt-label.js) and sends it on every prompt and its
// notification; the card and the banner both draw it from here so the two
// cannot disagree.
//
// Deliberately free of DOM globals and of imports beyond escape-html, so the
// banner and tests can load it without the rest of the frontend module graph.

import { escapeHtml } from './escape-html.js';

/**
 * @param {?{project?: string, session?: string, agent?: string}} label
 * @returns {{name: string, value: string}[]} the parts that are present, in order.
 */
export function promptLabelParts(label) {
  if (!label || typeof label !== "object") return [];
  var parts = [];
  if (typeof label.project === "string" && label.project) parts.push({ name: "Project", value: label.project });
  if (typeof label.session === "string" && label.session) parts.push({ name: "Session", value: label.session });
  if (typeof label.agent === "string" && label.agent) parts.push({ name: "Agent", value: label.agent });
  return parts;
}

/** The label as one line of plain text; "" when there is none. */
export function promptLabelText(label) {
  return promptLabelParts(label).map(function (p) { return p.name + ": " + p.value; }).join(" | ");
}

/** The label as an element for a card, or null when there is none. */
export function promptLabelElement(label) {
  var text = promptLabelText(label);
  if (!text) return null;
  var el = document.createElement("div");
  el.className = "prompt-label";
  el.textContent = text;
  return el;
}

/** The label as escaped HTML for a banner, or "" when there is none. */
export function promptLabelHtml(label) {
  var text = promptLabelText(label);
  return text ? '<div class="notif-banner-label">' + escapeHtml(text) + '</div>' : "";
}

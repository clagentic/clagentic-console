"use strict";

// Who a prompt is from: the project, the session and, when a background agent
// raised it, that agent. Every surface that shows a prompt (card, banner, push
// notification) shows these, because a banner reaches every connected client
// whatever project it is viewing, and a tool request alone does not say whose
// it is.

var FIELD_MAX = 80;
var UNTITLED = "(untitled session)";

// Titles and agent descriptions are authored outside the console (a session
// title is typed or model-generated, a Task description comes from the model),
// so each is reduced to one bounded line.
function oneLine(raw) {
  if (typeof raw !== "string") return "";
  var one = raw.replace(/\s+/g, " ").trim();
  return one.length > FIELD_MAX ? one.slice(0, FIELD_MAX - 3) + "..." : one;
}

/**
 * @param {{project: ?string, sessionTitle: ?string, agent: ?string}} parts
 * @returns {{project: string, session: string, agent: string}} agent is ""
 *   when the prompt belongs to the session itself.
 */
function promptLabel(parts) {
  var p = parts || {};
  return {
    project: oneLine(p.project),
    session: oneLine(p.sessionTitle) || UNTITLED,
    agent: oneLine(p.agent),
  };
}

/**
 * The label as one line for a push notification.
 * @param {?{project: string, session: string, agent: string}} label
 * @returns {string} "" for no label.
 */
function formatPromptLabel(label) {
  if (!label) return "";
  var out = [];
  if (label.project) out.push("Project: " + label.project);
  if (label.session) out.push("Session: " + label.session);
  if (label.agent) out.push("Agent: " + label.agent);
  return out.join(" | ");
}

/**
 * A push body that says whose prompt it is on its first line.
 * @param {?object} label
 * @param {string} body
 */
function withPromptLabel(label, body) {
  var line = formatPromptLabel(label);
  if (!line) return body || "";
  return body ? line + "\n" + body : line;
}

module.exports = { promptLabel: promptLabel, formatPromptLabel: formatPromptLabel, withPromptLabel: withPromptLabel };

// Tool-call approval card: Allow Once / Allow for Session / Deny, drawn as a
// formal dialog (bubble layout) or a conversational "Can I ...?" (channel
// layout). The shell (prompts.js, prompt-card.js) owns its state. Which
// answers it offers, and which leads, follows the ask's SDK hints
// (permission-choices.js).

import { escapeHtml } from '../utils.js';
import { iconHtml } from '../icons.js';
import { permissionChoices, opensOnNo } from './permission-choices.js';

var FORMAL_CHOICES = {
  allow: { className: "permission-btn permission-allow", label: "Allow Once" },
  allow_always: { className: "permission-btn permission-allow-session", label: "Allow for Session" },
  deny: { className: "permission-btn permission-deny", label: "Deny" },
};

var CONVERSATIONAL_CHOICES = {
  allow: { className: "perm-reply perm-allow", label: "Sure" },
  allow_always: { className: "perm-reply perm-always", label: "Allow for session" },
  deny: { className: "perm-reply perm-deny", label: "No" },
};

// The buttons for an ask's answers, in the order the ask allows. An ask that
// must open on No leads with its decline button and marks it the default;
// no approve button is ever marked.
function choiceButtons(fields, table, container, host) {
  var leadsWithNo = opensOnNo(fields);
  return permissionChoices(fields).map(function (decision, i) {
    var spec = table[decision];
    var btn = button(spec.className, spec.label, function () {
      host.respond(container, { decision: decision });
    });
    if (leadsWithNo && i === 0) btn.dataset.defaultChoice = "true";
    return btn;
  });
}

// The user's own ask rule that forced this prompt, when the SDK says so.
function ruleNote(fields) {
  var rule = fields.matchedAskRule;
  if (!rule || typeof rule !== "object") return null;
  var rendered = (rule.toolName || "") + (rule.ruleContent ? "(" + rule.ruleContent + ")" : "");
  var note = document.createElement("div");
  note.className = "permission-rule";
  note.textContent = "Asked because of your rule" + (rendered ? " " + rendered : "") + (rule.source ? " (" + rule.source + ")" : "");
  return note;
}

function shortPath(p) {
  if (!p) return "";
  var parts = p.split("/");
  return parts.length > 3 ? ".../" + parts.slice(-3).join("/") : p;
}

function inputSummary(toolName, input, host) {
  if (!input || typeof input !== "object") return "";
  switch (toolName) {
    case "Bash": return input.command || input.description || "";
    case "Edit": return shortPath(input.file_path);
    case "Write": return shortPath(input.file_path);
    case "Read": return shortPath(input.file_path);
    case "Glob": return input.pattern || "";
    case "Grep": return (input.pattern || "") + (input.path ? " in " + shortPath(input.path) : "");
    default: return host.toolSummary(toolName, input);
  }
}

/** "Can I <verb> <target>?" wording for a tool call. */
export function askWording(toolName, toolInput) {
  var input = toolInput && typeof toolInput === "object" ? toolInput : {};
  var verb = "use " + toolName;
  var target = "";
  switch (toolName) {
    case "Write": verb = "write to"; target = shortPath(input.file_path); break;
    case "Edit": verb = "edit"; target = shortPath(input.file_path); break;
    case "Read": verb = "read"; target = shortPath(input.file_path); break;
    case "Bash": verb = "run"; target = input.description || (input.command || "").substring(0, 80); break;
    case "Grep": verb = "search"; target = input.pattern || ""; break;
    case "Glob": verb = "search for files in"; target = input.pattern || ""; break;
    case "WebFetch": verb = "fetch"; target = input.url || ""; break;
    case "WebSearch": verb = "search the web for"; target = input.query || ""; break;
  }
  return { verb: verb, target: target };
}

function detailsElement(className, toolInput) {
  var details = document.createElement("details");
  details.className = className;
  var summary = document.createElement("summary");
  summary.textContent = "Details";
  var pre = document.createElement("pre");
  pre.textContent = JSON.stringify(toolInput, null, 2);
  details.appendChild(summary);
  details.appendChild(pre);
  return details;
}

function button(className, label, onClick) {
  var btn = document.createElement("button");
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function drawFormal(fields, requestId, host) {
  var container = document.createElement("div");
  container.className = "permission-container";
  container.dataset.requestId = requestId;

  var header = document.createElement("div");
  header.className = "permission-header";
  header.innerHTML =
    '<span class="permission-icon">' + iconHtml("shield") + '</span>' +
    '<span class="permission-title">Permission Required</span>';

  var body = document.createElement("div");
  body.className = "permission-body";
  var summary = document.createElement("div");
  summary.className = "permission-summary";
  var toolNameEl = document.createElement("span");
  toolNameEl.className = "permission-tool-name";
  toolNameEl.textContent = fields.toolName;
  summary.appendChild(toolNameEl);
  var summaryText = inputSummary(fields.toolName, fields.toolInput, host);
  if (summaryText) {
    var descEl = document.createElement("span");
    descEl.className = "permission-tool-desc";
    descEl.textContent = summaryText;
    summary.appendChild(descEl);
  }
  body.appendChild(summary);
  if (fields.decisionReason) {
    var reason = document.createElement("div");
    reason.className = "permission-reason";
    reason.textContent = fields.decisionReason;
    body.appendChild(reason);
  }
  var rule = ruleNote(fields);
  if (rule) body.appendChild(rule);
  body.appendChild(detailsElement("permission-details", fields.toolInput));

  var actions = document.createElement("div");
  actions.className = "permission-actions";
  choiceButtons(fields, FORMAL_CHOICES, container, host).forEach(function (btn) { actions.appendChild(btn); });
  if (opensOnNo(fields)) container.dataset.defaultToNo = "true";

  container.appendChild(header);
  container.appendChild(body);
  container.appendChild(actions);
  return container;
}

function drawConversational(fields, requestId, host) {
  var identity = host.vendorIdentity(fields.vendor);
  var wording = askWording(fields.toolName, fields.toolInput);

  var container = document.createElement("div");
  container.className = "permission-container";
  container.dataset.requestId = requestId;

  var avi = document.createElement("img");
  avi.className = "dm-bubble-avatar dm-bubble-avatar-agent";
  avi.src = identity.avatar;
  avi.alt = "";
  container.appendChild(avi);

  var content = document.createElement("div");
  content.className = "dm-bubble-content";
  var now = new Date();
  var headerRow = document.createElement("div");
  headerRow.className = "dm-bubble-header";
  headerRow.innerHTML =
    '<span class="dm-bubble-name">' + escapeHtml(identity.name) + '</span>' +
    '<span class="dm-bubble-time">' + String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0") + '</span>';
  content.appendChild(headerRow);

  var askEl = document.createElement("div");
  askEl.className = "perm-ask";
  askEl.textContent = "Can I " + wording.verb + (wording.target ? " " + wording.target : "") + "?";
  content.appendChild(askEl);
  var rule = ruleNote(fields);
  if (rule) content.appendChild(rule);
  content.appendChild(detailsElement("perm-details", fields.toolInput));

  var actions = document.createElement("div");
  actions.className = "permission-actions";
  choiceButtons(fields, CONVERSATIONAL_CHOICES, container, host).forEach(function (btn) { actions.appendChild(btn); });
  if (opensOnNo(fields)) container.dataset.defaultToNo = "true";
  content.appendChild(actions);
  container.appendChild(content);
  return container;
}

export default {
  kind: "permission",

  draw: function (fields, requestId, host) {
    return host.layout() === "channel"
      ? drawConversational(fields, requestId, host)
      : drawFormal(fields, requestId, host);
  },

  outcome: function (state) {
    if (state.decision === "deny") return { text: "Denied", tone: "denied" };
    if (state.decision === "allow_always") return { text: "Allowed for session", tone: "allowed" };
    return { text: "Allowed", tone: "allowed" };
  },
};

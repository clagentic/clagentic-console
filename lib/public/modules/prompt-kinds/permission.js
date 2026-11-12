// Tool-call approval card: a conversational "Can I ...?" from the assistant,
// with Allow / Allow for session / No. The same card for every layout and width.
// The shell (prompts.js, prompt-card.js) owns its state. Which answers it
// offers, and which leads, follows the ask's SDK hints (permission-choices.js).

import { permissionChoices, opensOnNo } from './permission-choices.js';
import { buildMessageHeader } from '../message-header.js';
import { commandHead, visibleChars } from './command-summary.js';

// Characters of a command the ask line shows, assignment prefix included.
var ASK_COMMAND_MAX = 80;
var DESCRIPTION_MAX = 200;

var CHOICES = {
  allow: { className: "perm-reply perm-allow", label: "Sure" },
  allow_always: { className: "perm-reply perm-always", label: "Allow for session" },
  deny: { className: "perm-reply perm-deny", label: "No" },
};

// The buttons for an ask's answers, in the order the ask allows. An ask that
// must open on No leads with its decline button and marks it the default;
// no approve button is ever marked.
function choiceButtons(fields, container, host) {
  var leadsWithNo = opensOnNo(fields);
  return permissionChoices(fields).map(function (decision, i) {
    var spec = CHOICES[decision];
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

// The command, never the agent's own description of it, which is free text
// the calling model chose. Leading environment assignments are shortened so
// the command they prefix shows within the bound.
function bashTarget(command) {
  if (typeof command !== "string" || !command.trim()) return "a Bash call that gave no command";
  var line = visibleChars(commandHead(command), false);
  return line.length > ASK_COMMAND_MAX ? line.substring(0, ASK_COMMAND_MAX) + "..." : line;
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
    case "Bash": verb = "run"; target = bashTarget(input.command); break;
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

// For a Bash call: the agent's description as secondary text, marked as the
// agent's own, and the full command verbatim in a monospace block. Neither
// needs Details to be opened.
function bashEvidence(fields) {
  if (fields.toolName !== "Bash") return [];
  var input = fields.toolInput && typeof fields.toolInput === "object" ? fields.toolInput : {};
  var els = [];
  if (typeof input.description === "string" && input.description.trim()) {
    var note = document.createElement("div");
    note.className = "perm-description";
    var text = visibleChars(input.description, false).trim();
    note.textContent = "Agent's description: " + (text.length > DESCRIPTION_MAX ? text.substring(0, DESCRIPTION_MAX) + "..." : text);
    els.push(note);
  }
  if (typeof input.command === "string" && input.command.trim()) {
    var block = document.createElement("pre");
    block.className = "perm-command";
    block.textContent = visibleChars(input.command, true);
    els.push(block);
  }
  return els;
}

function button(className, label, onClick) {
  var btn = document.createElement("button");
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function draw(fields, requestId, host) {
  var identity = host.vendorIdentity(fields.vendor);
  var wording = askWording(fields.toolName, fields.toolInput);

  var container = document.createElement("div");
  container.className = "permission-container perm-conversational";
  container.dataset.requestId = requestId;

  // No vendor known: a blank avatar, never another vendor's picture.
  var avi = document.createElement(identity.avatar ? "img" : "span");
  avi.className = "dm-bubble-avatar dm-bubble-avatar-agent";
  if (identity.avatar) {
    avi.src = identity.avatar;
    avi.alt = "";
  }

  var content = document.createElement("div");
  content.className = "dm-bubble-content";
  var now = new Date();
  var head = buildMessageHeader({
    side: "other",
    avatarEl: avi,
    name: identity.name,
    time: pad2(now.getHours()) + ":" + pad2(now.getMinutes()),
  });
  content.appendChild(head.el);

  var askEl = document.createElement("div");
  askEl.className = "perm-ask";
  askEl.textContent = "Can I " + wording.verb + (wording.target ? " " + wording.target : "") + "?";
  content.appendChild(askEl);
  bashEvidence(fields).forEach(function (el) { content.appendChild(el); });
  if (fields.decisionReason) {
    var reason = document.createElement("div");
    reason.className = "permission-reason";
    reason.textContent = fields.decisionReason;
    content.appendChild(reason);
  }
  var rule = ruleNote(fields);
  if (rule) content.appendChild(rule);
  content.appendChild(detailsElement("perm-details", fields.toolInput));

  var actions = document.createElement("div");
  actions.className = "permission-actions";
  choiceButtons(fields, container, host).forEach(function (btn) { actions.appendChild(btn); });
  if (opensOnNo(fields)) container.dataset.defaultToNo = "true";
  content.appendChild(actions);
  container.appendChild(content);
  return container;
}

export default {
  kind: "permission",

  draw: draw,

  outcome: function (state) {
    if (state.decision === "deny") return { text: "Denied", tone: "denied" };
    if (state.decision === "allow_always") return { text: "Allowed for session", tone: "allowed" };
    return { text: "Allowed", tone: "allowed" };
  },
};

// Tool-call approval card: a conversational "Can I ...?" from the assistant,
// with Allow / Allow for session / No. The same card for every layout and width.
// The shell (prompts.js, prompt-card.js) owns its state. Which answers it
// offers, and which leads, follows the ask's SDK hints (permission-choices.js).

import { permissionChoices, opensOnNo } from './permission-choices.js';
import { buildMessageHeader } from '../message-header.js';

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

function pad2(n) {
  return String(n).padStart(2, "0");
}

function draw(fields, requestId, host) {
  var identity = host.vendorIdentity(fields.vendor);
  var wording = askWording(fields.toolName, fields.toolInput);

  var container = document.createElement("div");
  container.className = "permission-container perm-conversational";
  container.dataset.requestId = requestId;

  var avi = document.createElement("img");
  avi.className = "dm-bubble-avatar dm-bubble-avatar-agent";
  avi.src = identity.avatar;
  avi.alt = "";

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

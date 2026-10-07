// Tool-call approval card: Allow Once / Allow for Session / Deny, drawn as a
// formal dialog (bubble layout) or a conversational "Can I ...?" (channel
// layout). The shell (prompts.js, prompt-card.js) owns its state.

import { escapeHtml } from '../utils.js';
import { iconHtml } from '../icons.js';

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
  body.appendChild(detailsElement("permission-details", fields.toolInput));

  var actions = document.createElement("div");
  actions.className = "permission-actions";
  actions.appendChild(button("permission-btn permission-allow", "Allow Once", function () {
    host.respond(container, { decision: "allow" });
  }));
  actions.appendChild(button("permission-btn permission-allow-session", "Allow for Session", function () {
    host.respond(container, { decision: "allow_always" });
  }));
  actions.appendChild(button("permission-btn permission-deny", "Deny", function () {
    host.respond(container, { decision: "deny" });
  }));

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
  content.appendChild(detailsElement("perm-details", fields.toolInput));

  var actions = document.createElement("div");
  actions.className = "permission-actions";
  actions.appendChild(button("perm-reply perm-allow", "Sure", function () {
    host.respond(container, { decision: "allow" });
  }));
  actions.appendChild(button("perm-reply perm-always", "Allow for session", function () {
    host.respond(container, { decision: "allow_always" });
  }));
  actions.appendChild(button("perm-reply perm-deny", "No", function () {
    host.respond(container, { decision: "deny" });
  }));
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

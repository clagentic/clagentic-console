// MCP elicitation card: a server asks for form input (form mode) or for
// approval to open a URL (url mode). The shell (prompts.js, prompt-card.js)
// owns its state.

import { escapeHtml } from '../utils.js';
import { iconHtml } from '../icons.js';

var FIELD_STYLE = "padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--input-bg); color: var(--text-primary); font-size: 13px;";

function drawField(propName, prop, isRequired) {
  var wrapper = document.createElement("div");
  wrapper.style.cssText = "display: flex; flex-direction: column; gap: 2px;";
  var label = document.createElement("label");
  label.style.cssText = "font-size: 12px; font-weight: 500; color: var(--text-secondary);";
  label.textContent = propName + (isRequired ? " *" : "");
  if (prop.description) label.title = prop.description;

  var input;
  if (prop.type === "boolean") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.propType = "boolean";
  } else if (prop.enum) {
    input = document.createElement("select");
    input.dataset.propType = "enum";
    input.style.cssText = FIELD_STYLE;
    for (var i = 0; i < prop.enum.length; i++) {
      var opt = document.createElement("option");
      opt.value = prop.enum[i];
      opt.textContent = prop.enum[i];
      input.appendChild(opt);
    }
  } else {
    input = document.createElement("input");
    input.type = prop.type === "number" || prop.type === "integer" ? "number" : "text";
    input.dataset.propType = prop.type || "string";
    input.placeholder = prop.description || propName;
    input.style.cssText = FIELD_STYLE;
  }
  input.dataset.propName = propName;
  wrapper.appendChild(label);
  wrapper.appendChild(input);
  return wrapper;
}

function collectContent(container) {
  var content = {};
  var inputs = container.querySelectorAll("[data-prop-name]");
  for (var i = 0; i < inputs.length; i++) {
    var inp = inputs[i];
    var type = inp.dataset.propType;
    if (type === "boolean") content[inp.dataset.propName] = inp.checked;
    else if (type === "number" || type === "integer") content[inp.dataset.propName] = Number(inp.value);
    else content[inp.dataset.propName] = inp.value;
  }
  return content;
}

export default {
  kind: "elicitation",

  draw: function (fields, requestId, host) {
    var container = document.createElement("div");
    container.className = "permission-container elicitation-container";
    container.dataset.requestId = requestId;

    var header = document.createElement("div");
    header.className = "permission-header";
    header.innerHTML =
      '<span class="permission-icon">' + iconHtml("key") + '</span>' +
      '<span class="permission-title">' + escapeHtml(fields.serverName || "MCP Server") + ' requests input</span>';

    var body = document.createElement("div");
    body.className = "permission-body";
    if (fields.message) {
      var messageEl = document.createElement("div");
      messageEl.className = "permission-reason";
      messageEl.textContent = fields.message;
      body.appendChild(messageEl);
    }

    var isUrl = fields.mode === "url" && fields.url;
    if (isUrl) {
      var urlInfo = document.createElement("div");
      urlInfo.className = "elicitation-url-info";
      urlInfo.style.cssText = "margin-top: 8px; font-size: 12px; color: var(--text-muted);";
      urlInfo.textContent = "Opens: " + fields.url;
      body.appendChild(urlInfo);
    } else if (fields.requestedSchema && fields.requestedSchema.properties) {
      var formEl = document.createElement("div");
      formEl.className = "elicitation-form";
      formEl.style.cssText = "margin-top: 8px; display: flex; flex-direction: column; gap: 8px;";
      var props = fields.requestedSchema.properties;
      var required = fields.requestedSchema.required || [];
      Object.keys(props).forEach(function (propName) {
        formEl.appendChild(drawField(propName, props[propName], required.indexOf(propName) !== -1));
      });
      body.appendChild(formEl);
    }

    var actions = document.createElement("div");
    actions.className = "permission-actions";
    var acceptBtn = document.createElement("button");
    acceptBtn.className = "permission-btn permission-allow";
    acceptBtn.textContent = isUrl ? "Open & Approve" : "Submit";
    acceptBtn.addEventListener("click", function () {
      if (isUrl) {
        window.open(fields.url, "_blank");
        host.respond(container, { action: "accept", content: {} });
      } else {
        host.respond(container, { action: "accept", content: collectContent(container) });
      }
    });
    var denyBtn = document.createElement("button");
    denyBtn.className = "permission-btn permission-deny";
    denyBtn.textContent = "Deny";
    denyBtn.addEventListener("click", function () {
      host.respond(container, { action: "reject" });
    });
    actions.appendChild(acceptBtn);
    actions.appendChild(denyBtn);

    container.appendChild(header);
    container.appendChild(body);
    container.appendChild(actions);
    return container;
  },

  outcome: function (state) {
    if (state.action === "accept") return { text: "Submitted", tone: "allowed" };
    return { text: "Denied", tone: "denied" };
  },
};

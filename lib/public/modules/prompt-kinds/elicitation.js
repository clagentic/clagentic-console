// MCP elicitation card: a server asks for form input (form mode) or for
// approval to open a URL (url mode). The shell (prompts.js, prompt-card.js)
// owns its state.
//
// What the form offers and submits is the shared codec's
// (./elicitation-codec.js, which the server holds answers to): a field left
// empty is absent (never "", 0 or false), a typed field takes only values of
// its type, a required field must be filled before Submit sends, and a URL
// request is approved only when its URL is a web page.

import { escapeHtml } from '../utils.js';
import { iconHtml } from '../icons.js';
import {
  requestMode, isOpenableUrl, lengthLimit, schemaFields, initialControlText, choiceLabel, contentFromControls,
} from './elicitation-codec.js';

var FIELD_STYLE = "padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--input-bg); color: var(--text-primary); font-size: 13px;";
var ERROR_CLASS = "elicitation-error";

function drawField(field) {
  var wrapper = document.createElement("div");
  wrapper.style.cssText = "display: flex; flex-direction: column; gap: 2px;";
  var label = document.createElement("label");
  label.style.cssText = "font-size: 12px; font-weight: 500; color: var(--text-secondary);";
  label.textContent = field.name + (field.required ? " *" : "");
  if (field.prop.description) label.title = field.prop.description;

  var input;
  if (field.choices) {
    // A choice starts unmade unless the schema names a default: an answer
    // the operator did not pick is never sent as theirs.
    input = document.createElement("select");
    input.style.cssText = FIELD_STYLE;
    var none = document.createElement("option");
    none.value = "";
    none.textContent = "";
    input.appendChild(none);
    field.choices.forEach(function (choice) {
      var opt = document.createElement("option");
      opt.value = String(choice);
      opt.textContent = choiceLabel(field, choice);
      input.appendChild(opt);
    });
  } else {
    var numeric = field.type === "number" || field.type === "integer";
    input = document.createElement("input");
    input.type = numeric ? "number" : "text";
    if (numeric) input.step = field.type === "integer" ? "1" : "any";
    else input.maxLength = lengthLimit(field.prop);
    input.placeholder = field.prop.description || field.name;
    input.style.cssText = FIELD_STYLE;
  }
  input.value = initialControlText(field);
  input.dataset.propName = field.name;
  if (field.required) input.dataset.required = "true";
  wrapper.appendChild(label);
  wrapper.appendChild(input);
  return wrapper;
}

function controlTexts(container) {
  var byName = Object.create(null);
  var inputs = container.querySelectorAll("[data-prop-name]");
  for (var i = 0; i < inputs.length; i++) byName[inputs[i].dataset.propName] = inputs[i].value;
  return function (name) { return byName[name]; };
}

function showErrors(container, errors) {
  var old = container.querySelectorAll("." + ERROR_CLASS);
  for (var i = 0; i < old.length; i++) old[i].remove();
  if (!errors.length) return;
  var note = document.createElement("div");
  note.className = ERROR_CLASS + " permission-note-error";
  note.textContent = errors.join("; ");
  container.appendChild(note);
}

function urlNote(url) {
  if (!url) return "No address was given, so there is nothing to open.";
  if (!isOpenableUrl(url)) return "Not a web address, so it cannot be opened: " + url;
  return "Opens: " + url;
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

    var isUrl = requestMode(fields) === "url";
    var schema = fields.requestedSchema || null;
    if (isUrl) {
      var urlInfo = document.createElement("div");
      urlInfo.className = "elicitation-url-info";
      urlInfo.style.cssText = "margin-top: 8px; font-size: 12px; color: var(--text-muted);";
      urlInfo.textContent = urlNote(fields.url);
      body.appendChild(urlInfo);
    } else {
      var formFields = schemaFields(schema);
      if (formFields.length) {
        var formEl = document.createElement("div");
        formEl.className = "elicitation-form";
        formEl.style.cssText = "margin-top: 8px; display: flex; flex-direction: column; gap: 8px;";
        formFields.forEach(function (field) { formEl.appendChild(drawField(field)); });
        body.appendChild(formEl);
      }
    }

    var actions = document.createElement("div");
    actions.className = "permission-actions";
    var acceptBtn = document.createElement("button");
    acceptBtn.className = "permission-btn permission-allow";
    var openable = isUrl && isOpenableUrl(fields.url);
    acceptBtn.textContent = isUrl ? "Open & Approve" : "Submit";
    // A URL that is not a web page is never opened, so it cannot be approved.
    if (isUrl && !openable) acceptBtn.disabled = true;
    acceptBtn.addEventListener("click", function () {
      if (isUrl) {
        if (!openable) return;
        window.open(fields.url, "_blank", "noopener,noreferrer");
        host.respond(container, { action: "accept", content: {} });
        return;
      }
      var form = contentFromControls(schema, controlTexts(container));
      showErrors(container, form.errors);
      if (form.errors.length) return;
      host.respond(container, { action: "accept", content: form.content });
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

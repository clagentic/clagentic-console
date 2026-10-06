// MCP elicitation card: a server asks for form input (form mode) or for
// approval to open a URL (url mode). The shell (prompts.js, prompt-card.js)
// owns its state.
//
// The form submits only what the operator gave, in the schema's types: a
// field left empty is absent (never "" or 0), an integer field takes whole
// numbers only, and a required field must be filled before Submit sends.
// The server holds the content to the same schema
// (lib/prompt-kinds/elicitation.js).

import { escapeHtml } from '../utils.js';
import { iconHtml } from '../icons.js';

var FIELD_STYLE = "padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--input-bg); color: var(--text-primary); font-size: 13px;";
// Same bound the server applies (lib/prompt-kinds/answer-limits.js).
var MAX_ANSWER_CHARS = 10000;
var ERROR_CLASS = "elicitation-error";
// Only a web page may be opened from a prompt.
var OPENABLE_PROTOCOLS = ["http:", "https:"];

/** Whether url is an http(s) URL, the only kind a prompt may open. */
export function isOpenableUrl(url) {
  if (typeof url !== "string" || !url) return false;
  try {
    return OPENABLE_PROTOCOLS.indexOf(new URL(url).protocol) !== -1;
  } catch (e) {
    return false;
  }
}

function lengthLimit(prop) {
  var max = prop.maxLength;
  return (Number.isInteger(max) && max >= 0 && max < MAX_ANSWER_CHARS) ? max : MAX_ANSWER_CHARS;
}

function drawField(propName, prop, isRequired) {
  var wrapper = document.createElement("div");
  wrapper.style.cssText = "display: flex; flex-direction: column; gap: 2px;";
  var label = document.createElement("label");
  label.style.cssText = "font-size: 12px; font-weight: 500; color: var(--text-secondary);";
  label.textContent = propName + (isRequired ? " *" : "");
  if (prop.description) label.title = prop.description;

  var input;
  if (Array.isArray(prop.enum)) {
    input = document.createElement("select");
    input.dataset.propType = "enum";
    input.style.cssText = FIELD_STYLE;
    // An optional choice can be left unmade.
    if (!isRequired) {
      var none = document.createElement("option");
      none.value = "";
      none.textContent = "";
      input.appendChild(none);
    }
    for (var i = 0; i < prop.enum.length; i++) {
      var opt = document.createElement("option");
      opt.value = String(prop.enum[i]);
      opt.textContent = String(prop.enum[i]);
      input.appendChild(opt);
    }
    var initial = prop.enum.indexOf(prop.default) !== -1 ? prop.default : (isRequired ? prop.enum[0] : "");
    input.value = initial === undefined ? "" : String(initial);
  } else if (prop.type === "boolean") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.propType = "boolean";
    input.checked = prop.default === true;
  } else {
    var numeric = prop.type === "number" || prop.type === "integer";
    input = document.createElement("input");
    input.type = numeric ? "number" : "text";
    if (numeric) input.step = prop.type === "integer" ? "1" : "any";
    else input.maxLength = lengthLimit(prop);
    input.dataset.propType = prop.type || "string";
    input.placeholder = prop.description || propName;
    input.style.cssText = FIELD_STYLE;
    if (prop.default !== undefined && prop.default !== null) input.value = String(prop.default);
  }
  input.dataset.propName = propName;
  if (isRequired) input.dataset.required = "true";
  wrapper.appendChild(label);
  wrapper.appendChild(input);
  return wrapper;
}

// One field's value in its schema type: {absent: true} when left empty,
// {error} when it does not fit the type, else {value}.
function fieldValue(inp, prop) {
  var type = inp.dataset.propType;
  if (type === "boolean") return { value: !!inp.checked };
  var raw = String(inp.value == null ? "" : inp.value);
  if (type === "enum") {
    if (raw === "") return { absent: true };
    var match = (prop.enum || []).filter(function (v) { return String(v) === raw; });
    return match.length ? { value: match[0] } : { error: "is not one of the choices" };
  }
  if (type === "number" || type === "integer") {
    if (raw.trim() === "") return { absent: true };
    var n = Number(raw);
    if (!Number.isFinite(n)) return { error: "must be a number" };
    if (type === "integer" && !Number.isInteger(n)) return { error: "must be a whole number" };
    return { value: n };
  }
  if (raw === "") return { absent: true };
  if (raw.length > lengthLimit(prop)) return { error: "is too long" };
  return { value: raw };
}

/**
 * The form's content in the schema's types, and what keeps it from being
 * submitted.
 * @returns {{content: object, errors: string[]}}
 */
function collectContent(container, props) {
  var content = {};
  var errors = [];
  var inputs = container.querySelectorAll("[data-prop-name]");
  for (var i = 0; i < inputs.length; i++) {
    var inp = inputs[i];
    var name = inp.dataset.propName;
    var got = fieldValue(inp, props[name] || {});
    if (got.error) errors.push(name + " " + got.error);
    else if (got.absent) { if (inp.dataset.required) errors.push(name + " is required"); }
    else content[name] = got.value;
  }
  return { content: content, errors: errors };
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

    var isUrl = fields.mode === "url" && !!fields.url;
    var props = (fields.requestedSchema && fields.requestedSchema.properties) || {};
    if (isUrl) {
      var urlInfo = document.createElement("div");
      urlInfo.className = "elicitation-url-info";
      urlInfo.style.cssText = "margin-top: 8px; font-size: 12px; color: var(--text-muted);";
      urlInfo.textContent = isOpenableUrl(fields.url)
        ? "Opens: " + fields.url
        : "Not a web address, so it cannot be opened: " + fields.url;
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
      var form = collectContent(container, props);
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

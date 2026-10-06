// elicitation-codec.js - the one definition of an MCP elicitation answer,
// shared by the card (this directory) and the server
// (lib/prompt-kinds/elicitation.js): which fields a requested JSON Schema
// asks for, what value each may take, how a form control's text reads as
// that value, and when a URL request may be approved.
//
// The body between the shared-codec markers is byte-identical in
// lib/prompt-kinds/elicitation-codec.js, which wraps it for require();
// test/shared-codecs.test.js holds the two copies to that. The server runs
// on Node versions that cannot require() an ES module, hence two wrappers
// around one body.

// <shared-codec>
// Bound on typed text (lib/prompt-kinds/answer-limits.js applies the same).
var MAX_ANSWER_CHARS = 10000;
// Only a web page may be opened from a prompt.
var OPENABLE_PROTOCOLS = ["http:", "https:"];

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Defined, not assigned, so a field named "__proto__" is a key.
function put(obj, key, value) {
  Object.defineProperty(obj, key, { value: value, enumerable: true, writable: true, configurable: true });
}

// "url" when the server asks the operator to open a URL, else "form". A URL
// request is never treated as a form, whether or not its URL is usable.
function requestMode(request) {
  return request && request.mode === "url" ? "url" : "form";
}

// Whether url is an http(s) URL, the only kind a prompt may open.
function isOpenableUrl(url) {
  if (typeof url !== "string" || !url) return false;
  try {
    return OPENABLE_PROTOCOLS.indexOf(new URL(url).protocol) !== -1;
  } catch (e) {
    return false;
  }
}

// The longest text a field takes: the schema's own maxLength when tighter.
function lengthLimit(prop) {
  var max = prop.maxLength;
  return (Number.isInteger(max) && max >= 0 && max < MAX_ANSWER_CHARS) ? max : MAX_ANSWER_CHARS;
}

// What a property's value is: one of its enum values, or a boolean,
// integer, number or (anything else) string.
function fieldType(prop) {
  if (Array.isArray(prop.enum)) return "enum";
  if (prop.type === "boolean" || prop.type === "integer" || prop.type === "number") return prop.type;
  return "string";
}

// The fields a requested schema asks for, in its order: name, property,
// type, whether required, and the values a choice field offers (null for a
// typed-in field). A boolean is a choice between true and false.
function schemaFields(schema) {
  var props = schema && isPlainObject(schema.properties) ? schema.properties : {};
  var required = schema && Array.isArray(schema.required) ? schema.required : [];
  return Object.keys(props).map(function (name) {
    var prop = isPlainObject(props[name]) ? props[name] : {};
    var type = fieldType(prop);
    var choices = type === "enum" ? prop.enum.slice() : type === "boolean" ? [true, false] : null;
    return { name: name, prop: prop, type: type, required: required.indexOf(name) !== -1, choices: choices };
  });
}

// No answer to a field: nothing, or nothing typed.
function isAbsent(value) {
  return value === undefined || value === null || value === "";
}

// Whether value is an answer to field: a value of its type.
function conforms(field, value) {
  if (isAbsent(value)) return false;
  if (field.choices) return field.choices.indexOf(value) !== -1;
  if (field.type === "integer") return Number.isInteger(value);
  if (field.type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "string" && value.length <= lengthLimit(field.prop);
}

// The text a field's control shows for value; "" for none.
function controlText(field, value) {
  return conforms(field, value) ? String(value) : "";
}

// The text a field's control starts with: the schema's default when it is
// a value of the field's type, else none. Nothing is preselected that the
// operator would not see and could not change.
function initialControlText(field) {
  return controlText(field, field.prop.default);
}

// How a choice reads on its control.
function choiceLabel(field, choice) {
  if (field.type === "boolean") return choice ? "Yes" : "No";
  return String(choice);
}

// A control's text read as its field's value: {absent: true} when nothing
// was given, {error} when the text is not a value of the type, else {value}.
function readControl(field, text) {
  var raw = text == null ? "" : String(text);
  if (field.choices) {
    if (raw === "") return { absent: true };
    for (var i = 0; i < field.choices.length; i++) {
      if (String(field.choices[i]) === raw) return { value: field.choices[i] };
    }
    return { error: "is not one of the choices" };
  }
  if (field.type === "integer" || field.type === "number") {
    if (raw.trim() === "") return { absent: true };
    var n = Number(raw);
    if (!Number.isFinite(n)) return { error: "must be a number" };
    if (field.type === "integer" && !Number.isInteger(n)) return { error: "must be a whole number" };
    return { value: n };
  }
  if (raw === "") return { absent: true };
  if (raw.length > lengthLimit(field.prop)) return { error: "is too long" };
  return { value: raw };
}

// The answer a form's controls stand for, and what keeps it from being
// sent. textOf(name) is the text of that field's control. A field left
// empty is absent from the content, never "", 0 or false.
function contentFromControls(schema, textOf) {
  var content = {};
  var errors = [];
  schemaFields(schema).forEach(function (field) {
    var got = readControl(field, textOf(field.name));
    if (got.error) errors.push(field.name + " " + got.error);
    else if (got.absent) { if (field.required) errors.push(field.name + " is required"); }
    else put(content, field.name, got.value);
  });
  return { content: content, errors: errors };
}

// Submitted content held to the requested schema: only its fields, each
// only with a value of its type. A value that is not one is dropped, never
// coerced; a required field left without a value makes the answer unusable
// (errors), so an incomplete form is never passed on as accepted.
function contentForSchema(schema, submitted) {
  var given = isPlainObject(submitted) ? submitted : {};
  var content = {};
  var errors = [];
  schemaFields(schema).forEach(function (field) {
    var value = Object.prototype.hasOwnProperty.call(given, field.name) ? given[field.name] : undefined;
    if (conforms(field, value)) put(content, field.name, value);
    else if (field.required) errors.push(field.name + " is required");
  });
  return { content: content, errors: errors };
}
// </shared-codec>

export {
  MAX_ANSWER_CHARS, requestMode, isOpenableUrl, lengthLimit, schemaFields, conforms, controlText,
  initialControlText, choiceLabel, readControl, contentFromControls, contentForSchema,
};

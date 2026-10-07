"use strict";

// The one definition of an MCP elicitation answer, shared by the server
// (./elicitation.js) and the card (lib/public/modules/prompt-kinds/): which
// requested schemas a form is drawn for, which fields such a schema asks
// for, what value each may take, how a form control's text reads as that
// value, and when a URL request may be approved. The body between the
// shared-codec markers is byte-identical in
// lib/public/modules/prompt-kinds/elicitation-codec.js, which wraps it as an
// ES module; test/shared-codecs.test.js holds the two copies to that.

// <shared-codec>
// Bound on typed text (lib/prompt-kinds/answer-limits.js applies the same).
var MAX_ANSWER_CHARS = 10000;
// Only a web page may be opened from a prompt.
var OPENABLE_PROTOCOLS = ["http:", "https:"];

// The requested-schema subset MCP elicitation defines, and the only one a
// form is drawn for: a flat object whose every property is a string
// (minLength, maxLength, format), a number or integer (minimum, maximum), a
// boolean, or a string enum (enum, enumNames), each with an optional title,
// description and default. Every keyword of the subset is enforced. A schema
// that uses anything else is refused whole, never drawn in part: a form
// that checks only some of what was asked would pass answers on as valid
// that the server never accepted.
var SCHEMA_KEYWORDS = ["$schema", "type", "title", "description", "properties", "required", "additionalProperties"];
var ANNOTATIONS = ["type", "title", "description", "default"];
var PROPERTY_KEYWORDS = {
  string: ANNOTATIONS.concat(["minLength", "maxLength", "format"]),
  enum: ANNOTATIONS.concat(["enum", "enumNames"]),
  number: ANNOTATIONS.concat(["minimum", "maximum"]),
  integer: ANNOTATIONS.concat(["minimum", "maximum"]),
  boolean: ANNOTATIONS,
};
var FORMATS = {
  email: { test: isEmail, error: "is not an email address" },
  uri: { test: isAbsoluteUri, error: "is not an absolute URI" },
  date: { test: isDate, error: "is not a date (YYYY-MM-DD)" },
  "date-time": { test: isDateTime, error: "is not a date and time (YYYY-MM-DDThh:mm:ssZ)" },
};
var DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
var DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isString(v) {
  return typeof v === "string";
}

// Whether table holds name itself (a name from a schema may be anything).
function holds(table, name) {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(table, name);
}

// Defined, not assigned, so a field named "__proto__" is a key.
function put(obj, key, value) {
  Object.defineProperty(obj, key, { value: value, enumerable: true, writable: true, configurable: true });
}

// A string's length as JSON Schema counts it: in characters, not UTF-16
// code units.
function textLength(s) {
  return Array.from(s).length;
}

function isEmail(v) {
  return /^[^\s@]+@[^\s@]+$/.test(v);
}

function isAbsoluteUri(v) {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(v)) return false;
  try {
    new URL(v);
    return true;
  } catch (e) {
    return false;
  }
}

function isCalendarDate(y, m, d) {
  var leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  var days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1];
}

function isDate(v) {
  var m = DATE.exec(v);
  return !!m && isCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

function isDateTime(v) {
  var m = DATE_TIME.exec(v);
  if (!m || !isCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) return false;
  if (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 60) return false;
  return m[8] === undefined || (Number(m[8]) <= 23 && Number(m[9]) <= 59);
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

function firstUnknown(obj, known) {
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    if (known.indexOf(keys[i]) === -1) return keys[i];
  }
  return null;
}

function isLength(v) {
  return v === undefined || (Number.isInteger(v) && v >= 0);
}

function isBound(v) {
  return v === undefined || (typeof v === "number" && Number.isFinite(v));
}

// Which subset property prop is: "string", "enum", "number", "integer" or
// "boolean"; null when it is none of them.
function subsetShape(prop) {
  if (!isPlainObject(prop)) return null;
  if (prop.enum !== undefined) return prop.type === "string" ? "enum" : null;
  return prop.type !== "enum" && holds(PROPERTY_KEYWORDS, prop.type) ? prop.type : null;
}

function propertyProblem(name, prop) {
  var shape = subsetShape(prop);
  if (!shape) return name + ": only a string, number, integer, boolean or string-enum field is supported";
  var unknown = firstUnknown(prop, PROPERTY_KEYWORDS[shape]);
  if (unknown !== null) return name + ": \"" + unknown + "\" is not supported";
  if (shape === "string") {
    if (!isLength(prop.minLength) || !isLength(prop.maxLength)) return name + ": minLength and maxLength must be whole numbers of 0 or more";
    if (prop.minLength > prop.maxLength) return name + ": minLength is above maxLength";
    if (prop.format !== undefined && !holds(FORMATS, prop.format)) return name + ": format must be email, uri, date or date-time";
  } else if (shape === "enum") {
    if (!Array.isArray(prop.enum) || !prop.enum.length || !prop.enum.every(isString)) return name + ": enum must list one or more strings";
    var names = prop.enumNames;
    if (names !== undefined && !(Array.isArray(names) && names.length === prop.enum.length && names.every(isString))) {
      return name + ": enumNames must name every enum value with a string";
    }
  } else if (shape === "number" || shape === "integer") {
    if (!isBound(prop.minimum) || !isBound(prop.maximum)) return name + ": minimum and maximum must be numbers";
    if (prop.minimum > prop.maximum) return name + ": minimum is above maximum";
  }
  return null;
}

// Why a form cannot be drawn for schema, or null when it can and every
// answer to it is checked in full. No schema asks for no fields.
function schemaProblem(schema) {
  if (schema === null || schema === undefined) return null;
  if (!isPlainObject(schema) || schema.type !== "object") return "the form is not an object schema";
  var unknown = firstUnknown(schema, SCHEMA_KEYWORDS);
  if (unknown !== null) return "\"" + unknown + "\" is not supported";
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    return "additionalProperties must be true or false";
  }
  if (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every(isString))) {
    return "required must list field names";
  }
  if (schema.properties === undefined) return null;
  if (!isPlainObject(schema.properties)) return "properties must be an object";
  var names = Object.keys(schema.properties);
  for (var i = 0; i < names.length; i++) {
    var problem = propertyProblem(names[i], schema.properties[names[i]]);
    if (problem) return problem;
  }
  return null;
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

// What keeps value, already of field's type, from answering field: the
// error to show, or null when nothing does.
function constraintError(field, value) {
  var prop = field.prop;
  if (field.type === "integer" || field.type === "number") {
    if (typeof prop.minimum === "number" && value < prop.minimum) return "must be at least " + prop.minimum;
    if (typeof prop.maximum === "number" && value > prop.maximum) return "must be at most " + prop.maximum;
    return null;
  }
  if (field.type !== "string") return null;
  if (value.length > MAX_ANSWER_CHARS || (Number.isInteger(prop.maxLength) && textLength(value) > prop.maxLength)) {
    return "is too long";
  }
  if (Number.isInteger(prop.minLength) && textLength(value) < prop.minLength) return "is too short";
  if (holds(FORMATS, prop.format) && !FORMATS[prop.format].test(value)) return FORMATS[prop.format].error;
  return null;
}

// Whether value is an answer to field: a value of its type that meets
// every constraint the field names.
function conforms(field, value) {
  if (isAbsent(value)) return false;
  if (field.choices) return field.choices.indexOf(value) !== -1;
  if (field.type === "integer") {
    if (!Number.isInteger(value)) return false;
  } else if (field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
  } else if (typeof value !== "string") {
    return false;
  }
  return constraintError(field, value) === null;
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

// How a choice reads on its control: an enum value by its enumNames entry
// when the schema gives one.
function choiceLabel(field, choice) {
  if (field.type === "boolean") return choice ? "Yes" : "No";
  var names = field.prop.enumNames;
  var at = field.choices ? field.choices.indexOf(choice) : -1;
  if (Array.isArray(names) && at !== -1 && typeof names[at] === "string") return names[at];
  return String(choice);
}

// A control's text read as its field's value: {absent: true} when nothing
// was given, {error} when the text is not a value of the type or misses a
// constraint, else {value}.
function readControl(field, text) {
  var raw = text == null ? "" : String(text);
  if (field.choices) {
    if (raw === "") return { absent: true };
    for (var i = 0; i < field.choices.length; i++) {
      if (String(field.choices[i]) === raw) return { value: field.choices[i] };
    }
    return { error: "is not one of the choices" };
  }
  var value = raw;
  if (field.type === "integer" || field.type === "number") {
    if (raw.trim() === "") return { absent: true };
    value = Number(raw);
    if (!Number.isFinite(value)) return { error: "must be a number" };
    if (field.type === "integer" && !Number.isInteger(value)) return { error: "must be a whole number" };
  } else if (raw === "") {
    return { absent: true };
  }
  var error = constraintError(field, value);
  return error ? { error: error } : { value: value };
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
// only with a value that answers it. A value that does not is dropped,
// never coerced; a required field left without a value makes the answer
// unusable (errors), so an incomplete form is never passed on as accepted.
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

module.exports = {
  MAX_ANSWER_CHARS: MAX_ANSWER_CHARS,
  requestMode: requestMode,
  isOpenableUrl: isOpenableUrl,
  schemaProblem: schemaProblem,
  lengthLimit: lengthLimit,
  schemaFields: schemaFields,
  conforms: conforms,
  controlText: controlText,
  initialControlText: initialControlText,
  choiceLabel: choiceLabel,
  readControl: readControl,
  contentFromControls: contentFromControls,
  contentForSchema: contentForSchema,
};

"use strict";

// Bounds on operator-typed answer text. The WebSocket accepts frames far
// larger than any answer (it also carries uploads), so each kind bounds the
// free text it hands to a vendor callback and records in history. A value
// over the bound is dropped rather than cut: an answer is never silently
// altered. The client enforces the same bound on its inputs.

var MAX_ANSWER_CHARS = 10000;

/**
 * The effective length limit for a field: the schema's own maxLength when it
 * is tighter, else MAX_ANSWER_CHARS.
 * @param {*} schemaMax
 * @returns {number}
 */
function lengthLimit(schemaMax) {
  return (Number.isInteger(schemaMax) && schemaMax >= 0 && schemaMax < MAX_ANSWER_CHARS) ? schemaMax : MAX_ANSWER_CHARS;
}

/**
 * value when it is a string within the limit, else null.
 * @param {*} value
 * @param {number} [limit]
 * @returns {?string}
 */
function boundedString(value, limit) {
  if (typeof value !== "string") return null;
  return value.length <= (limit == null ? MAX_ANSWER_CHARS : limit) ? value : null;
}

module.exports = {
  MAX_ANSWER_CHARS: MAX_ANSWER_CHARS,
  lengthLimit: lengthLimit,
  boundedString: boundedString,
};

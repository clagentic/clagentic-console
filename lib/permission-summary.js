"use strict";

// The short text that identifies a tool call to the operator: the body of a
// permission banner and push, and the summary list-sessions reports for a
// pending prompt. One source, so no surface shows more of a call than the
// banner does.

// Summary bound, in characters, ellipsis included.
var SUMMARY_MAX = 120;

// C0 and C1 controls (ESC, CR, LF, NUL, ...) and the Unicode line and
// paragraph separators. A summary is printed by a tool that may reach a
// terminal, so none of these may pass.
function isControl(code) {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

function pushBody(toolName, input) {
  if (!input) return "";
  var text = "";
  if (toolName === "Bash" && input.command) {
    text = input.command;
  } else if (toolName === "Edit" && input.file_path) {
    text = input.file_path.split(/[/\\]/).pop() + ": " + (input.old_string || "").substring(0, 40) + " " + String.fromCharCode(0x2192) + " " + (input.new_string || "").substring(0, 40);
  } else if (toolName === "Write" && input.file_path) {
    text = input.file_path;
  } else if (input.file_path) {
    text = input.file_path;
  } else if (input.command) {
    text = input.command;
  } else if (input.url) {
    text = input.url;
  } else if (input.query) {
    text = input.query;
  } else if (input.pattern) {
    text = input.pattern;
  } else if (input.description) {
    text = input.description;
  }
  if (text.length > 120) text = text.substring(0, 120) + "...";
  return text;
}

function oneLine(text) {
  var out = "";
  for (var i = 0; i < text.length; i++) {
    out += isControl(text.charCodeAt(i)) ? " " : text.charAt(i);
  }
  return out.replace(/ {2,}/g, " ").trim();
}

// A single printable line of at most SUMMARY_MAX characters. A non-string
// field of a hostile input is not a summary.
function summarize(toolName, input) {
  var body;
  try {
    body = pushBody(toolName, input);
  } catch (e) {
    return "";
  }
  if (typeof body !== "string") return "";
  var line = oneLine(body);
  if (line.length > SUMMARY_MAX) line = line.slice(0, SUMMARY_MAX - 3) + "...";
  return line;
}

module.exports = { pushBody: pushBody, summarize: summarize, SUMMARY_MAX: SUMMARY_MAX };

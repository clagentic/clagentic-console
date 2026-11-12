"use strict";

// The short text that identifies a tool call to the operator: the body of a
// permission banner and push, and the summary list-sessions reports for a
// pending prompt. One source, so no surface shows more of a call than the
// banner does.

var codecs = require("./prompt-kinds/codecs");

// Summary bound, in characters, ellipsis included.
var SUMMARY_MAX = 120;

// The command with its leading environment assignments shortened to their
// names, so a bounded summary shows the command they prefix. A non-string
// command is passed through for summarize() to refuse.
function headOf(command) {
  if (typeof command !== "string") return command;
  var shared = codecs.commandSummary();
  return shared.oneLine(shared.commandHead(command));
}

function pushBody(toolName, input) {
  if (!input) return "";
  var text = "";
  if (toolName === "Bash" && input.command) {
    text = headOf(input.command);
  } else if (toolName === "Edit" && input.file_path) {
    text = input.file_path.split(/[/\\]/).pop() + ": " + (input.old_string || "").substring(0, 40) + " " + String.fromCharCode(0x2192) + " " + (input.new_string || "").substring(0, 40);
  } else if (toolName === "Write" && input.file_path) {
    text = input.file_path;
  } else if (input.file_path) {
    text = input.file_path;
  } else if (input.command) {
    text = headOf(input.command);
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
  var line = codecs.commandSummary().oneLine(body);
  if (line.length > SUMMARY_MAX) line = line.slice(0, SUMMARY_MAX - 3) + "...";
  return line;
}

module.exports = { pushBody: pushBody, summarize: summarize, SUMMARY_MAX: SUMMARY_MAX };

"use strict";

// AskUserQuestion: the operator answers one or more multiple-choice
// questions, or skips them. The prompt's id is the tool-use id, so the card
// drawn from the tool call and the prompt are the same request on every
// client and in every recorded history.
//
// What an answer is - chosen labels, "Other" text, how it reaches the CLI's
// tool - is defined once, in ./ask-user-codec.js, which the card shares.

var toolCall = require("./tool-call");
var codec = require("./ask-user-codec");

module.exports = {
  name: "ask_user",
  scope: "session",
  store: "pendingAskUser",
  journal: true,
  idFromToolUse: true,

  fields: function (req) {
    return { input: req.input || {} };
  },

  requestFields: function (record) {
    return { input: record.input || {} };
  },

  decisions: ["answer", "skip"],

  // A multi-select answer travels and is recorded as the list of chosen
  // labels, so a replayed card can show exactly what was chosen. A response
  // with no usable answer left is a skip: the tool is never handed an empty
  // answer set the operator did not give.
  parse: function (msg, record) {
    if (msg.decision === "skip") return { skipped: true };
    var answers = codec.normalizeAnswers(record && record.input, msg.answers);
    return Object.keys(answers).length ? { answers: answers } : { skipped: true };
  },

  outcome: function (record, response) {
    if (response.skipped) return toolCall.deny("The user skipped the question.");
    // Both spellings: the SDK passes the object through and the stdio
    // permission handler reads the snake_case key.
    var updatedInput = Object.assign({}, record.input, { answers: codec.toolAnswers(record.input, response.answers) });
    return { behavior: "allow", updatedInput: updatedInput, updated_input: updatedInput };
  },

  grantsSession: function () { return false; },

  resolvedFields: function (response) {
    return response.skipped ? { skipped: true } : { answers: response.answers };
  },

  cancelled: function () {
    return toolCall.deny("Cancelled");
  },
};

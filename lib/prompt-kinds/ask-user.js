"use strict";

// AskUserQuestion: the operator answers one or more multiple-choice
// questions, or skips them. The prompt's id is the tool-use id, so the card
// drawn from the tool call and the prompt are the same request on every
// client and in every recorded history.

var toolCall = require("./tool-call");

function plainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

// The client keys answers by question index; the CLI's AskUserQuestion tool
// expects them keyed by question text.
function textKeyedAnswers(input, answers) {
  var questions = (input && Array.isArray(input.questions)) ? input.questions : [];
  var out = {};
  for (var i = 0; i < questions.length; i++) {
    var text = questions[i] && questions[i].question;
    if (text && answers[i] != null) out[text] = answers[i];
  }
  return out;
}

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

  parse: function (msg) {
    if (msg.decision === "skip") return { skipped: true };
    return { answers: plainObject(msg.answers) };
  },

  outcome: function (record, response) {
    if (response.skipped) return toolCall.deny("The user skipped the question.");
    // Both spellings: the SDK passes the object through and the stdio
    // permission handler reads the snake_case key.
    var updatedInput = Object.assign({}, record.input, { answers: textKeyedAnswers(record.input, response.answers) });
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

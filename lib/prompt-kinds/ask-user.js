"use strict";

// AskUserQuestion: the operator answers one or more multiple-choice
// questions, or skips them. The prompt's id is the tool-use id, so the card
// drawn from the tool call and the prompt are the same request on every
// client and in every recorded history.

var toolCall = require("./tool-call");
var limits = require("./answer-limits");

// A multi-select answer travels and is recorded as the list of chosen labels,
// so a replayed card can show exactly what was chosen; the CLI's tool takes
// one string per question, joined the way the CLI itself joins them.
var MULTI_SELECT_SEPARATOR = ", ";

function plainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function questionsOf(input) {
  return (input && Array.isArray(input.questions)) ? input.questions : [];
}

function optionLabels(question) {
  return (question && Array.isArray(question.options) ? question.options : [])
    .map(function (opt) { return opt && opt.label; })
    .filter(function (label) { return typeof label === "string"; });
}

// One question's answer as the operator gave it, or null when it is not a
// usable answer to that question: chosen labels (multi-select only, each one
// of the question's options), or non-blank text within the length bound.
function validAnswer(question, value) {
  if (Array.isArray(value)) {
    if (!question || !question.multiSelect) return null;
    var labels = optionLabels(question);
    var picked = [];
    value.forEach(function (label) {
      if (labels.indexOf(label) !== -1 && picked.indexOf(label) === -1) picked.push(label);
    });
    return picked.length ? picked : null;
  }
  var text = limits.boundedString(value);
  return text && text.trim() ? text.trim() : null;
}

// Answers keyed by question index, limited to the questions asked.
function validAnswers(input, answers) {
  var out = {};
  questionsOf(input).forEach(function (question, i) {
    var answer = validAnswer(question, answers[i]);
    if (answer !== null) out[i] = answer;
  });
  return out;
}

// The client keys answers by question index; the CLI's AskUserQuestion tool
// expects them keyed by question text.
function textKeyedAnswers(input, answers) {
  var questions = questionsOf(input);
  var out = {};
  for (var i = 0; i < questions.length; i++) {
    var text = questions[i] && questions[i].question;
    if (!text || answers[i] == null) continue;
    out[text] = Array.isArray(answers[i]) ? answers[i].join(MULTI_SELECT_SEPARATOR) : answers[i];
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

  // A response with no usable answer left is a skip: the tool is never handed
  // an empty answer set the operator did not give.
  parse: function (msg, record) {
    if (msg.decision === "skip") return { skipped: true };
    var answers = validAnswers(record && record.input, plainObject(msg.answers));
    return Object.keys(answers).length ? { answers: answers } : { skipped: true };
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

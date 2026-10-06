// ask-user-codec.js - the one definition of an AskUserQuestion answer, shared
// by the card (this directory) and the server (lib/prompt-kinds/ask-user.js).
//
// The body between the shared-codec markers is byte-identical in
// lib/prompt-kinds/ask-user-codec.js, which wraps it for require();
// test/shared-codecs.test.js holds the two copies to that. The server runs
// on Node versions that cannot require() an ES module, hence two wrappers
// around one body.

// <shared-codec>
// How the CLI joins several labels into the one string its tool takes for
// a question; older histories recorded that joined string.
var MULTI_SELECT_SEPARATOR = ", ";
// Bound on "Other" text (lib/prompt-kinds/answer-limits.js applies the same).
var MAX_ANSWER_CHARS = 10000;

function questionList(input) {
  return input && Array.isArray(input.questions) ? input.questions : [];
}

// A question's choices: its option labels, each once, in the order first
// offered. Options sharing a label are one choice, because the tool is
// answered with the label and cannot tell them apart.
function choiceLabels(question) {
  var out = [];
  var options = question && Array.isArray(question.options) ? question.options : [];
  for (var i = 0; i < options.length; i++) {
    var label = options[i] && options[i].label;
    if (typeof label === "string" && out.indexOf(label) === -1) out.push(label);
  }
  return out;
}

// One question's answer as the operator gave it, or null when it is not a
// usable answer to that question: for a multi-select question the chosen
// labels (each one of its choices, once, in the order given); else non-blank
// text within the bound, trimmed (a choice's label or "Other" text).
function normalizeAnswer(question, value) {
  if (Array.isArray(value)) {
    if (!question || !question.multiSelect) return null;
    var labels = choiceLabels(question);
    var picked = [];
    for (var i = 0; i < value.length; i++) {
      if (labels.indexOf(value[i]) !== -1 && picked.indexOf(value[i]) === -1) picked.push(value[i]);
    }
    return picked.length ? picked : null;
  }
  if (typeof value !== "string" || value.length > MAX_ANSWER_CHARS) return null;
  var text = value.trim();
  return text ? text : null;
}

// Every usable answer, keyed by question index, limited to the questions
// asked.
function normalizeAnswers(input, answers) {
  var out = {};
  var given = answers && typeof answers === "object" && !Array.isArray(answers) ? answers : {};
  var questions = questionList(input);
  for (var i = 0; i < questions.length; i++) {
    var answer = normalizeAnswer(questions[i], given[i]);
    if (answer !== null) out[i] = answer;
  }
  return out;
}

// The answer a card's state stands for: the chosen labels of a multi-select
// question (in choice order), the chosen label of any other, else the
// "Other" text; null when the operator gave nothing.
function answerFromCard(question, chosen, other) {
  var labels = choiceLabels(question).filter(function (label) { return chosen.indexOf(label) !== -1; });
  if (labels.length) return normalizeAnswer(question, question && question.multiSelect ? labels : labels[0]);
  return normalizeAnswer(question, other == null ? "" : String(other));
}

// One answer as the single string the CLI's tool takes.
function answerText(value) {
  return Array.isArray(value) ? value.join(MULTI_SELECT_SEPARATOR) : String(value);
}

// The answers keyed by question text, as the CLI's AskUserQuestion tool
// takes them. Questions that share their text share that one slot; each
// answer is kept, in question order, rather than the last one winning.
function toolAnswers(input, answers) {
  var out = {};
  var questions = questionList(input);
  for (var i = 0; i < questions.length; i++) {
    var text = questions[i] && questions[i].question;
    if (typeof text !== "string" || !text || answers[i] == null) continue;
    var value = answerText(answers[i]);
    var prior = Object.prototype.hasOwnProperty.call(out, text) ? out[text] : null;
    // Defined, not assigned, so a question text such as "__proto__" is a key.
    Object.defineProperty(out, text, {
      value: prior === null ? value : prior + MULTI_SELECT_SEPARATOR + value,
      enumerable: true, writable: true, configurable: true,
    });
  }
  return out;
}

// The labels an older history's joined multi-select answer was made of, or
// null when value is not a join of distinct choices (it was "Other" text).
// Labels may themselves contain the separator, so every split is tried.
function splitJoinedLabels(value, labels) {
  function from(pos, used) {
    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      if (!label || used.indexOf(label) !== -1 || value.indexOf(label, pos) !== pos) continue;
      var end = pos + label.length;
      if (end === value.length) return used.concat([label]);
      if (value.indexOf(MULTI_SELECT_SEPARATOR, end) !== end) continue;
      var rest = from(end + MULTI_SELECT_SEPARATOR.length, used.concat([label]));
      if (rest) return rest;
    }
    return null;
  }
  return value ? from(0, []) : null;
}

// What a recorded answer shows on a card: the choices it selects and the
// "Other" text it carries (one or the other).
function readAnswer(question, value) {
  var labels = choiceLabels(question);
  if (Array.isArray(value)) {
    return { labels: labels.filter(function (label) { return value.indexOf(label) !== -1; }), other: "" };
  }
  var text = value == null ? "" : String(value);
  if (labels.indexOf(text) !== -1) return { labels: [text], other: "" };
  var joined = question && question.multiSelect ? splitJoinedLabels(text, labels) : null;
  return joined ? { labels: labels.filter(function (label) { return joined.indexOf(label) !== -1; }), other: "" } : { labels: [], other: text };
}
// </shared-codec>

export {
  MULTI_SELECT_SEPARATOR, MAX_ANSWER_CHARS, choiceLabels, normalizeAnswer, normalizeAnswers,
  answerFromCard, answerText, toolAnswers, readAnswer,
};

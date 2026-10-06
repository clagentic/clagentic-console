// AskUserQuestion card: one or more multiple-choice questions with an
// "Other" field, answered with Submit or skipped. The prompt's id is the
// tool-use id. The shell (prompts.js, prompt-card.js) owns its state; this
// module draws the questions and, once answered, the answer summary.
//
// An answer is a label or the "Other" text (a string), or, for a
// multi-select question, the list of chosen labels. The list is sent and
// recorded as a list, so a replayed card shows exactly what was chosen; the
// server joins it for the CLI.

// Same bound the server applies (lib/prompt-kinds/answer-limits.js).
var MAX_ANSWER_CHARS = 10000;
// How the CLI joins multi-select labels; older histories recorded the
// joined string.
var MULTI_SELECT_SEPARATOR = ", ";

function optionLabels(q) {
  return (q && q.options ? q.options : []).map(function (opt) { return opt.label; });
}

function collectAnswers(questions, answers, multiSelections) {
  var result = {};
  for (var i = 0; i < questions.length; i++) {
    var chosen = multiSelections[i];
    if (questions[i].multiSelect && chosen && chosen.size > 0) {
      result[i] = optionLabels(questions[i]).filter(function (label) { return chosen.has(label); });
    } else if (answers[i]) {
      result[i] = answers[i];
    }
  }
  return result;
}

// The labels an older history's joined multi-select answer was made of, or
// null when value is not a join of distinct option labels (it was "Other"
// text). Labels may themselves contain the separator, so every split is
// tried.
function splitJoinedLabels(value, labels) {
  function from(pos, used) {
    if (pos === value.length) return used;
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

/**
 * The option labels a recorded answer selects, and the "Other" text it
 * carries (one or the other), for a question.
 * @param {object} q - the question.
 * @param {string|string[]} value - the recorded answer.
 * @returns {{labels: string[], other: string}}
 */
export function readAnswer(q, value) {
  var labels = optionLabels(q);
  if (Array.isArray(value)) {
    return { labels: value.filter(function (v) { return labels.indexOf(v) !== -1; }), other: "" };
  }
  var text = String(value);
  if (labels.indexOf(text) !== -1) return { labels: [text], other: "" };
  var joined = q && q.multiSelect ? splitJoinedLabels(text, labels) : null;
  return joined ? { labels: joined, other: "" } : { labels: [], other: text };
}

function answerText(value) {
  return Array.isArray(value) ? value.join(MULTI_SELECT_SEPARATOR) : String(value);
}

function isLocked(container) {
  return container.classList.contains("resolved") || container.classList.contains("sending");
}

function showAnswerSummary(container, questions, answers) {
  if (!answers || Object.keys(answers).length === 0) return;
  if (container.querySelector(".ask-user-answer-summary")) return;
  var summary = document.createElement("div");
  summary.className = "ask-user-answer-summary";
  Object.keys(answers).forEach(function (key) {
    var qi = parseInt(key, 10);
    var row = document.createElement("div");
    row.className = "ask-user-answer-row";
    var labelEl = document.createElement("span");
    labelEl.className = "ask-user-answer-label";
    labelEl.textContent = (questions[qi] && questions[qi].question) ? questions[qi].question : "Answer";
    var valueEl = document.createElement("span");
    valueEl.className = "ask-user-answer-value";
    valueEl.textContent = answerText(answers[key]);
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    summary.appendChild(row);
  });
  container.appendChild(summary);
}

// Reflect recorded answers in the options, so a replayed card reads the
// same as the one the operator answered: exactly the chosen options are
// selected, and only an "Other" answer fills the text field.
function markSelections(container, questions, answers) {
  var questionEls = container.querySelectorAll(".ask-user-question");
  Object.keys(answers).forEach(function (key) {
    var qIdx = parseInt(key, 10);
    var qEl = questionEls[qIdx];
    if (!qEl) return;
    var read = readAnswer(questions[qIdx], answers[key]);
    var options = qEl.querySelectorAll(".ask-user-option");
    for (var i = 0; i < options.length; i++) {
      var labelEl = options[i].querySelector(".option-label");
      var chosen = !!labelEl && read.labels.indexOf(labelEl.textContent) !== -1;
      if (chosen) options[i].classList.add("selected");
      else options[i].classList.remove("selected");
    }
    var otherInput = qEl.querySelector(".ask-user-other input");
    if (otherInput) otherInput.value = read.other;
  });
}

function drawQuestion(container, q, qIdx, state, submit) {
  var qDiv = document.createElement("div");
  qDiv.className = "ask-user-question";
  if (q.header) {
    var qHeader = document.createElement("div");
    qHeader.className = "ask-user-question-header";
    qHeader.textContent = q.header;
    qDiv.appendChild(qHeader);
  }
  var qText = document.createElement("div");
  qText.className = "ask-user-question-text";
  qText.textContent = q.question || "";
  qDiv.appendChild(qText);

  var optionsDiv = document.createElement("div");
  optionsDiv.className = "ask-user-options";
  var isMulti = q.multiSelect || false;
  if (isMulti) state.multiSelections[qIdx] = new Set();

  (q.options || []).forEach(function (opt) {
    var btn = document.createElement("button");
    btn.className = "ask-user-option";
    var labelEl = document.createElement("div");
    labelEl.className = "option-label";
    labelEl.textContent = opt.label;
    btn.appendChild(labelEl);
    if (opt.description) {
      var descEl = document.createElement("div");
      descEl.className = "option-desc";
      descEl.textContent = opt.description;
      btn.appendChild(descEl);
    }
    if (opt.markdown) {
      var pre = document.createElement("pre");
      pre.className = "option-markdown";
      pre.textContent = opt.markdown;
      btn.appendChild(pre);
    }
    btn.addEventListener("click", function () {
      if (isLocked(container)) return;
      // Choosing an option replaces any "Other" answer.
      var other = qDiv.querySelector(".ask-user-other input");
      if (other) other.value = "";
      if (isMulti) {
        delete state.answers[qIdx];
        var set = state.multiSelections[qIdx];
        if (set.has(opt.label)) {
          set.delete(opt.label);
          btn.classList.remove("selected");
        } else {
          set.add(opt.label);
          btn.classList.add("selected");
        }
        return;
      }
      optionsDiv.querySelectorAll(".ask-user-option").forEach(function (b) { b.classList.remove("selected"); });
      btn.classList.add("selected");
      state.answers[qIdx] = opt.label;
    });
    optionsDiv.appendChild(btn);
  });
  qDiv.appendChild(optionsDiv);

  var otherDiv = document.createElement("div");
  otherDiv.className = "ask-user-other";
  var otherInput = document.createElement("input");
  otherInput.type = "text";
  otherInput.placeholder = "Other...";
  otherInput.maxLength = MAX_ANSWER_CHARS;
  otherInput.addEventListener("input", function () {
    if (isLocked(container)) return;
    var text = otherInput.value.trim();
    // An emptied field is no answer: Submit must not send what was typed
    // before it was cleared.
    if (!text) {
      delete state.answers[qIdx];
      return;
    }
    optionsDiv.querySelectorAll(".ask-user-option").forEach(function (b) { b.classList.remove("selected"); });
    if (isMulti) state.multiSelections[qIdx] = new Set();
    state.answers[qIdx] = text;
  });
  otherInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  otherDiv.appendChild(otherInput);
  qDiv.appendChild(otherDiv);
  container.appendChild(qDiv);
}

export default {
  kind: "ask_user",

  draw: function (fields, requestId, host) {
    var questions = (fields.input && fields.input.questions) || [];
    var container = document.createElement("div");
    container.className = "ask-user-container";
    container.dataset.requestId = requestId;
    container.dataset.toolId = requestId;

    var state = { answers: {}, multiSelections: {} };
    function submit() {
      if (isLocked(container)) return;
      var result = collectAnswers(questions, state.answers, state.multiSelections);
      if (Object.keys(result).length === 0) return;
      host.respond(container, { answers: result });
    }
    questions.forEach(function (q, qIdx) { drawQuestion(container, q, qIdx, state, submit); });

    var submitBtn = document.createElement("button");
    submitBtn.className = "ask-user-submit";
    submitBtn.textContent = "Submit";
    submitBtn.addEventListener("click", submit);
    container.appendChild(submitBtn);

    var skipBtn = document.createElement("button");
    skipBtn.className = "ask-user-skip";
    skipBtn.textContent = "Skip";
    skipBtn.addEventListener("click", function () {
      if (!isLocked(container)) host.respond(container, { decision: "skip" });
    });
    container.appendChild(skipBtn);

    host.setMainInputDisabled(true);
    return container;
  },

  outcome: function (state) {
    if (state.skipped) return { text: "Skipped", tone: "denied" };
    return { text: "Answered", tone: "allowed" };
  },

  // An answered card shows the answers; any other ending shows its label.
  settle: function (container, state, fields, outcome, host) {
    container.classList.add("answered");
    host.setMainInputDisabled(false);
    var questions = (fields.input && fields.input.questions) || [];
    if (state.state === "resolved" && state.answers && Object.keys(state.answers).length) {
      showAnswerSummary(container, questions, state.answers);
      markSelections(container, questions, state.answers);
      return;
    }
    if (!container.querySelector(".ask-user-status")) {
      var status = document.createElement("div");
      status.className = "ask-user-status permission-decision-label";
      status.textContent = outcome.text;
      container.appendChild(status);
    }
  },
};

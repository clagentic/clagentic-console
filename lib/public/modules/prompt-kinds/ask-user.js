// AskUserQuestion card: one or more multiple-choice questions with an
// "Other" field, answered with Submit or skipped. The prompt's id is the
// tool-use id. The shell (prompts.js, prompt-card.js) owns its state; this
// module draws the questions and, once answered, the answer summary.
//
// What an answer is - chosen labels or "Other" text, how a multi-select
// answer is listed, how options sharing a label count as one choice, how a
// recorded answer reads back - is the shared codec's (./ask-user-codec.js,
// which the server holds answers to). A multi-select answer is sent and
// recorded as a list, so a replayed card shows exactly what was chosen; the
// server joins it for the CLI.

import { MAX_ANSWER_CHARS, answerFromCard, answerText, readAnswer } from './ask-user-codec.js';

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

// Every option whose label is chosen shows as selected, and no other: the
// live card and a replayed one draw selection the same way.
function showChosen(qEl, labels) {
  var options = qEl.querySelectorAll(".ask-user-option");
  for (var i = 0; i < options.length; i++) {
    var labelEl = options[i].querySelector(".option-label");
    if (labelEl && labels.indexOf(labelEl.textContent) !== -1) options[i].classList.add("selected");
    else options[i].classList.remove("selected");
  }
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
    showChosen(qEl, read.labels);
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
  state.chosen[qIdx] = [];
  state.other[qIdx] = "";

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
      state.other[qIdx] = "";
      var chosen = state.chosen[qIdx];
      if (!isMulti) state.chosen[qIdx] = [opt.label];
      else if (chosen.indexOf(opt.label) !== -1) state.chosen[qIdx] = chosen.filter(function (l) { return l !== opt.label; });
      else state.chosen[qIdx] = chosen.concat([opt.label]);
      showChosen(qDiv, state.chosen[qIdx]);
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
    // An emptied field is no answer: Submit must not send what was typed
    // before it was cleared.
    state.other[qIdx] = otherInput.value;
    if (!otherInput.value.trim()) return;
    state.chosen[qIdx] = [];
    showChosen(qDiv, []);
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

    // Per question index: the chosen labels and the "Other" text.
    var state = { chosen: {}, other: {} };
    function submit() {
      if (isLocked(container)) return;
      var result = {};
      questions.forEach(function (q, qIdx) {
        var answer = answerFromCard(q, state.chosen[qIdx] || [], state.other[qIdx]);
        if (answer !== null) result[qIdx] = answer;
      });
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

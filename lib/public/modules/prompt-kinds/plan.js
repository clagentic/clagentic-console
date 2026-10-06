// Plan approval card (ExitPlanMode): approve into a fresh context, approve
// with edits auto-accepted, approve with manual edit approval, reject, or
// reject with feedback. The shell (prompts.js, prompt-card.js) owns its state.

import { iconHtml } from '../icons.js';

function button(className, html, onClick) {
  var btn = document.createElement("button");
  btn.className = className;
  btn.innerHTML = html;
  btn.addEventListener("click", onClick);
  return btn;
}

var LABELS = {
  allow_accept_edits: { text: "Approved (auto-accept)", tone: "allowed" },
  allow_clear_context: { text: "Approved (clear + auto-accept)", tone: "allowed" },
  deny_with_feedback: { text: "Feedback sent", tone: "denied" },
  deny: { text: "Denied", tone: "denied" },
};

export default {
  kind: "plan",

  draw: function (fields, requestId, host) {
    var container = document.createElement("div");
    container.className = "permission-container plan-permission";
    container.dataset.requestId = requestId;

    var header = document.createElement("div");
    header.className = "permission-header plan-permission-header";
    header.innerHTML =
      '<span class="permission-icon">' + iconHtml("check-circle") + '</span>' +
      '<span class="permission-title">Plan Approval</span>';

    // The plan itself is already rendered above the card.
    var body = document.createElement("div");
    body.className = "permission-body";

    var actions = document.createElement("div");
    actions.className = "permission-actions plan-permission-actions";
    var contextPct = host.getContextPercent();
    actions.appendChild(button("permission-btn plan-btn-clear",
      iconHtml("refresh-cw") + ' <span>Clear context' +
        (contextPct > 0 ? ' <span class="plan-ctx-pct">(' + contextPct + '% used)</span>' : '') +
        ' &amp; auto-accept</span>',
      function () {
        var response = { decision: "allow_clear_context" };
        var planContent = host.getPlanContent();
        if (planContent) response.planContent = planContent;
        host.respond(container, response);
      }));
    actions.appendChild(button("permission-btn permission-allow", "Auto-accept edits", function () {
      host.respond(container, { decision: "allow_accept_edits" });
    }));
    actions.appendChild(button("permission-btn permission-allow-session", "Manually approve", function () {
      host.respond(container, { decision: "allow" });
    }));
    actions.appendChild(button("permission-btn permission-deny", "Reject", function () {
      host.respond(container, { decision: "deny" });
    }));

    var feedbackRow = document.createElement("div");
    feedbackRow.className = "plan-feedback-row";
    var feedbackInput = document.createElement("input");
    feedbackInput.type = "text";
    feedbackInput.className = "plan-feedback-input";
    feedbackInput.placeholder = "Tell Claude what to change...";
    var feedbackSendBtn = button("plan-feedback-send", iconHtml("arrow-up"), function () {
      submitFeedback();
    });
    feedbackSendBtn.disabled = true;
    function submitFeedback() {
      var text = feedbackInput.value.trim();
      if (text) host.respond(container, { decision: "deny_with_feedback", feedback: text });
    }
    feedbackInput.addEventListener("input", function () {
      feedbackSendBtn.disabled = !feedbackInput.value.trim();
    });
    feedbackInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && feedbackInput.value.trim()) {
        e.preventDefault();
        submitFeedback();
      }
    });
    feedbackRow.appendChild(feedbackInput);
    feedbackRow.appendChild(feedbackSendBtn);

    container.appendChild(header);
    container.appendChild(body);
    container.appendChild(actions);
    container.appendChild(feedbackRow);
    return container;
  },

  focusSelector: ".plan-feedback-input",

  outcome: function (state) {
    if (LABELS[state.decision]) return LABELS[state.decision];
    return { text: "Allowed", tone: "allowed" };
  },
};

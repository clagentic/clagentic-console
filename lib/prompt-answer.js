"use strict";

// prompt-answer.js - answers one pending operator prompt for the answer-prompt
// verb. The answer goes through the prompt registry's respond(), the call a
// browser answer takes, so the kind validates it, the resolution effects run
// and the settle is recorded with its source; this module only finds the
// prompt and shapes the decision into the message the browser would have sent
// for that kind.
//
// Exactly once is the registry's: respond() settles a prompt or reports it
// stale, and it runs without yielding, so a browser answer and this one cannot
// both win.

var { promptsFor } = require("./prompt-registry");
var promptKinds = require("./prompt-kinds");
var codecs = require("./prompt-kinds/codecs");

var RESULT = Object.freeze({
  ANSWERED: "answered",
  NOT_FOUND: "not-found",
  ALREADY_SETTLED: "already-settled",
  INVALID: "invalid",
});

// Words that are verbs about a prompt, never the text of an answer.
var VERBS = ["allow", "allow_always", "deny"];

// History events that end a prompt, by the field that names its request.
var SETTLED_EVENTS = {
  prompt_resolved: "requestId",
  permission_resolved: "requestId",
  elicitation_resolved: "requestId",
  prompt_cancel: "requestId",
  permission_cancel: "requestId",
  ask_user_answered: "toolId",
};

function invalid(reason) {
  return { invalid: reason };
}

// The message the browser sends for a decision on this kind of prompt, or
// { invalid } when the kind does not accept the decision. The registry's own
// parse() is more forgiving (an unknown permission decision reads as a deny), so
// the words are checked here: a typo must leave the prompt pending, not deny it.
function shapeDecision(prompt, decision) {
  switch (prompt.kind) {
    case "permission":
      if (VERBS.indexOf(decision) === -1) return invalid("a permission prompt takes allow, allow_always or deny");
      return { decision: decision };
    case "plan": {
      var planKind = promptKinds.KINDS.plan;
      if (decision === "deny_with_feedback") return invalid("a plan rejected with feedback needs the feedback text, which this verb does not carry; use deny");
      if (VERBS.indexOf(decision) === -1 && planKind.decisions.indexOf(decision) === -1) {
        return invalid("a plan takes " + planKind.decisions.filter(function (d) { return d !== "deny_with_feedback"; }).concat(["allow_always"]).join(", "));
      }
      return { decision: decision };
    }
    case "ask_user": {
      if (decision === "skip") return { decision: "skip" };
      if (VERBS.indexOf(decision) !== -1) return invalid("a question takes the answer text, or skip");
      var input = prompt.request && prompt.request.input;
      if (!input || !Array.isArray(input.questions) || input.questions.length !== 1) {
        return invalid("this prompt asks several questions at once; this verb answers a single question, or skips");
      }
      var answers = { 0: decision };
      if (!Object.keys(codecs.askUser().normalizeAnswers(input, answers)).length) {
        return invalid("the answer is empty or too long");
      }
      return { answers: answers };
    }
    case "elicitation":
      if (decision === "allow") return { action: "accept" };
      if (decision === "deny") return { action: "reject" };
      return invalid("a request for input takes allow or deny");
    default:
      return invalid("this kind of prompt is not answered with a decision");
  }
}

// Whether the session's recorded history shows the prompt as settled, and by
// whom: { settled, source }. A prompt that is not pending and was never
// recorded is unknown, not settled.
function settledInHistory(session, requestId) {
  var history = session && Array.isArray(session.history) ? session.history : [];
  for (var i = history.length - 1; i >= 0; i--) {
    var e = history[i];
    var field = e && SETTLED_EVENTS[e.type];
    if (field && e[field] === requestId) return { settled: true, source: e.source || null };
  }
  return { settled: false, source: null };
}

function outcome(result, requestId, kind, source, extra) {
  var out = Object.assign({ ok: result === RESULT.ANSWERED, result: result, requestId: requestId, kind: kind || null, source: source }, extra || {});
  return out;
}

// req: { session, requestId, decision, source }
// session is the live session the request names. Returns the outcome object:
// { ok, result, requestId, kind, source, reason? }. Never resolves a prompt of
// another session, and never throws for a request that cannot be answered.
function answerPrompt(req) {
  var session = req.session;
  var registry = promptsFor(req.sm);
  var found = registry.lookup(req.requestId, session);

  if (!found || found.session !== session) {
    var history = settledInHistory(session, req.requestId);
    if (history.settled) {
      return outcome(RESULT.ALREADY_SETTLED, req.requestId, null, req.source, {
        reason: "the request is already settled",
        settledBy: history.source,
      });
    }
    return outcome(RESULT.NOT_FOUND, req.requestId, null, req.source, { reason: "no pending request with this id in the session" });
  }

  var kind = found.prompt.kind;
  if (!promptKinds.operatorMayAnswer(kind)) {
    return outcome(RESULT.NOT_FOUND, req.requestId, kind, req.source, { reason: "a request of kind " + kind + " is not answered by an operator" });
  }
  var shaped = shapeDecision(found.prompt, req.decision);
  if (shaped.invalid) return outcome(RESULT.INVALID, req.requestId, kind, req.source, { reason: shaped.invalid });

  var settled = registry.respond(req.requestId, shaped, {
    session: session,
    kinds: [kind],
    responder: null,
    source: req.source,
  });
  if (settled.status === "resolved") return outcome(RESULT.ANSWERED, req.requestId, kind, req.source);
  if (settled.status === "invalid") {
    return outcome(RESULT.INVALID, req.requestId, kind, req.source, { reason: String(settled.reason) });
  }
  // Settled between the lookup and the answer: the prompt is gone and its
  // settle is in the history.
  var after = settledInHistory(session, req.requestId);
  return outcome(RESULT.ALREADY_SETTLED, req.requestId, kind, req.source, {
    reason: "the request is already settled",
    settledBy: after.source,
  });
}

module.exports = { answerPrompt: answerPrompt, shapeDecision: shapeDecision, RESULT: RESULT };

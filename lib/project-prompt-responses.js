"use strict";

// One WS entry point for every operator-prompt answer. The registry
// (lib/prompt-registry.js) settles the prompt; this module maps the wire
// message onto respond() and owns the session side effects a plan decision
// carries (permission mode, a fresh session, a feedback message). Those are
// installed as the registry's resolution effects, so an answer from any path
// (this handler, the push notification's HTTP route) applies them.
//
// prompt_response is the message every current client sends. The older
// per-kind messages are accepted as aliases so a page loaded before an
// upgrade can still answer; each alias is declared in lib/ws-schema.js.

var { promptsFor } = require("./prompt-registry");
var { mayAnswerPrompt } = require("./prompt-access");
var { ownValue } = require("./prompt-kinds/own-key");

// alias type -> { toPrompt(msg), kinds it may answer, stale reply type }
var LEGACY_RESPONSES = {
  permission_response: {
    toPrompt: function (msg) {
      return { requestId: msg.requestId, decision: msg.decision, feedback: msg.feedback, planContent: msg.planContent };
    },
    kinds: ["permission", "plan"],
    staleReplyType: "permission_cancel",
  },
  ask_user_response: {
    toPrompt: function (msg) { return { requestId: msg.toolId, answers: msg.answers }; },
    kinds: ["ask_user"],
    staleReplyType: "prompt_cancel",
  },
  elicitation_response: {
    toPrompt: function (msg) {
      return { requestId: msg.requestId, action: msg.action, content: msg.content };
    },
    kinds: ["elicitation"],
    staleReplyType: "prompt_cancel",
  },
};

var CONFIG_STATE_DEFAULTS = { effort: "medium", thinking: "adaptive", thinkingBudget: 10000 };

/**
 * ctx fields: sm, sdk, send, sendTo, sendToSession, getSessionForWs,
 *   onProcessingChanged, ensureProjectAccessForSession
 */
function attachPromptResponses(ctx) {
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var sendToSession = ctx.sendToSession;
  var getSessionForWs = ctx.getSessionForWs;
  var onProcessingChanged = ctx.onProcessingChanged || function () {};
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;

  function sendConfigState() {
    send({
      type: "config_state",
      model: sm.currentModel || "",
      mode: sm.currentPermissionMode,
      effort: sm.currentEffort || CONFIG_STATE_DEFAULTS.effort,
      betas: sm.currentBetas || [],
      thinking: sm.currentThinking || CONFIG_STATE_DEFAULTS.thinking,
      thinkingBudget: sm.currentThinkingBudget || CONFIG_STATE_DEFAULTS.thinkingBudget,
    });
  }

  // A user message delivered to the session as if typed, starting a query
  // when none is running.
  function deliverUserMessage(session, text) {
    var userMsg = { type: "user_message", text: text };
    sm.recordHistoryEntry(session, userMsg, true);
    sm.appendToSessionFile(session, userMsg);
    sendToSession(session.localId, userMsg);
    if (session.isProcessing) {
      sdk.pushMessage(session, text);
      return;
    }
    session.isProcessing = true;
    onProcessingChanged();
    session.sentToolResults = {};
    sendToSession(session.localId, { type: "status", status: "processing" });
    if (!session.queryInstance && !session.worker) {
      sdk.startQuery(session, text, undefined, ensureProjectAccessForSession(session));
    } else {
      sdk.pushMessage(session, text);
    }
  }

  // Ends the current session's turn and starts a fresh session that executes
  // the approved plan with edits auto-accepted. ws is the answering
  // connection, or null for an answer that did not come over a socket.
  function executePlanInFreshContext(ws, session, prompt, planContent) {
    // Deferred to the next tick so the SDK's deny write, scheduled as a
    // microtask by the settle above, completes before the abort; aborting
    // synchronously kills the subprocess mid-write ("Operation aborted").
    session.isProcessing = false;
    onProcessingChanged();
    promptsFor(sm).cancelSession(session, "cleared");
    sm.broadcastSessionList();
    setImmediate(function () {
      if (session.abortController) session.abortController.abort();
    });

    sm.currentPermissionMode = "acceptEdits";
    sendConfigState();

    var planPrompt;
    if (planContent) {
      planPrompt = "Execute the following plan. Do NOT re-enter plan mode -- just implement it step by step.\n\n" + planContent;
    } else {
      var toolInput = prompt.request.toolInput;
      var planFilePath = (toolInput && toolInput.planFilePath) || "";
      planPrompt = "Execute the plan in " + planFilePath + ". Do NOT re-enter plan mode -- read the plan file and implement it step by step.";
    }

    var oldStreamPromise = session.streamPromise || Promise.resolve();
    Promise.race([
      oldStreamPromise,
      new Promise(function (resolve) { setTimeout(resolve, 3000); }),
    ]).then(function () {
      try {
        var newSession = sm.createSession(null, ws);
        var userMsg = { type: "user_message", text: planPrompt, planContent: planContent || null };
        sm.recordHistoryEntry(newSession, userMsg, true);
        sm.appendToSessionFile(newSession, userMsg);
        newSession.title = "Plan execution (cleared context)";
        sm.saveSessionFile(newSession);
        sm.broadcastSessionList();
        sendToSession(newSession.localId, userMsg);

        newSession.isProcessing = true;
        onProcessingChanged();
        newSession.sentToolResults = {};
        sendToSession(newSession.localId, { type: "status", status: "processing" });
        newSession.acceptEditsAfterStart = true;
        sdk.startQuery(newSession, planPrompt, undefined, ensureProjectAccessForSession(newSession));
      } catch (e) {
        console.error("[project] Error starting plan execution:", e);
        if (ws) sendTo(ws, { type: "error", text: "Failed to start plan execution: " + (e.message || e) });
      }
    }).catch(function (e) {
      console.error("[project] Plan execution stream wait failed:", e.message || e);
    });
  }

  function applyPlanDecision(ws, session, prompt, response) {
    if (response.decision === "allow_accept_edits") {
      sdk.setPermissionMode(session, "acceptEdits");
      sm.currentPermissionMode = "acceptEdits";
      sendConfigState();
    } else if (response.decision === "allow_clear_context") {
      executePlanInFreshContext(ws, session, prompt, response.planContent || "");
    } else if (response.decision === "deny_with_feedback" && response.feedback) {
      // Lets the denied turn wind down before the feedback arrives as the
      // next message.
      setTimeout(function () { deliverUserMessage(session, response.feedback); }, 200);
    }
  }

  function mayAnswer(ws, requestId) {
    var found = promptsFor(sm).lookup(requestId, getSessionForWs(ws));
    return mayAnswerPrompt(ws && ws._clagenticUser, found && found.session);
  }

  promptsFor(sm).onResolved(function (outcome, responder) {
    if (outcome.kind === "plan" && outcome.session) {
      applyPlanDecision(responder, outcome.session, outcome.prompt, outcome.response);
    }
  });

  function answer(ws, msg, kinds, staleReplyType) {
    var outcome = mayAnswer(ws, msg.requestId)
      ? promptsFor(sm).respond(msg.requestId, msg, { session: getSessionForWs(ws), kinds: kinds, responder: ws })
      : { status: "stale" };
    if (outcome.status === "resolved") return;
    // Refused as it stands: still pending, so re-offer it to the responder,
    // whose card goes back to answerable instead of waiting out its ack.
    if (outcome.status === "invalid") {
      if (outcome.pending) sendTo(ws, outcome.pending);
      return;
    }
    // Gone: answered elsewhere, ended with its turn or query, or never
    // existed. Tell the responder so its card stops looking actionable; the
    // registry retires any banner offering it.
    var reply = { type: staleReplyType, requestId: msg.requestId, reason: "stale" };
    if (staleReplyType === "prompt_cancel" && kinds.length === 1) reply.kind = kinds[0];
    sendTo(ws, reply);
  }

  /** Returns true when msg was a prompt answer (handled). */
  function handlePromptMessage(ws, msg) {
    if (msg.type === "prompt_response") {
      // The kind is required: a response is only applied to the kind it was
      // written for.
      answer(ws, msg, [msg.kind], "prompt_cancel");
      return true;
    }
    var legacy = ownValue(LEGACY_RESPONSES, msg.type);
    if (legacy) {
      answer(ws, legacy.toPrompt(msg), legacy.kinds, legacy.staleReplyType);
      return true;
    }
    return false;
  }

  return { handlePromptMessage: handlePromptMessage };
}

module.exports = { attachPromptResponses: attachPromptResponses };

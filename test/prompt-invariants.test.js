"use strict";
// Model-based invariant harness for the operator-prompt lifecycle, over every
// prompt kind: tool permissions, plan approval, AskUserQuestion and MCP
// elicitation.
//
// Generates interleavings of everything that touches a prompt - top-level and
// sub-agent prompts, Task spawn/notification/result, the parent turn's
// result, query end, WS answers from several clients (the current
// prompt_response and the older per-kind aliases), HTTP answers, aborts,
// disconnect/reconnect, history paging, user messages between request and
// answer, and daemon restart - against the real server modules (see
// prompt-harness-world.js) and the real client card code, and after every
// step checks:
//
//   I1  the server re-presents exactly the prompts it can still answer
//   I2  a prompt the server no longer holds never shows live controls on any
//       client, and no notification still offers it
//   I3  a pending prompt is answerable on every connected client
//   I4  an answer settles a pending prompt exactly once, with the operator's
//       answer; an answer to anything else is answered as stale
//   I5  Deny (or skip, or reject), and every ending that is not an answer,
//       stops the call
//   I6  only the prompt's own scope ends it: a top-level prompt may end with
//       its turn, a tracked sub-agent's prompt not with its parent's turn,
//       every prompt with its query (the vendor cancels the callbacks of a
//       closed query), and every prompt with the daemon
//   I7  Allow for Session auto-approves the same grant key afterwards, across
//       turns and restart, and nothing else
//   I8  every prompt that ends records exactly one terminal event
//
// Set CLAGENTIC_PROMPT_HARNESS_LIB to another checkout's lib/ to run the
// wire-level checks against it; the client render layer always exercises
// this checkout's tools.js, so it is skipped for a foreign lib. The named
// scenarios below are the shapes behind past regressions; `npm run
// test:prompt-history` runs them against the commits before and after each
// fix.

var test = require("node:test");
var assert = require("node:assert/strict");
var world = require("./prompt-harness-world");
var dom = require("./fake-dom-prompt-cards");

var RENDER = !world.overridesLib;

var ASK_INPUT = { questions: [{ question: "Which target?", options: [{ label: "staging" }, { label: "prod" }] }] };

var PROMPTS = [
  { key: "Bash", kind: "permission", toolName: "Bash", input: { command: "deploy --prod" } },
  { key: "Write", kind: "permission", toolName: "Write", input: { file_path: "/srv/app/config.yml" } },
  { key: "Skill:alpha", kind: "permission", toolName: "Skill", input: { skill: "alpha" } },
  { key: "Skill:beta", kind: "permission", toolName: "Skill", input: { skill: "beta" } },
  { key: "Plan", kind: "plan", toolName: "ExitPlanMode", input: { plan: "ship it" } },
  { key: "Ask", kind: "ask_user", toolName: "AskUserQuestion", input: ASK_INPUT },
  {
    key: "Elicit", kind: "elicitation",
    request: { serverName: "deploy", message: "Token?", mode: "form", requestedSchema: { type: "object", properties: { token: { type: "string" } } } },
  },
];
var BY_KIND = {};
PROMPTS.forEach(function (p) { if (!BY_KIND[p.kind]) BY_KIND[p.kind] = p; });

// Answers per kind, the card control that gives each, and whether it lets
// the call proceed.
var ANSWERS = {
  permission: {
    allow: { selector: ".permission-allow, .perm-allow", allows: true },
    allow_always: { selector: ".permission-allow-session, .perm-always", allows: true },
    deny: { selector: ".permission-deny, .perm-deny", allows: false },
  },
  plan: {
    allow: { selector: ".permission-allow-session", allows: true },
    allow_accept_edits: { selector: ".permission-allow", allows: true },
    deny: { selector: ".permission-deny", allows: false },
  },
  ask_user: {
    answer: { allows: true },
    skip: { selector: ".ask-user-skip", allows: false },
  },
  elicitation: {
    accept: { selector: ".permission-allow", allows: true },
    reject: { selector: ".permission-deny", allows: false },
  },
};

// The WS message a client without a usable card sends: the current shape,
// or the older per-kind alias.
function responseMessage(kind, requestId, answer, legacy) {
  if (legacy) {
    if (kind === "permission" || kind === "plan") return { type: "permission_response", requestId: requestId, decision: answer };
    if (kind === "ask_user" && answer === "answer") return { type: "ask_user_response", toolId: requestId, answers: { 0: "prod" } };
    if (kind === "elicitation") return { type: "elicitation_response", requestId: requestId, action: answer, content: {} };
  }
  var msg = { type: "prompt_response", requestId: requestId, kind: kind };
  if (kind === "ask_user") {
    if (answer === "skip") msg.decision = "skip";
    else msg.answers = { 0: "prod" };
  } else if (kind === "elicitation") {
    msg.action = answer;
    msg.content = {};
  } else {
    msg.decision = answer;
  }
  return msg;
}

function allows(outcome) {
  return !!outcome && (outcome.behavior === "allow" || outcome.action === "accept");
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// --- what a client may conclude from the wire alone, in any recorded shape --

var OPENERS = { prompt_request: 1, permission_request: 1, elicitation_request: 1 };
var PENDING = { prompt_pending: 1, permission_request_pending: 1 };
var ENDINGS = { prompt_resolved: 1, prompt_cancel: 1, permission_resolved: 1, permission_cancel: 1, elicitation_resolved: 1 };

function isAskTool(msg) {
  return msg.type === "tool_executing" && msg.name === "AskUserQuestion";
}

function promptIdOf(msg) {
  if (isAskTool(msg)) return msg.id;
  if (msg.type === "ask_user_answered") return msg.toolId;
  return msg.requestId;
}

function isPromptMessage(msg) {
  return !!(OPENERS[msg.type] || PENDING[msg.type] || ENDINGS[msg.type] || msg.type === "ask_user_answered" || isAskTool(msg));
}

function isEnding(msg) {
  return !!(ENDINGS[msg.type] || msg.type === "ask_user_answered");
}

// A prompt is over once any message says so.
function wireApply(known, msg) {
  var id = promptIdOf(msg);
  if (!id || known[id] === "settled") return;
  if (isEnding(msg)) {
    known[id] = "settled";
  } else if (OPENERS[msg.type] || isAskTool(msg)) {
    var st = msg.promptState || msg.permissionState;
    known[id] = (msg.settled === true || (st && st.state !== "pending")) ? "settled" : "pending";
  } else if (PENDING[msg.type]) {
    known[id] = known[id] || "pending";
  }
}

function Harness(label) {
  this.label = label;
  this.log = [];
  this.violations = [];
  this.requests = {};
  this.order = [];
  this.tasks = {};
  this.taskSeq = 0;
  this.toolSeq = 0;
  this.granted = {};
  this.op = null;
  this.queryGen = 0;
  this.clients = [];
  this.terminalEvents = {};
}

Harness.prototype.fail = function (msg) {
  this.violations.push("[" + this.label + "] after " + this.op + ": " + msg);
};

Harness.prototype.init = async function (clientCount) {
  this.server = await world.createServer();
  await this.server.startQuery();
  var self = this;
  // Never disconnects: counts live terminal events per prompt for I8.
  this.auditor = this.makeClient("auditor");
  for (var i = 0; i < clientCount; i++) this.clients.push(await this.addViewClient("client-" + i));
  this.connectAuditor();
  this.clients.forEach(function (c) { self.server.connect(c.ws); });
  await this.settle();
};

// The replay a connect sends is history, not new events; I8 counts only
// events broadcast as they happen.
Harness.prototype.connectAuditor = function () {
  this.server.connect(this.auditor.ws);
  this.auditor.inbox.length = 0;
};

Harness.prototype.makeClient = function (name) {
  var client = { name: name, inbox: [], known: {}, view: null, historyFrom: 0, connected: true };
  client.ws = { readyState: 1, _clagenticUser: null, send: function (data) { client.inbox.push(JSON.parse(data)); } };
  return client;
};

Harness.prototype.addViewClient = async function (name) {
  var self = this;
  var client = this.makeClient(name);
  if (RENDER) {
    // One tools.js instance per client name, reset for each run.
    client.view = await dom.createClient(name, function (body) {
      self.server.handlers.handleSessionsMessage(client.ws, JSON.parse(body));
      return true;
    });
  }
  return client;
};

Harness.prototype.applyToView = function (client, msg) {
  if (client.view && isPromptMessage(msg)) client.view.tools.applyPromptMessage(msg);
};

Harness.prototype.drain = function (client) {
  while (client.inbox.length) {
    var msg = client.inbox.shift();
    if (msg.type === "session_switched") {
      client.known = {};
      if (client.view) {
        client.view.messagesEl.innerHTML = "";
        client.view.tools.resetToolState();
        client.view.tools.clearPromptStates();
      }
    } else if (msg.type === "history_meta") {
      client.historyFrom = msg.from;
    } else if (msg.type === "history_prepend") {
      client.historyFrom = msg.meta.from;
      var saved = client.view ? client.view.tools.saveToolState() : null;
      if (client.view) client.view.tools.resetToolState();
      for (var i = 0; i < msg.items.length; i++) {
        var it = msg.items[i];
        if (!isPromptMessage(it)) continue;
        wireApply(client.known, it);
        this.applyToView(client, it);
      }
      if (client.view) client.view.tools.restoreToolState(saved);
    } else if (isPromptMessage(msg)) {
      if (client === this.auditor && isEnding(msg) && msg.reason !== "stale") {
        var id = promptIdOf(msg);
        this.terminalEvents[id] = (this.terminalEvents[id] || 0) + 1;
      }
      wireApply(client.known, msg);
      this.applyToView(client, msg);
    }
  }
};

Harness.prototype.settle = async function () {
  await world.flush();
  this.drain(this.auditor);
  for (var i = 0; i < this.clients.length; i++) this.drain(this.clients[i]);
};

Harness.prototype.pending = function () {
  var self = this;
  return this.order.map(function (id) { return self.requests[id]; }).filter(function (r) { return !r.settled && !r.dead; });
};

Harness.prototype.liveTasks = function () {
  var self = this;
  return Object.keys(this.tasks).filter(function (t) { return self.tasks[t] === "live"; });
};

// The model of the registry's Task tracking: a running Task, or one that
// ended while its sub-agent still had a prompt open, until that settles.
Harness.prototype.taskTracked = function (taskId) {
  if (!taskId) return false;
  if (this.tasks[taskId] === "live") return true;
  if (this.tasks[taskId] !== "ended") return false;
  return this.pending().some(function (r) { return r.owner === taskId; });
};

// Tasks that own nothing are forgotten when their query ends or a new one
// starts.
Harness.prototype.forgetIdleTasks = function () {
  var self = this;
  Object.keys(this.tasks).forEach(function (t) {
    if (!self.pending().some(function (r) { return r.owner === t; })) delete self.tasks[t];
  });
};

// --- operations ----------------------------------------------------------

Harness.prototype.request = async function (prompt, ownerTask) {
  var self = this;
  if (prompt.kind === "elicitation") {
    // An elicitation is never tied to a tool call, so it has no owner.
    ownerTask = null;
    if (!this.server.canElicit) return null;
  }
  this.op = "request " + prompt.key + (ownerTask ? " by " + ownerTask : "");
  var session = this.server.session;
  var toolUseId = "tu-" + (++this.toolSeq);
  if (ownerTask) {
    this.server.sdk({
      yokeType: "subagent_message",
      parentToolUseId: ownerTask,
      messageRole: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: prompt.toolName, input: prompt.input }],
    });
  }
  var before = this.server.heldPromptIds();
  // The live query issues the signal and cancels it when it closes.
  var abort = this.server.issueSignal();
  var promise = prompt.kind === "elicitation"
    ? this.server.bridge.handleElicitation(session, prompt.request, { signal: abort.signal })
    : this.server.bridge.handleCanUseTool(session, prompt.toolName, prompt.input, { toolUseID: toolUseId, signal: abort.signal });
  var opened = this.server.heldPromptIds().filter(function (id) { return before.indexOf(id) === -1; });

  var grantable = prompt.kind === "permission";
  if (grantable && this.granted[prompt.key] && opened.length === 0) {
    var auto = await promise;
    if (!allows(auto)) this.fail(prompt.key + " was granted for the session but was not auto-approved (I7)");
    await this.settle();
    return null;
  }
  // A granted key that prompts anyway is still a live prompt from here on.
  if (grantable && this.granted[prompt.key]) this.fail(prompt.key + " was granted for the session but prompted again (I7)");
  else if (opened.length !== 1) {
    this.fail(prompt.key + " did not open exactly one prompt (I7); opened " + opened.length);
    await this.settle();
    return null;
  }
  var r = {
    id: opened[0], prompt: prompt, kind: prompt.kind, owner: ownerTask || null, abort: abort,
    query: this.queryGen, settled: false, dead: false, outcome: null, cause: null, scopedBefore: false,
  };
  this.requests[r.id] = r;
  this.order.push(r.id);
  promise.then(function (outcome) {
    if (r.dead) return;
    r.settled = true;
    r.outcome = outcome;
    r.cause = self.op;
    r.endedBy = self.op;
  });
  await this.settle();
  return r;
};

Harness.prototype.spawnTask = async function () {
  var id = "task-" + (++this.taskSeq);
  this.op = "spawn " + id;
  this.server.sdk({ yokeType: "tool_start", blockId: 0, toolId: id, toolName: "Task" });
  this.server.sdk({ yokeType: "block_stop", blockId: 0 });
  this.tasks[id] = "live";
  await this.settle();
  return id;
};

Harness.prototype.taskNotification = async function (taskId) {
  this.op = "task_notification " + taskId;
  this.server.sdk({ yokeType: "task_notification", parentToolId: taskId, taskId: taskId + "-sdk", status: "completed" });
  this.tasks[taskId] = "ended";
  await this.settle();
};

Harness.prototype.taskToolResult = async function (taskId) {
  this.op = "Task tool_result " + taskId;
  this.server.sdk({ yokeType: "message", messageRole: "user", content: [{ type: "tool_result", tool_use_id: taskId, content: "done" }] });
  this.tasks[taskId] = "ended";
  await this.settle();
};

Harness.prototype.turnResult = async function () {
  this.op = "turn result";
  this.server.sdk({ yokeType: "result", cost: 0.01, duration: 10, sessionId: "cli" });
  await this.settle();
};

// The query ends. Closing it makes the vendor cancel every callback it still
// had waiting, a backgrounded sub-agent's included (the fake query handle
// aborts the signals it issued, as the Claude SDK does; the worker relay and
// the Codex adapter report the same on their query's end), so every prompt of
// this query must end, denied and recorded.
Harness.prototype.queryEnd = async function () {
  this.op = QUERY_END;
  var gen = this.queryGen;
  var self = this;
  await this.server.endQuery();
  await this.settle();
  this.order.forEach(function (id) {
    var r = self.requests[id];
    if (r.query !== gen || r.settled || r.dead) return;
    self.fail(id + " outlived the vendor cancelling it (I5)");
  });
  this.forgetIdleTasks();
  this.queryGen++;
  this.op = "query restart";
  await this.server.startQuery();
  await this.settle();
};

Harness.prototype.respond = async function (client, r, answer) {
  this.op = client.name + " " + answer + " " + r.id;
  var wasPending = !r.settled && !r.dead;
  this.drain(client);
  var clicked = false;
  if (client.view && client.connected) clicked = this.clickAnswer(client, r, answer);
  if (!clicked) {
    var legacy = world.overridesLib || this.toolSeq % 2 === 0;
    var msg = responseMessage(r.kind, r.id, answer, legacy);
    if (msg.type !== "prompt_response" || !world.overridesLib) {
      this.server.handlers.handleSessionsMessage(client.ws, msg);
    }
  }
  var replies = client.inbox.filter(function (m) { return isEnding(m) && promptIdOf(m) === r.id; });
  await this.settle();
  if (client.connected) {
    var stale = replies.some(function (m) { return m.reason === "stale"; });
    var resolved = replies.some(function (m) { return m.type !== "prompt_cancel" && m.type !== "permission_cancel"; });
    if (replies.length === 0) this.fail(client.name + "'s answer to " + r.id + " got no reply (I4)");
    else if (!wasPending && !stale) this.fail(client.name + "'s answer to ended " + r.id + " was not answered as stale (I4)");
    else if (wasPending && !resolved) this.fail(client.name + "'s answer to pending " + r.id + " was not answered with its resolution (I4)");
  }
  this.checkAnswer(r, wasPending, answer);
};

// Answers through the client's own card when it offers the control.
Harness.prototype.clickAnswer = function (client, r, answer) {
  var card = dom.cardFor(client.view, r.id);
  if (!card) return false;
  if (r.kind === "ask_user" && answer === "answer") {
    var option = card.querySelectorAll(".ask-user-option")[1];
    var submit = card.querySelector(".ask-user-submit");
    if (!option || !submit || option.disabled || submit.disabled) return false;
    option.click();
    submit.click();
    return true;
  }
  var button = card.querySelector(ANSWERS[r.kind][answer].selector);
  if (!button || button.disabled) return false;
  button.click();
  return true;
};

Harness.prototype.httpRespond = async function (r, decision) {
  this.op = "HTTP " + decision + " " + r.id;
  var wasPending = !r.settled && !r.dead;
  var status = await this.server.httpRespond(r.id, decision);
  await this.settle();
  var toolApproval = r.kind === "permission" || r.kind === "plan";
  var want = decision === "allow_always" ? 400 : (wasPending && toolApproval ? 200 : 404);
  if (status !== want) this.fail("HTTP " + decision + " for " + r.kind + " " + r.id + " returned " + status + ", want " + want + " (I4)");
  if (status === 200) this.checkAnswer(r, wasPending, decision);
  else if (wasPending && r.settled) this.fail("a refused HTTP " + decision + " ended " + r.id + " (I4)");
};

Harness.prototype.checkAnswer = function (r, wasPending, answer) {
  if (!wasPending) return;
  if (!r.settled) { this.fail("a " + answer + " for pending " + r.id + " did not settle it (I4)"); return; }
  var spec = ANSWERS[r.kind][answer];
  if (allows(r.outcome) !== spec.allows) {
    this.fail(r.id + " (" + r.kind + ") answered " + answer + " resolved as " + JSON.stringify(r.outcome) + " (I5)");
  } else if (spec.allows && (r.kind === "permission" || r.kind === "plan") &&
      JSON.stringify(r.outcome.updatedInput) !== JSON.stringify(r.prompt.input)) {
    this.fail(r.id + " was allowed with a different input than requested (I4)");
  }
  if (r.kind === "permission" && answer === "allow_always") this.granted[r.prompt.key] = true;
};

Harness.prototype.abortPrompt = async function (r) {
  this.op = "abort " + r.id;
  var wasPending = !r.settled && !r.dead;
  r.abort.abort();
  await this.settle();
  if (wasPending && !(r.settled && !allows(r.outcome))) this.fail("aborting " + r.id + " did not stop the call (I5)");
};

Harness.prototype.disconnect = async function (client) {
  this.op = "disconnect " + client.name;
  this.server.disconnect(client.ws);
  client.connected = false;
  if (client.view) client.view.tools.restoreUnconfirmedPrompts("Connection lost.");
  await this.settle();
};

Harness.prototype.reconnect = async function (client) {
  this.op = "reconnect " + client.name;
  client.connected = true;
  this.server.connect(client.ws);
  await this.settle();
};

Harness.prototype.pageOlder = async function (client) {
  this.op = "page older " + client.name;
  if (client.historyFrom > 0) {
    this.server.handlers.handleSessionsMessage(client.ws, { type: "load_more_history", before: client.historyFrom });
  }
  await this.settle();
};

Harness.prototype.userMessage = async function (chatter) {
  this.op = "user message + " + chatter + " deltas";
  this.server.record({ type: "user_message", text: "while the card is open" });
  for (var i = 0; i < chatter; i++) this.server.record({ type: "delta", text: "x" });
  await this.settle();
};

// The daemon goes away and comes back. Nothing survives it, so every prompt
// still open must be ended, denied and recorded on the way down.
Harness.prototype.restart = async function () {
  this.op = "daemon restart";
  var self = this;
  var home = this.server.home;
  var cliSessionId = this.server.session.cliSessionId;
  var open = this.pending();
  this.server.shutdown();
  await world.flush();
  this.drain(this.auditor);
  this.clients.forEach(function (c) { self.drain(c); });
  open.forEach(function (r) {
    if (!r.settled) {
      r.dead = true;
      self.fail(r.id + " (" + r.kind + ") was still open when its daemon went away: nothing denied it or recorded its end (I5/I8)");
    }
  });
  this.tasks = {};
  this.server = await world.createServer({ home: home, cliSessionId: cliSessionId });
  this.queryGen++;
  await this.server.startQuery();
  this.connectAuditor();
  this.clients.forEach(function (c) { if (c.connected) self.server.connect(c.ws); });
  await this.settle();
};

// --- invariants ----------------------------------------------------------

var OPERATOR_CAUSE = /^(client-\d+|HTTP) /;
var QUERY_END = "query end";

Harness.prototype.check = function () {
  var self = this;
  var snapshot = this.server.pendingSnapshot();
  this.drain(this.auditor);
  var notified = this.server.notifiedRequestIds();

  this.order.forEach(function (id) {
    var r = self.requests[id];
    var live = !r.settled && !r.dead;

    if (live !== (snapshot.indexOf(id) !== -1)) {
      self.fail(id + " (" + r.kind + ")" + (live ? " is still awaiting the operator but the server no longer offers it (I1)" : " is over but the server still offers it (I1)"));
    }
    if (!live && notified.indexOf(id) !== -1) self.fail(id + " is over but its notification still offers buttons (I2)");

    if (r.settled && r.cause) {
      var cause = r.cause;
      var aimedHere = cause.slice(-(id.length + 1)) === " " + id;
      var byOperator = aimedHere && (OPERATOR_CAUSE.test(cause) || cause.indexOf("abort ") === 0);
      if (!byOperator) {
        if (allows(r.outcome)) self.fail(id + " ended by '" + cause + "' without stopping the call (I5)");
        var scopeEnd = cause === "daemon restart" || cause === QUERY_END ||
          (cause === "turn result" && !r.scopedBefore);
        if (!scopeEnd) self.fail(id + " (" + r.kind + ", owner " + (r.owner || "top-level") + ") was ended by '" + cause + "', outside its scope (I6)");
      }
      r.cause = null;
    }
    if (r.settled && (self.terminalEvents[id] || 0) !== 1) {
      self.fail(id + " ended with " + (self.terminalEvents[id] || 0) + " terminal events recorded, want 1 (I8)");
    }

    self.clients.forEach(function (c) {
      if (!c.connected) return;
      var known = c.known[id];
      if (live && known !== "pending") self.fail(c.name + " is not offered pending " + id + " (I3)");
      if (!live && known === "pending") self.fail(c.name + " still sees " + id + " as pending after it ended (I2)");
      if (!c.view) return;
      var card = dom.cardFor(c.view, id);
      var controls = card ? dom.liveControls(card).length : 0;
      if (live && controls === 0) self.fail(c.name + " has no answerable card for pending " + id + " (I3)");
      if (!live && controls > 0) self.fail(c.name + " renders live controls for ended " + id + " (I2)");
    });
  });
  if (this.server.heldPromptIds().some(function (id) { return !self.requests[id]; })) {
    this.fail("the server holds a prompt the harness never opened");
  }
};

Harness.prototype.step = async function (fn) {
  var self = this;
  // Whether a tracked sub-agent owns each prompt, as the op begins: that is
  // what decides whether the op's turn or query boundary may end it.
  this.pending().forEach(function (r) { r.scopedBefore = self.taskTracked(r.owner); });
  await fn();
  this.log.push(this.op);
  this.check();
};

Harness.prototype.close = function () {
  this.server.shutdown();
  world.removeHome(this.server.home);
};

Harness.prototype.assertClean = function () {
  assert.deepEqual(this.violations, [], "ops: " + this.log.join(" | "));
};

// --- random interleavings -------------------------------------------------

// How each prompt ended across a whole random run; a run that never
// exercises a path proves nothing about it.
function tallyEndings(h, tally) {
  h.order.forEach(function (id) {
    var r = h.requests[id];
    tally.opened++;
    tally["kind:" + r.kind]++;
    if (r.owner) tally.subagent++;
    if (r.dead) tally.dead++;
    else if (!r.settled) tally.open++;
    else if (OPERATOR_CAUSE.test(r.endedBy)) tally.operator++;
    else if (r.endedBy === "turn result") tally.turn++;
    else if (r.endedBy === QUERY_END) tally.query++;
    else if (r.endedBy === "daemon restart") tally.restart++;
    else if (r.endedBy.indexOf("abort ") === 0) tally.aborted++;
  });
}

async function randomRun(seed, steps, tally) {
  var rnd = mulberry32(seed);
  function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
  var h = new Harness("seed " + seed);
  await h.init(3);
  try {
    for (var s = 0; s < steps && h.violations.length === 0; s++) {
      var roll = rnd();
      var pending = h.pending();
      var live = h.liveTasks();
      var any = h.order.map(function (id) { return h.requests[id]; }).filter(function (r) { return !r.dead; });
      var connected = h.clients.filter(function (c) { return c.connected; });
      var offline = h.clients.filter(function (c) { return !c.connected; });
      var client = pick(h.clients);
      if (roll < 0.18) await h.step(function () { return h.request(pick(PROMPTS), null); });
      else if (roll < 0.30 && live.length) await h.step(function () { return h.request(pick(PROMPTS), pick(live)); });
      else if (roll < 0.36) await h.step(function () { return h.spawnTask(); });
      else if (roll < 0.40 && live.length) await h.step(function () { return h.taskNotification(pick(live)); });
      else if (roll < 0.43 && live.length) await h.step(function () { return h.taskToolResult(pick(live)); });
      else if (roll < 0.50) await h.step(function () { return h.turnResult(); });
      else if (roll < 0.66 && any.length && connected.length) {
        var target = pending.length && rnd() < 0.8 ? pick(pending) : pick(any);
        var answer = pick(Object.keys(ANSWERS[target.kind]).concat(target.kind === "permission" ? ["deny"] : []));
        var who = pick(connected);
        await h.step(function () { return h.respond(who, target, answer); });
      } else if (roll < 0.69 && any.length) {
        var hTarget = pick(any);
        var hDecision = pick(["allow", "allow_always", "deny"]);
        await h.step(function () { return h.httpRespond(hTarget, hDecision); });
      } else if (roll < 0.72 && pending.length) {
        var aTarget = pick(pending);
        await h.step(function () { return h.abortPrompt(aTarget); });
      } else if (roll < 0.77 && connected.length > 1) {
        var dc = pick(connected);
        await h.step(function () { return h.disconnect(dc); });
      } else if (roll < 0.82 && offline.length) {
        var rc = pick(offline);
        await h.step(function () { return h.reconnect(rc); });
      } else if (roll < 0.88 && client.connected) {
        await h.step(function () { return h.pageOlder(client); });
      } else if (roll < 0.95) {
        var chatter = Math.floor(rnd() * 70);
        await h.step(function () { return h.userMessage(chatter); });
      } else if (roll < 0.98) {
        await h.step(function () { return h.queryEnd(); });
      } else {
        await h.step(function () { return h.restart(); });
      }
    }
    h.assertClean();
    tallyEndings(h, tally);
  } finally {
    h.close();
  }
}

if (RENDER) {
  test.before(async function () {
    dom.setupGlobals();
    var storeMod = await import(dom.moduleUrl("store.js"));
    storeMod.createStore({ connected: true });
  });
}

var SEEDS = 150;
var STEPS = 40;

test("random interleavings keep every prompt invariant, for every kind", { timeout: 300000 }, async function (t) {
  // Card ack timers must not fire in wall-clock time mid-run.
  if (RENDER) t.mock.timers.enable({ apis: ["setTimeout"] });
  var tally = {
    opened: 0, subagent: 0, open: 0, dead: 0, operator: 0, turn: 0, query: 0, restart: 0, aborted: 0,
    "kind:permission": 0, "kind:plan": 0, "kind:ask_user": 0, "kind:elicitation": 0,
  };
  for (var seed = 1; seed <= SEEDS; seed++) {
    await randomRun(seed, STEPS, tally);
  }
  t.diagnostic("prompt endings across " + SEEDS + " runs: " + JSON.stringify(tally));
  Object.keys(tally).forEach(function (k) {
    if (k === "dead") return;
    assert.ok(tally[k] > 0, "the random runs never produced a prompt that is '" + k + "': " + JSON.stringify(tally));
  });
  assert.equal(tally.dead, 0, "every prompt open at a restart was ended by it");
});

// --- named interleavings: the shapes behind past regressions -------------

async function scenario(t, label, clientCount, body) {
  if (RENDER) t.mock.timers.enable({ apis: ["setTimeout"] });
  var h = new Harness(label);
  await h.init(clientCount);
  try {
    await body(h);
    h.assertClean();
  } finally {
    h.close();
  }
}

test("a sub-agent's request survives its parent's turn result", async function (t) {
  await scenario(t, "subagent-vs-parent-result", 1, async function (h) {
    var task = null;
    await h.step(async function () { task = await h.spawnTask(); });
    await h.step(function () { return h.request(PROMPTS[0], task); });
    await h.step(function () { return h.turnResult(); });
    var r = h.pending()[0];
    if (!r) { h.fail("the sub-agent's request ended with the parent's turn (I6)"); return; }
    await h.step(function () { return h.respond(h.clients[0], r, "allow"); });
  });
});

test("a Task's completion before the operator answers keeps its request answerable", async function (t) {
  await scenario(t, "task-notification-before-answer", 2, async function (h) {
    var task = null;
    await h.step(async function () { task = await h.spawnTask(); });
    await h.step(function () { return h.request(PROMPTS[0], task); });
    await h.step(function () { return h.taskNotification(task); });
    await h.step(function () { return h.turnResult(); });
    var r = h.pending()[0];
    if (!r) { h.fail("the request ended before the operator answered (I6)"); return; }
    await h.step(function () { return h.respond(h.clients[1], r, "deny"); });
  });
});

test("Allow for Session survives a daemon restart", async function (t) {
  await scenario(t, "grant-across-restart", 1, async function (h) {
    var r = null;
    await h.step(async function () { r = await h.request(PROMPTS[1], null); });
    await h.step(function () { return h.respond(h.clients[0], r, "allow_always"); });
    await h.step(function () { return h.turnResult(); });
    await h.step(function () { return h.restart(); });
    await h.step(function () { return h.request(PROMPTS[1], null); });
  });
});

test("Allow for Session on one skill does not approve another", async function (t) {
  await scenario(t, "skill-grant-scope", 1, async function (h) {
    var r = null;
    await h.step(async function () { r = await h.request(PROMPTS[2], null); });
    await h.step(function () { return h.respond(h.clients[0], r, "allow_always"); });
    await h.step(function () { return h.request(PROMPTS[3], null); });
    await h.step(function () { return h.request(PROMPTS[2], null); });
  });
});

test("a second client's late response is answered and every banner retires", async function (t) {
  await scenario(t, "late-second-response", 2, async function (h) {
    var r = null;
    await h.step(async function () { r = await h.request(PROMPTS[0], null); });
    await h.step(function () { return h.respond(h.clients[0], r, "allow"); });
    await h.step(function () { return h.respond(h.clients[1], r, "deny"); });
  });
});

test("a request open across a daemon restart is not offered afterwards", async function (t) {
  await scenario(t, "pending-across-restart", 2, async function (h) {
    await h.step(function () { return h.request(PROMPTS[0], null); });
    await h.step(function () { return h.restart(); });
  });
});

test("a top-level prompt of every kind ended by its turn tells every client", async function (t) {
  await scenario(t, "turn-end-tells-clients", 2, async function (h) {
    for (var kind in BY_KIND) {
      await h.step(function () { return h.request(BY_KIND[kind], null); });
    }
    await h.step(function () { return h.turnResult(); });
  });
});

// Filler, then request, a user message, and the resolution: the first replay
// page starts at that user message, so it carries the resolution while the
// request only arrives on the older page.
test("paged replay never revives a resolved prompt, of any kind", async function (t) {
  var kinds = Object.keys(BY_KIND);
  for (var i = 0; i < kinds.length; i++) {
    var kind = kinds[i];
    await scenario(t, "paged-replay " + kind, 2, async function (h) {
      var r = null;
      await h.step(function () { return h.userMessage(120); });
      await h.step(async function () { r = await h.request(BY_KIND[kind], null); });
      await h.step(function () { return h.userMessage(0); });
      await h.step(function () { return h.respond(h.clients[0], r, Object.keys(ANSWERS[kind])[0]); });
      await h.step(function () { return h.disconnect(h.clients[1]); });
      await h.step(function () { return h.reconnect(h.clients[1]); });
      if (h.clients[1].known[r.id] !== "settled") h.fail("the first page did not carry the resolution; the scenario lost its shape");
      if (RENDER && dom.cardFor(h.clients[1].view, r.id)) h.fail("the first page already carried the request; the scenario lost its shape");
      await h.step(function () { return h.pageOlder(h.clients[1]); });
      if (RENDER && !dom.cardFor(h.clients[1].view, r.id)) h.fail("paging never reached the request; the scenario lost its shape");
    });
    t.mock.timers.reset();
  }
});

test("an HTTP Allow for Session is refused and grants nothing; HTTP never answers a question", async function (t) {
  await scenario(t, "http-allow-always", 1, async function (h) {
    var r = null;
    var ask = null;
    await h.step(async function () { r = await h.request(PROMPTS[1], null); });
    await h.step(function () { return h.httpRespond(r, "allow_always"); });
    await h.step(function () { return h.httpRespond(r, "allow"); });
    await h.step(function () { return h.request(PROMPTS[1], null); });
    await h.step(async function () { ask = await h.request(BY_KIND.ask_user, null); });
    await h.step(function () { return h.httpRespond(ask, "allow"); });
  });
});

// A backgrounded sub-agent outlives its parent's turn while the query stays
// open: the operator must still be able to answer its prompt, and that answer
// settles it exactly once.
test("a backgrounded sub-agent's prompt survives its parent's turn result and is answered exactly once", async function (t) {
  var kinds = ["permission", "plan", "ask_user"];
  for (var i = 0; i < kinds.length; i++) {
    var kind = kinds[i];
    await scenario(t, "subagent-across-turn-result " + kind, 2, async function (h) {
      var task = null;
      var r = null;
      await h.step(async function () { task = await h.spawnTask(); });
      await h.step(async function () { r = await h.request(BY_KIND[kind], task); });
      await h.step(function () { return h.turnResult(); });
      if (r.settled) { h.fail(r.id + " (" + kind + ") ended with its parent's turn (I6)"); return; }
      var answer = Object.keys(ANSWERS[kind])[0];
      await h.step(function () { return h.respond(h.clients[0], r, answer); });
      await h.step(function () { return h.respond(h.clients[1], r, answer); });
      if (!allows(r.outcome)) h.fail(r.id + " was answered " + answer + " but resolved as " + JSON.stringify(r.outcome));
    });
    t.mock.timers.reset();
  }
});

// The real Claude SDK cancels every callback still waiting when its query
// closes, a backgrounded sub-agent's included (and kills the process hosting
// that sub-agent), so no operator answer can reach it: the prompt ends denied
// and recorded, no card offers controls, and a later click is answered stale.
test("a query close cancels every pending prompt, a sub-agent's included; a later click is stale", async function (t) {
  var kinds = ["permission", "plan", "ask_user"];
  for (var i = 0; i < kinds.length; i++) {
    var kind = kinds[i];
    await scenario(t, "query-close-cancels-everything " + kind, 2, async function (h) {
      var task = null;
      var sub = null;
      var top = null;
      await h.step(async function () { task = await h.spawnTask(); });
      await h.step(async function () { sub = await h.request(BY_KIND[kind], task); });
      await h.step(async function () { top = await h.request(BY_KIND[kind], null); });
      await h.step(function () { return h.turnResult(); });
      await h.step(function () { return h.queryEnd(); });
      [sub, top].forEach(function (r) {
        if (!r.settled) { h.fail(r.id + " (" + kind + ") outlived its closed query (I5)"); return; }
        if (allows(r.outcome)) h.fail(r.id + " (" + kind + ") ended with its query without stopping the call (I5)");
        h.clients.forEach(function (c) {
          var card = RENDER ? dom.cardFor(c.view, r.id) : null;
          if (card && dom.liveControls(card).length > 0) h.fail(c.name + " still offers controls on " + r.id + " after its query closed (I2)");
        });
      });
      var answer = Object.keys(ANSWERS[kind])[0];
      await h.step(function () { return h.respond(h.clients[0], sub, answer); });
      await h.step(function () { return h.respond(h.clients[1], top, answer); });
    });
    t.mock.timers.reset();
  }
});

test("a daemon restart ends every open prompt, of every kind and owner, denied and recorded", async function (t) {
  await scenario(t, "restart-ends-everything", 2, async function (h) {
    var task = null;
    await h.step(async function () { task = await h.spawnTask(); });
    for (var kind in BY_KIND) {
      await h.step(function () { return h.request(BY_KIND[kind], null); });
    }
    await h.step(function () { return h.request(BY_KIND.permission, task); });
    await h.step(function () { return h.request(BY_KIND.ask_user, task); });
    await h.step(function () { return h.restart(); });
  });
});

test("a stale answer of every kind, from either message shape, gets a reply", async function (t) {
  await scenario(t, "stale-answer-every-kind", 2, async function (h) {
    for (var kind in BY_KIND) {
      var r = null;
      await h.step(async function () { r = await h.request(BY_KIND[kind], null); });
      var answer = Object.keys(ANSWERS[kind])[0];
      await h.step(function () { return h.respond(h.clients[0], r, answer); });
      await h.step(function () { return h.respond(h.clients[1], r, answer); });
      h.toolSeq++;
      await h.step(function () { return h.respond(h.clients[1], r, answer); });
    }
  });
});

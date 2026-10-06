"use strict";
// Model-based invariant harness for the permission-request lifecycle.
//
// Generates interleavings of everything that touches a permission request -
// top-level and sub-agent requests, Task spawn/notification/result, the
// parent turn's result, query end, WS responses from several clients, HTTP
// responses, aborts, disconnect/reconnect, history paging, user messages
// between request and answer, and daemon restart - against the real server
// modules (see permission-harness-world.js) and the real client card code,
// and after every step checks:
//
//   I1  the server re-presents exactly the requests it can still answer
//   I2  a request the server no longer holds never shows live buttons on any
//       client, and no notification still offers it
//   I3  a pending request is clickable on every connected client
//   I4  a response settles a pending request exactly once, with the operator's
//       decision; a response to anything else is answered as stale
//   I5  Deny, and every non-operator ending, stops the call
//   I6  only the request's own scope ends it: a top-level request may end with
//       its turn, a live sub-agent's request only with its query
//   I7  Allow for Session auto-approves the same grant key afterwards, across
//       turns and restart, and nothing else
//   I8  every request that ends records exactly one terminal event
//
// Set CLAGENTIC_PERMISSION_HARNESS_LIB to another checkout's lib/ to run the
// wire-level checks against it; the client render layer always exercises
// this checkout's tools.js, so it is skipped for a foreign lib.

var test = require("node:test");
var assert = require("node:assert/strict");
var world = require("./permission-harness-world");
var dom = require("./fake-dom-permission-cards");

var RENDER = !world.overridesLib;

var DECISION_BUTTONS = {
  allow: ".permission-allow, .perm-allow",
  allow_always: ".permission-allow-session, .perm-always",
  deny: ".permission-deny, .perm-deny",
};

var TOOLS = [
  { key: "Bash", toolName: "Bash", input: { command: "deploy --prod" } },
  { key: "Write", toolName: "Write", input: { file_path: "/srv/app/config.yml" } },
  { key: "Skill:alpha", toolName: "Skill", input: { skill: "alpha" } },
  { key: "Skill:beta", toolName: "Skill", input: { skill: "beta" } },
];

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function expectedOutcome(decision, toolInput) {
  if (decision === "allow" || decision === "allow_always") return { behavior: "allow", updatedInput: toolInput };
  return { behavior: "deny" };
}

// What a client may conclude from the wire alone, independent of order: a
// request is over once any message says so. `settled` is the older wire form
// of a replayed request's terminal state.
function wireApply(known, msg) {
  var id = msg.requestId;
  if (known[id] === "settled") return;
  if (msg.type === "permission_resolved" || msg.type === "permission_cancel") known[id] = "settled";
  else if (msg.type === "permission_request") {
    var st = msg.permissionState;
    known[id] = (msg.settled === true || (st && st.state !== "pending")) ? "settled" : "pending";
  } else if (msg.type === "permission_request_pending") {
    known[id] = known[id] || "pending";
  }
}

var PERMISSION_TYPES = { permission_request: 1, permission_request_pending: 1, permission_resolved: 1, permission_cancel: 1 };

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
  // Never disconnects: counts live terminal events per request for I8.
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
  if (client.view && PERMISSION_TYPES[msg.type]) client.view.tools.applyPermissionMessage(msg);
};

Harness.prototype.drain = function (client) {
  while (client.inbox.length) {
    var msg = client.inbox.shift();
    if (msg.type === "session_switched") {
      client.known = {};
      if (client.view) {
        client.view.messagesEl.innerHTML = "";
        client.view.tools.resetToolState();
        client.view.tools.clearPermissionStates();
      }
    } else if (msg.type === "history_meta") {
      client.historyFrom = msg.from;
    } else if (msg.type === "history_prepend") {
      client.historyFrom = msg.meta.from;
      var saved = client.view ? client.view.tools.saveToolState() : null;
      if (client.view) client.view.tools.resetToolState();
      for (var i = 0; i < msg.items.length; i++) {
        var it = msg.items[i];
        if (!PERMISSION_TYPES[it.type]) continue;
        wireApply(client.known, it);
        this.applyToView(client, it);
      }
      if (client.view) client.view.tools.restoreToolState(saved);
    } else if (PERMISSION_TYPES[msg.type]) {
      if (client === this.auditor && (msg.type === "permission_resolved" || msg.type === "permission_cancel") && msg.reason !== "stale") {
        this.terminalEvents[msg.requestId] = (this.terminalEvents[msg.requestId] || 0) + 1;
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

// --- operations ----------------------------------------------------------

Harness.prototype.request = async function (tool, ownerTask) {
  var self = this;
  this.op = "request " + tool.key + (ownerTask ? " by " + ownerTask : "");
  var session = this.server.session;
  var toolUseId = "tu-" + (++this.toolSeq);
  if (ownerTask) {
    this.server.sdk({
      yokeType: "subagent_message",
      parentToolUseId: ownerTask,
      messageRole: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: tool.toolName, input: tool.input }],
    });
  }
  var before = Object.keys(session.pendingPermissions || {});
  var abort = new AbortController();
  var promise = this.server.bridge.handleCanUseTool(session, tool.toolName, tool.input, { toolUseID: toolUseId, signal: abort.signal });
  var opened = Object.keys(session.pendingPermissions || {}).filter(function (id) { return before.indexOf(id) === -1; });

  if (this.granted[tool.key]) {
    if (opened.length) this.fail(tool.key + " was granted for the session but prompted again (I7)");
    var auto = await promise;
    if (!auto || auto.behavior !== "allow") this.fail(tool.key + " was granted for the session but was not auto-approved (I7)");
    await this.settle();
    return null;
  }
  if (opened.length !== 1) {
    this.fail(tool.key + " was never granted but did not open exactly one request (I7); opened " + opened.length);
    await this.settle();
    return null;
  }
  var r = {
    id: opened[0], tool: tool, owner: ownerTask || null, ownerLive: !!ownerTask, abort: abort,
    query: this.queryGen, settled: false, dead: false, outcome: null, cause: null,
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

Harness.prototype.queryEnd = async function () {
  this.op = "query end";
  var gen = this.queryGen;
  await this.server.endQuery();
  this.tasks = {};
  await this.settle();
  var self = this;
  this.order.forEach(function (id) {
    var r = self.requests[id];
    if (r.query === gen && !r.settled && !r.dead) self.fail(id + " outlived its closed query (I1: nothing can consume its decision)");
  });
  this.queryGen++;
  this.op = "query restart";
  await this.server.startQuery();
  await this.settle();
};

Harness.prototype.respond = async function (client, r, decision) {
  this.op = client.name + " " + decision + " " + r.id;
  var wasPending = !r.settled && !r.dead;
  this.drain(client);
  var button = null;
  if (client.view && client.connected) {
    var card = dom.cardFor(client.view, r.id);
    button = card ? card.querySelector(DECISION_BUTTONS[decision]) : null;
    if (button && button.disabled) button = null;
  }
  if (button) button.click();
  else this.server.handlers.handleSessionsMessage(client.ws, { type: "permission_response", requestId: r.id, decision: decision });
  var replies = client.inbox.filter(function (m) {
    return m.requestId === r.id && (m.type === "permission_resolved" || m.type === "permission_cancel");
  });
  await this.settle();
  if (client.connected && replies.length === 0) this.fail(client.name + "'s response to " + r.id + " got no answer (I4)");
  this.checkDecision(r, wasPending, decision);
};

Harness.prototype.httpRespond = async function (r, decision) {
  this.op = "HTTP " + decision + " " + r.id;
  var wasPending = !r.settled && !r.dead;
  var status = await this.server.httpRespond(r.id, decision);
  await this.settle();
  if (status !== (wasPending ? 200 : 404)) this.fail("HTTP response for " + r.id + " returned " + status + " (I4)");
  this.checkDecision(r, wasPending, decision);
};

Harness.prototype.checkDecision = function (r, wasPending, decision) {
  if (!wasPending) return;
  if (!r.settled) { this.fail("a " + decision + " for pending " + r.id + " did not settle it (I4)"); return; }
  var want = expectedOutcome(decision, r.tool.input);
  if (r.outcome.behavior !== want.behavior) this.fail(r.id + " answered " + decision + " resolved as " + r.outcome.behavior + " (I5)");
  if (want.updatedInput && JSON.stringify(r.outcome.updatedInput) !== JSON.stringify(want.updatedInput)) {
    this.fail(r.id + " was allowed with a different input than requested (I4)");
  }
  if (decision === "allow_always") this.granted[r.tool.key] = true;
};

Harness.prototype.abort = async function (r) {
  this.op = "abort " + r.id;
  var wasPending = !r.settled && !r.dead;
  r.abort.abort();
  await this.settle();
  if (wasPending && !(r.settled && r.outcome.behavior === "deny")) this.fail("aborting " + r.id + " did not deny it (I5)");
};

Harness.prototype.disconnect = async function (client) {
  this.op = "disconnect " + client.name;
  this.server.disconnect(client.ws);
  client.connected = false;
  if (client.view) client.view.tools.restoreUnconfirmedPermissions("Connection lost.");
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

Harness.prototype.restart = async function () {
  this.op = "daemon restart";
  var self = this;
  var home = this.server.home;
  var cliSessionId = this.server.session.cliSessionId;
  this.server.shutdown();
  this.order.forEach(function (id) { if (!self.requests[id].settled) self.requests[id].dead = true; });
  this.tasks = {};
  this.server = await world.createServer({ home: home, cliSessionId: cliSessionId });
  this.queryGen++;
  await this.server.startQuery();
  this.connectAuditor();
  this.clients.forEach(function (c) { if (c.connected) self.server.connect(c.ws); });
  await this.settle();
};

// --- invariants ----------------------------------------------------------

Harness.prototype.check = function () {
  var self = this;
  var snapshot = this.server.pendingSnapshot();
  this.drain(this.auditor);
  var notified = this.server.notifiedRequestIds();
  var session = this.server.session;

  this.order.forEach(function (id) {
    var r = self.requests[id];
    var live = !r.settled && !r.dead;

    if (live !== (snapshot.indexOf(id) !== -1)) {
      self.fail(id + (live ? " is still awaiting a decision but the server no longer offers it (I1)" : " is over but the server still offers it (I1)"));
    }
    if (!live && notified.indexOf(id) !== -1) self.fail(id + " is over but its notification still offers buttons (I2)");

    if (r.settled && r.cause) {
      var cause = r.cause;
      var aimedHere = cause.slice(-(id.length + 1)) === " " + id;
      var byOperator = aimedHere && (/^(client-\d+|HTTP) /.test(cause) || cause.indexOf("abort ") === 0);
      if (!byOperator) {
        if (r.outcome.behavior !== "deny") self.fail(id + " ended by '" + cause + "' without a deny (I5)");
        var scopeEnd = cause === "query end" || (cause === "turn result" && !r.ownerLive);
        if (!scopeEnd) self.fail(id + " (owner " + (r.owner || "top-level") + ") was ended by '" + cause + "', outside its scope (I6)");
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
      var buttons = card ? dom.enabledButtons(card).length : 0;
      if (live && buttons === 0) self.fail(c.name + " has no clickable card for pending " + id + " (I3)");
      if (!live && buttons > 0) self.fail(c.name + " renders live buttons for ended " + id + " (I2)");
    });
  });
  if (session.pendingPermissions && Object.keys(session.pendingPermissions).some(function (id) { return !self.requests[id]; })) {
    this.fail("the server holds a request the harness never opened");
  }
};

Harness.prototype.step = async function (fn) {
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

// How each request ended across a whole random run; a run that never
// exercises a path proves nothing about it.
function tallyEndings(h, tally) {
  h.order.forEach(function (id) {
    var r = h.requests[id];
    tally.opened++;
    if (r.owner) tally.subagent++;
    if (r.dead) tally.dead++;
    else if (!r.settled) tally.open++;
    else if (/^(client-\d+|HTTP) /.test(r.endedBy)) tally.operator++;
    else if (r.endedBy === "turn result") tally.turn++;
    else if (r.endedBy === "query end") tally.query++;
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
      if (roll < 0.18) await h.step(function () { return h.request(pick(TOOLS), null); });
      else if (roll < 0.30 && live.length) await h.step(function () { return h.request(pick(TOOLS), pick(live)); });
      else if (roll < 0.36) await h.step(function () { return h.spawnTask(); });
      else if (roll < 0.40 && live.length) await h.step(function () { return h.taskNotification(pick(live)); });
      else if (roll < 0.43 && live.length) await h.step(function () { return h.taskToolResult(pick(live)); });
      else if (roll < 0.50) await h.step(function () { return h.turnResult(); });
      else if (roll < 0.66 && any.length && connected.length) {
        var target = pending.length && rnd() < 0.8 ? pick(pending) : pick(any);
        var decision = pick(["allow", "allow_always", "deny", "deny"]);
        var who = pick(connected);
        await h.step(function () { return h.respond(who, target, decision); });
      } else if (roll < 0.69 && any.length) {
        var hTarget = pick(any);
        var hDecision = pick(["allow", "allow_always", "deny"]);
        await h.step(function () { return h.httpRespond(hTarget, hDecision); });
      } else if (roll < 0.72 && pending.length) {
        var aTarget = pick(pending);
        await h.step(function () { return h.abort(aTarget); });
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

test("random interleavings keep every permission invariant", { timeout: 240000 }, async function (t) {
  // Card ack timers must not fire in wall-clock time mid-run.
  if (RENDER) t.mock.timers.enable({ apis: ["setTimeout"] });
  var tally = { opened: 0, subagent: 0, open: 0, dead: 0, operator: 0, turn: 0, query: 0, aborted: 0 };
  for (var seed = 1; seed <= SEEDS; seed++) {
    await randomRun(seed, STEPS, tally);
  }
  t.diagnostic("request endings across " + SEEDS + " runs: " + JSON.stringify(tally));
  Object.keys(tally).forEach(function (k) {
    assert.ok(tally[k] > 0, "the random runs never produced a request that is '" + k + "': " + JSON.stringify(tally));
  });
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
    await h.step(function () { return h.request(TOOLS[0], task); });
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
    await h.step(function () { return h.request(TOOLS[0], task); });
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
    await h.step(async function () { r = await h.request(TOOLS[1], null); });
    await h.step(function () { return h.respond(h.clients[0], r, "allow_always"); });
    await h.step(function () { return h.turnResult(); });
    await h.step(function () { return h.restart(); });
    await h.step(function () { return h.request(TOOLS[1], null); });
  });
});

test("Allow for Session on one skill does not approve another", async function (t) {
  await scenario(t, "skill-grant-scope", 1, async function (h) {
    var r = null;
    await h.step(async function () { r = await h.request(TOOLS[2], null); });
    await h.step(function () { return h.respond(h.clients[0], r, "allow_always"); });
    await h.step(function () { return h.request(TOOLS[3], null); });
    await h.step(function () { return h.request(TOOLS[2], null); });
  });
});

test("a second client's late response is answered and every banner retires", async function (t) {
  await scenario(t, "late-second-response", 2, async function (h) {
    var r = null;
    await h.step(async function () { r = await h.request(TOOLS[0], null); });
    await h.step(function () { return h.respond(h.clients[0], r, "allow"); });
    await h.step(function () { return h.respond(h.clients[1], r, "deny"); });
  });
});

test("a request open across a daemon restart is not offered afterwards", async function (t) {
  await scenario(t, "pending-across-restart", 2, async function (h) {
    await h.step(function () { return h.request(TOOLS[0], null); });
    await h.step(function () { return h.restart(); });
  });
});

test("a top-level request ended by its turn tells every client", async function (t) {
  await scenario(t, "turn-end-tells-clients", 2, async function (h) {
    await h.step(function () { return h.request(TOOLS[0], null); });
    await h.step(function () { return h.turnResult(); });
  });
});

test("paged replay never revives a resolved request", async function (t) {
  await scenario(t, "paged-replay", 2, async function (h) {
    var r = null;
    await h.step(async function () { r = await h.request(TOOLS[1], null); });
    await h.step(function () { return h.userMessage(0); });
    await h.step(function () { return h.respond(h.clients[0], r, "allow"); });
    await h.step(function () { return h.userMessage(130); });
    await h.step(function () { return h.disconnect(h.clients[1]); });
    await h.step(function () { return h.reconnect(h.clients[1]); });
    await h.step(function () { return h.pageOlder(h.clients[1]); });
    await h.step(function () { return h.pageOlder(h.clients[1]); });
    if (RENDER && !dom.cardFor(h.clients[1].view, r.id)) h.fail("paging never reached the request; the scenario lost its shape");
  });
});

test("an HTTP Allow for Session grants like the in-app button", async function (t) {
  await scenario(t, "http-allow-always", 1, async function (h) {
    var r = null;
    await h.step(async function () { r = await h.request(TOOLS[1], null); });
    await h.step(function () { return h.httpRespond(r, "allow_always"); });
    await h.step(function () { return h.request(TOOLS[1], null); });
  });
});

test("a query end closes its sub-agent's open request", async function (t) {
  await scenario(t, "query-end-subagent", 1, async function (h) {
    var task = null;
    await h.step(async function () { task = await h.spawnTask(); });
    await h.step(function () { return h.request(TOOLS[0], task); });
    await h.step(function () { return h.turnResult(); });
    await h.step(function () { return h.queryEnd(); });
  });
});

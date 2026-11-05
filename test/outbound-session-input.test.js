"use strict";
// open-session and send-input leave one sender-side ledger entry per request:
// a delivery where the history entry is recorded, everything else where the
// result is logged. A ledger that fails never changes the answer.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { createSessionInput } = require("../lib/session-input");
var { createOutboundLedger } = require("../lib/outbound-ledger");
var { setNewWorkGate } = require("../lib/new-work-gate");

var NOW = Date.now();

function quiet() {
  return { error: function () {}, warn: function () {}, log: function () {} };
}

function makeProject(opts) {
  opts = opts || {};
  var nextId = 40;
  var recorded = [];
  var sm = {
    sessions: new Map(),
    defaultVendor: "claude",
    createSession: function (o) {
      var s = { localId: nextId++, history: [], vendor: o.vendor || null, agentName: o.agentName || null, cliSessionId: null };
      sm.sessions.set(s.localId, s);
      return s;
    },
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    recordHistoryEntry: function (s, e) { s.history.push(e); recorded.push(e); },
    appendToSessionFile: function () {},
    deleteSession: function (id) { sm.sessions.delete(id); },
    sessionsDir: opts.sessionsDir,
  };
  (opts.existing || []).forEach(function (s) { sm.sessions.set(s.localId, s); });
  return {
    recorded: recorded,
    cwd: "/unused",
    sm: sm,
    sdk: {
      startQuery: function () {
        if (opts.startThrows) throw new Error("no runtime");
        if (opts.startAsync === "ok") return Promise.resolve();
        if (opts.startAsync === "fail") return Promise.reject(new Error("async no runtime"));
        return undefined;
      },
      pushMessage: function () {},
    },
    onProcessingChanged: function () {},
    getLinuxUserForSession: function () { return null; },
  };
}

// The target: a live session in project "p". The sender: a live session of the
// agent "agent-a" in project "q", which the console can resolve from the
// reference its environment carries.
function target() {
  return { localId: 100, cliSessionId: "cli-target", agentName: "reviewer", history: [], isProcessing: false, queryInstance: {} };
}
function senderSession() {
  return { localId: 7, cliSessionId: "cli-sender", agentName: "agent-a", history: [], isProcessing: true, queryInstance: {} };
}

function setup(over) {
  over = over || {};
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "outbound-si-"));
  var p = makeProject({ existing: [target()], startThrows: over.startThrows, startAsync: over.startAsync, sessionsDir: over.sessionsDir });
  var q = makeProject({ existing: [senderSession()] });
  var ledger = createOutboundLedger({ getBaseDir: function () { return dir; }, now: function () { return NOW; }, log: quiet() });
  var input = createSessionInput({
    getProject: function (slug) {
      if (slug === "boom") throw new Error("store exploded");
      if (slug === "bare") return {};
      return slug === "p" ? p : slug === "q" ? q : null;
    },
    agentCatalog: function () { return [{ name: "reviewer" }]; },
    outboundLedger: over.noLedger ? undefined : (over.ledger || ledger),
    now: function () { return NOW; },
  });
  return { dir: dir, p: p, input: input, ledger: ledger };
}

function all(ledger) {
  return ledger.readAttributed().concat(ledger.readUnattributed());
}

var FROM_AGENT_A = { senderProject: "q", senderSessionId: "7" };

test("a delivered send-input is recorded with prompt, target, initiator and the same message id as the history entry", function () {
  var t = setup();
  var out = t.input.sendInput(Object.assign({ projectSlug: "p", sessionId: "cli-target", prompt: "please review", contextNote: "pr 12" }, FROM_AGENT_A));
  assert.equal(out.result, "delivered");

  var entries = all(t.ledger);
  assert.equal(entries.length, 1);
  var e = entries[0];
  assert.equal(e.verb, "send_input");
  assert.equal(e.result, "delivered");
  assert.equal(e.prompt, "please review");
  assert.equal(e.initiator, "trigger");
  assert.equal(e.contextNote, "pr 12");
  assert.equal(e.ts, new Date(NOW).toISOString());
  assert.equal(e.target.project, "p");
  assert.equal(e.target.sessionId, "100");
  assert.equal(e.target.cliSessionId, "cli-target");
  assert.equal(e.target.agent, "reviewer");
  assert.deepEqual(
    { kind: e.sender.kind, attribution: e.sender.attribution, project: e.sender.project, sessionId: e.sender.sessionId, cliSessionId: e.sender.cliSessionId, agent: e.sender.agent },
    { kind: "extracted", attribution: "extracted", project: "q", sessionId: "7", cliSessionId: "cli-sender", agent: "agent-a" }
  );
  assert.equal(t.p.recorded.length, 1);
  assert.equal(e.messageId, t.p.recorded[0].messageId);
  assert.ok(e.messageId);
  assert.ok(fs.existsSync(path.join(t.dir, "outbound", "sessions", "q", "cli-sender.jsonl")));
});

test("an address and a reply are recorded as the caller gave them, with the session they resolved to", function () {
  var t = setup();
  t.input.sendInput(Object.assign({ to: "reviewer@p", prompt: "by address" }, FROM_AGENT_A));
  var e = all(t.ledger)[0];
  assert.equal(e.target.address, "reviewer@p");
  assert.equal(e.target.sessionId, "100");
  assert.equal(e.target.project, "p");
});

test("a delivered open-session is recorded once, as an open", function () {
  var t = setup();
  var out = t.input.openSession(Object.assign({ projectSlug: "p", prompt: "start here" }, FROM_AGENT_A));
  assert.equal(out.result, "opened");
  var entries = all(t.ledger);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].verb, "open_session");
  assert.equal(entries[0].result, "opened");
  assert.equal(entries[0].prompt, "start here");
  assert.equal(entries[0].target.project, "p");
  assert.equal(entries[0].target.sessionId, String(out.consoleSessionId));
});

test("a refused send-input is recorded with the reason, and so is a not-found one", function () {
  var t = setup();
  var refused = t.input.sendInput(Object.assign({ projectSlug: "nowhere", sessionId: "x1", prompt: "lost" }, FROM_AGENT_A));
  assert.equal(refused.result, "refused");
  var badInitiator = t.input.sendInput(Object.assign({ projectSlug: "p", sessionId: "cli-target", prompt: "as a person", initiator: "human" }, FROM_AGENT_A));
  assert.equal(badInitiator.result, "refused");

  var entries = all(t.ledger);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].result, "refused");
  assert.match(entries[0].reason, /unknown project/);
  // No target was resolved, so its OS user is not recorded: no text is stored.
  assert.equal("prompt" in entries[0], false);
  assert.equal(entries[0].promptWithheld, true);
  assert.match(entries[0].promptWithheldReason, /not recorded/);
  assert.equal(entries[0].sender.project, "q");
  assert.equal(entries[1].result, "refused");
  assert.match(entries[1].reason, /human/);
  assert.equal(entries[1].initiator, undefined);
  assert.equal(entries[1].messageId, undefined);
});

test("a refused open-session is recorded", function () {
  var t = setup();
  var out = t.input.openSession(Object.assign({ projectSlug: "p", prompt: "x", agentName: "nobody" }, FROM_AGENT_A));
  assert.equal(out.result, "refused");
  var entries = all(t.ledger);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].verb, "open_session");
  assert.match(entries[0].reason, /unknown agent/);
});

test("a request with no prompt is recorded without one", function () {
  var t = setup();
  t.input.sendInput(Object.assign({ projectSlug: "p", sessionId: "cli-target", prompt: "" }, FROM_AGENT_A));
  var e = all(t.ledger)[0];
  assert.equal(e.result, "refused");
  assert.equal("prompt" in e, false);
});

test("an open whose first turn fails to start is recorded as an error, with no message id", function () {
  var t = setup({ startThrows: true });
  var opened = t.input.openSession(Object.assign({ projectSlug: "p", prompt: "never starts" }, FROM_AGENT_A));
  assert.equal(opened.result, "error");
  var entries = all(t.ledger);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].verb, "open_session");
  assert.equal(entries[0].result, "error");
  assert.match(entries[0].reason, /open failed/);
  assert.equal("prompt" in entries[0], false);
  assert.equal(entries[0].promptWithheld, true);
  assert.equal("messageId" in entries[0], false);
});

test("a send that hits a failing start is recorded as an error with retryable set", function () {
  var t = setup({ startThrows: true });
  // An idle session with no runtime: delivery has to start a query, which fails.
  var idle = { localId: 101, cliSessionId: "cli-idle", history: [], isProcessing: false };
  t.p.sm.sessions.set(101, idle);
  var out = t.input.sendInput(Object.assign({ projectSlug: "p", sessionId: "cli-idle", prompt: "needs a start" }, FROM_AGENT_A));
  assert.equal(out.result, "error");
  var e = all(t.ledger)[0];
  assert.equal(e.result, "error");
  assert.equal(e.retryable, true);
  assert.match(e.reason, /turn start failed/);
  assert.equal(e.target.requestedSessionId, "cli-idle");
  assert.equal(e.target.project, "p");
});

test("a declared sender is kept apart, labelled unverified, and never as an identified sender", function () {
  var t = setup();
  t.input.sendInput({ projectSlug: "p", sessionId: "cli-target", prompt: "from a script", from: "nightly-job", fromSession: "claimed-1" });
  assert.deepEqual(t.ledger.readAttributed(), []);
  var e = t.ledger.readUnattributed()[0];
  assert.equal(e.sender.kind, "declared");
  assert.equal(e.sender.attribution, "unverified");
  assert.equal(e.sender.name, "nightly-job");
  assert.equal(e.sender.fromSession, "claimed-1");
  assert.equal(e.sender.project, undefined);
  assert.ok(fs.existsSync(path.join(t.dir, "outbound", "unattributed", "declared", "nightly-job.jsonl")));
});

test("an undeclared sender is kept apart, labelled unverified", function () {
  var t = setup();
  t.input.sendInput({ projectSlug: "p", sessionId: "cli-target", prompt: "anonymous" });
  var e = t.ledger.readUnattributed()[0];
  assert.equal(e.sender.kind, "undeclared");
  assert.equal(e.sender.attribution, "unverified");
  assert.ok(fs.existsSync(path.join(t.dir, "outbound", "unattributed", "undeclared", "undeclared.jsonl")));
});

test("a reference the console does not hold is not an identified sender, whatever it claims", function () {
  var t = setup();
  t.input.sendInput({ projectSlug: "p", sessionId: "cli-target", prompt: "forged", senderProject: "q", senderSessionId: "999", from: "agent-a@q" });
  assert.deepEqual(t.ledger.readAttributed(), []);
  assert.equal(t.ledger.readUnattributed()[0].sender.attribution, "unverified");
});

test("the console's own scheduled firing is not an outbound call and is not recorded", function () {
  var t = setup();
  var out = t.input.fireScheduled({ projectSlug: "p", sessionId: "cli-target", prompt: "tick", note: "scheduled message" });
  assert.equal(out.result, "delivered");
  assert.deepEqual(all(t.ledger), []);
});

test("listing sessions writes nothing", function () {
  var t = setup();
  t.input.listSessions({ projectSlug: "p" });
  assert.deepEqual(all(t.ledger), []);
});

test("a ledger that throws does not fail the send or the open", function () {
  var throwing = { record: function () { throw new Error("disk full"); } };
  var t = setup({ ledger: throwing });
  var sent = t.input.sendInput(Object.assign({ projectSlug: "p", sessionId: "cli-target", prompt: "still delivered" }, FROM_AGENT_A));
  assert.equal(sent.result, "delivered");
  assert.equal(t.p.recorded.length, 1);
  var opened = t.input.openSession(Object.assign({ projectSlug: "p", prompt: "still opened" }, FROM_AGENT_A));
  assert.equal(opened.result, "opened");
  var refused = t.input.sendInput({ projectSlug: "nowhere", sessionId: "x", prompt: "still refused" });
  assert.equal(refused.result, "refused");
});

test("an entry that cannot be built does not fail the send, and the failure is logged", function () {
  var t = setup();
  var logged = [];
  var original = console.error;
  console.error = function () { logged.push(Array.prototype.join.call(arguments, " ")); };
  try {
    // A project whose OS-user lookup throws makes the entry impossible to build.
    t.p.getLinuxUserForSession = function () { throw new Error("lookup broke"); };
    var sent = t.input.sendInput(Object.assign({ projectSlug: "p", sessionId: "cli-target", prompt: "still delivered" }, FROM_AGENT_A));
    assert.equal(sent.result, "delivered");
    assert.equal(t.p.recorded.length, 1);
  } finally {
    console.error = original;
  }
  assert.ok(logged.some(function (l) { return /outbound ledger entry failed: lookup broke/.test(l); }));
});

test("a delivery records the OS user the target runs as", function () {
  var t = setup();
  t.input.sendInput(Object.assign({ projectSlug: "p", sessionId: "cli-target", prompt: "a" }, FROM_AGENT_A));
  t.p.getLinuxUserForSession = function () { return "alice-os"; };
  t.input.sendInput(Object.assign({ projectSlug: "p", sessionId: "cli-target", prompt: "b" }, FROM_AGENT_A));
  assert.deepEqual(all(t.ledger).map(function (e) { return e.target.runsAs; }).sort(), ["alice-os", "daemon"]);
});

test("write time: an other-OS-user send stores no prompt and no context note, only metadata and the reason", function () {
  var t = setup();
  t.p.getLinuxUserForSession = function () { return "alice-os"; };
  t.input.sendInput(Object.assign({ projectSlug: "p", sessionId: "cli-target", prompt: "secret-prompt", contextNote: "secret-note" }, FROM_AGENT_A));
  var e = all(t.ledger)[0];
  assert.equal(e.target.runsAs, "alice-os");
  assert.equal(e.promptWithheld, true);
  assert.equal(e.contextNoteWithheld, true);
  assert.match(e.promptWithheldReason, /another OS user/);
  var raw = fs.readFileSync(path.join(t.dir, "outbound", "sessions", "q", "cli-sender.jsonl"), "utf8");
  assert.equal(raw.indexOf("secret-prompt"), -1);
  assert.equal(raw.indexOf("secret-note"), -1);
});

test("write time: a same-user send keeps its prompt and context note", function () {
  var t = setup();
  t.input.sendInput(Object.assign({ projectSlug: "p", sessionId: "cli-target", prompt: "kept-prompt", contextNote: "kept-note" }, FROM_AGENT_A));
  var e = all(t.ledger)[0];
  assert.equal(e.prompt, "kept-prompt");
  assert.equal(e.contextNote, "kept-note");
  assert.equal("promptWithheld" in e, false);
});

test("a ledger directory that cannot be written does not fail the send", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "outbound-si-bad-"));
  fs.writeFileSync(path.join(dir, "outbound"), "a file where the directory should be");
  var bad = createOutboundLedger({ getBaseDir: function () { return dir; }, now: function () { return NOW; }, log: quiet() });
  var t = setup({ ledger: bad });
  var sent = t.input.sendInput(Object.assign({ projectSlug: "p", sessionId: "cli-target", prompt: "delivered anyway" }, FROM_AGENT_A));
  assert.equal(sent.result, "delivered");
  assert.equal(t.p.recorded[0].text, "delivered anyway");
});

test("with no ledger configured nothing changes", function () {
  var p = makeProject({ existing: [target()] });
  var input = createSessionInput({ getProject: function (slug) { return slug === "p" ? p : null; } });
  assert.equal(input.sendInput({ projectSlug: "p", sessionId: "cli-target", prompt: "x" }).result, "delivered");
});

// CREW_SOP section 6: every caller shape the after-result wrapper on
// send_session_input and open_session sees. Each scenario runs twice, with the
// ledger and without, and the two answers must be identical: the wrapper never
// changes a handler's result, whatever the result is.

function idleSession() {
  return { localId: 101, cliSessionId: "cli-idle", history: [], isProcessing: false };
}

var SHAPES = [
  // send-input: delivered, by each kind of sender
  { name: "send, identified sender", verb: "sendInput", req: Object.assign({ projectSlug: "p", sessionId: "cli-target", prompt: "a" }, FROM_AGENT_A), result: "delivered", sender: "extracted" },
  { name: "send, declared sender", verb: "sendInput", req: { projectSlug: "p", sessionId: "cli-target", prompt: "a", from: "nightly", fromSession: "claimed-1" }, result: "delivered", sender: "declared" },
  { name: "send, undeclared sender", verb: "sendInput", req: { projectSlug: "p", sessionId: "cli-target", prompt: "a" }, result: "delivered", sender: "undeclared" },
  // send-input and open-session: each accepted initiator, and none
  { name: "send, initiator trigger", verb: "sendInput", req: { projectSlug: "p", sessionId: "cli-target", prompt: "a", initiator: "trigger" }, result: "delivered", initiator: "trigger" },
  { name: "send, initiator scheduled", verb: "sendInput", req: { projectSlug: "p", sessionId: "cli-target", prompt: "a", initiator: "scheduled" }, result: "delivered", initiator: "scheduled" },
  { name: "send, initiator scheduled-now", verb: "sendInput", req: { projectSlug: "p", sessionId: "cli-target", prompt: "a", initiator: "scheduled-now" }, result: "delivered", initiator: "scheduled-now" },
  { name: "send, initiator loop", verb: "sendInput", req: { projectSlug: "p", sessionId: "cli-target", prompt: "a", initiator: "loop" }, result: "delivered", initiator: "loop" },
  { name: "open, identified sender", verb: "openSession", req: Object.assign({ projectSlug: "p", prompt: "a" }, FROM_AGENT_A), result: "opened", sender: "extracted" },
  { name: "open, declared sender", verb: "openSession", req: { projectSlug: "p", prompt: "a", from: "nightly" }, result: "opened", sender: "declared" },
  { name: "open, undeclared sender", verb: "openSession", req: { projectSlug: "p", prompt: "a" }, result: "opened", sender: "undeclared" },
  { name: "open, initiator trigger", verb: "openSession", req: { projectSlug: "p", prompt: "a", initiator: "trigger" }, result: "opened", initiator: "trigger" },
  { name: "open, initiator scheduled", verb: "openSession", req: { projectSlug: "p", prompt: "a", initiator: "scheduled" }, result: "opened", initiator: "scheduled" },
  { name: "open, initiator scheduled-now", verb: "openSession", req: { projectSlug: "p", prompt: "a", initiator: "scheduled-now" }, result: "opened", initiator: "scheduled-now" },
  { name: "open, initiator loop", verb: "openSession", req: { projectSlug: "p", prompt: "a", initiator: "loop" }, result: "opened", initiator: "loop" },
  // refusals, one per reason class
  { name: "send refused: human initiator", verb: "sendInput", req: { projectSlug: "p", sessionId: "cli-target", prompt: "a", initiator: "human" }, result: "refused", reason: /human/ },
  { name: "send refused: unknown initiator", verb: "sendInput", req: { projectSlug: "p", sessionId: "cli-target", prompt: "a", initiator: "bogus" }, result: "refused", reason: /unknown initiator/ },
  { name: "send refused: no prompt", verb: "sendInput", req: { projectSlug: "p", sessionId: "cli-target" }, result: "refused", reason: /prompt/ },
  { name: "send refused: bad --from", verb: "sendInput", req: { projectSlug: "p", sessionId: "cli-target", prompt: "a", from: 5 }, result: "refused", reason: /from must be a string/ },
  { name: "send refused: unsafe session id", verb: "sendInput", req: { projectSlug: "p", sessionId: "../x", prompt: "a" }, result: "refused", reason: /unsafe session id/ },
  { name: "send refused: unknown project", verb: "sendInput", req: { projectSlug: "nowhere", sessionId: "x1", prompt: "a" }, result: "refused", reason: /unknown project/ },
  { name: "send refused: target named two ways", verb: "sendInput", req: { projectSlug: "p", sessionId: "cli-target", to: "reviewer@p", prompt: "a" }, result: "refused", reason: /one way only/ },
  { name: "send refused: reply from outside a session", verb: "sendInput", req: { projectSlug: "p", reply: true, prompt: "a" }, result: "refused", reason: /reply/ },
  { name: "send error: project not ready", verb: "sendInput", req: { projectSlug: "bare", sessionId: "cli-target", prompt: "a" }, result: "error", reason: /not ready/ },
  { name: "send not-found: no such session", verb: "sendInput", req: { projectSlug: "p", sessionId: "cli-missing", prompt: "a" }, result: "not-found", reason: /no session/, sessionsDir: true },
  { name: "send refused: shedding load", verb: "sendInput", req: { projectSlug: "p", sessionId: "cli-idle", prompt: "a" }, result: "refused", reason: /memory pressure/, idle: true, shed: true },
  { name: "open refused: human initiator", verb: "openSession", req: { projectSlug: "p", prompt: "a", initiator: "human" }, result: "refused", reason: /human/ },
  { name: "open refused: no prompt", verb: "openSession", req: { projectSlug: "p" }, result: "refused", reason: /prompt/ },
  { name: "open refused: unknown agent", verb: "openSession", req: { projectSlug: "p", prompt: "a", agentName: "nobody" }, result: "refused", reason: /unknown agent/ },
  { name: "open refused: unknown project", verb: "openSession", req: { projectSlug: "nowhere", prompt: "a" }, result: "refused", reason: /unknown project/ },
  { name: "open refused: unknown visibility", verb: "openSession", req: { projectSlug: "p", prompt: "a", sessionVisibility: "secret" }, result: "refused", reason: /sessionVisibility/ },
  { name: "open refused: permissionMode not a string", verb: "openSession", req: { projectSlug: "p", prompt: "a", permissionMode: 7 }, result: "refused", reason: /permissionMode/ },
  { name: "open refused: shedding load", verb: "openSession", req: { projectSlug: "p", prompt: "a" }, result: "refused", reason: /memory pressure/, shed: true },
  { name: "open error: project not ready", verb: "openSession", req: { projectSlug: "bare", prompt: "a" }, result: "error", reason: /not ready/ },
  // failures
  { name: "send error: the turn fails to start", verb: "sendInput", req: { projectSlug: "p", sessionId: "cli-idle", prompt: "a" }, result: "error", reason: /turn start failed/, idle: true, startThrows: true },
  { name: "send error: the turn fails to start asynchronously", verb: "sendInput", req: { projectSlug: "p", sessionId: "cli-idle", prompt: "a" }, result: "error", reason: /turn start failed/, idle: true, startAsync: "fail" },
  { name: "send delivered after an asynchronous start", verb: "sendInput", req: { projectSlug: "p", sessionId: "cli-idle", prompt: "a" }, result: "resumed-and-delivered", entryResult: "delivered", idle: true, startAsync: "ok" },
  { name: "open error: the first turn fails to start asynchronously", verb: "openSession", req: { projectSlug: "p", prompt: "a" }, result: "error", reason: /open failed/, startAsync: "fail" },
  { name: "open opened after an asynchronous start", verb: "openSession", req: { projectSlug: "p", prompt: "a" }, result: "opened", startAsync: "ok" },
  // a handler throw
  { name: "send, the handler throws", verb: "sendInput", req: { projectSlug: "boom", sessionId: "x1", prompt: "a" }, result: "error", reason: /unexpected failure: store exploded/ },
  { name: "open, the handler throws", verb: "openSession", req: { projectSlug: "boom", prompt: "a" }, result: "error", reason: /unexpected failure: store exploded/ },
];

function runShape(shape, withLedger) {
  var over = { noLedger: !withLedger, startThrows: shape.startThrows, startAsync: shape.startAsync };
  if (shape.sessionsDir) over.sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "outbound-si-store-"));
  var t = setup(over);
  if (shape.idle) t.p.sm.sessions.set(101, idleSession());
  if (shape.shed) setNewWorkGate(function () { return true; });
  var settled;
  var originalError = console.error;
  var originalLog = console.log;
  console.error = function () {};
  console.log = function () {};
  try {
    settled = Promise.resolve(t.input[shape.verb](Object.assign({}, shape.req)));
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
  return settled.then(function (result) {
    return { t: t, result: result };
  }).finally(function () {
    if (shape.shed) setNewWorkGate(null);
  });
}

SHAPES.forEach(function (shape) {
  test("caller shape: " + shape.name + ": the answer is the same with and without the ledger, and one entry is kept", async function () {
    var withIt = await runShape(shape, true);
    var without = await runShape(shape, false);
    assert.equal(withIt.result.result, shape.result);
    if (shape.reason) assert.match(withIt.result.reason, shape.reason);
    assert.deepEqual(withIt.result, without.result);

    var entries = all(withIt.t.ledger);
    assert.equal(entries.length, 1, JSON.stringify(entries));
    var e = entries[0];
    assert.equal(e.verb, shape.verb === "sendInput" ? "send_input" : "open_session");
    // A delivery is recorded as delivered whether or not the session had to be resumed first.
    assert.equal(e.result, shape.entryResult || shape.result);
    if (shape.sender) assert.equal(e.sender.kind, shape.sender);
    if (shape.initiator) assert.equal(e.initiator, shape.initiator);
    if (shape.reason) assert.match(e.reason, shape.reason);
    assert.deepEqual(all(without.t.ledger), []);
  });
});

test("caller shape: a result that is a Promise stays a Promise with the ledger on, and a synchronous one stays synchronous", async function () {
  var t = setup({ startAsync: "ok" });
  t.p.sm.sessions.set(101, idleSession());
  var pending = t.input.sendInput({ projectSlug: "p", sessionId: "cli-idle", prompt: "a" });
  assert.equal(typeof pending.then, "function");
  assert.equal((await pending).result, "resumed-and-delivered");
  var sync = t.input.sendInput({ projectSlug: "p", sessionId: "cli-target", prompt: "b" });
  assert.equal(typeof sync.then, "undefined");
});

test("caller shape: the console's own scheduled firing and a loop turn leave no entry, by design: the console is the sender, not a session", function () {
  var t = setup();
  var fired = t.input.fireScheduled({ projectSlug: "p", sessionId: "cli-target", prompt: "tick", initiator: "scheduled-now", force: true });
  assert.equal(fired.result, "delivered");
  // The first firing left the session mid-turn, so an ordinary one is skipped.
  var skipped = t.input.fireScheduled({ projectSlug: "p", sessionId: "cli-target", prompt: "tick again" });
  assert.equal(skipped.result, "busy");
  var refusedFire = t.input.fireScheduled({ projectSlug: "p", sessionId: "cli-target", prompt: "tick", initiator: "trigger" });
  assert.equal(refusedFire.result, "refused");
  assert.deepEqual(all(t.ledger), []);
  // Loops start their turns on the SDK directly (lib/project-loop.js), never
  // through these handlers, so there is nothing to record.
  var loopSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "project-loop.js"), "utf8");
  assert.equal(/session-input|sessionInput\.(sendInput|openSession)/.test(loopSrc), false);
});

test("caller shape: an external trigger file reaches the wrapped handlers and its sender fields are recorded", async function () {
  var { attachExternalTrigger } = require("../lib/project-external-trigger");
  var t = setup();
  var triggersDir = fs.mkdtempSync(path.join(os.tmpdir(), "outbound-si-trig-"));
  var trigger = attachExternalTrigger({
    triggersDir: triggersDir,
    getProject: function (slug) { return slug === "p" ? t.p : null; },
    sessionInput: t.input,
  });
  try {
    var drop = {
      version: 2, id: "trig-1", projectSlug: "p", sessionId: "cli-target", initialPrompt: "from a file",
      from: "cron-job", initiator: "trigger",
    };
    fs.writeFileSync(path.join(triggersDir, "trig-1.json"), JSON.stringify(drop));
    trigger.startWatcher();
    for (var i = 0; i < 100 && all(t.ledger).length === 0; i++) await new Promise(function (r) { setTimeout(r, 20); });
  } finally {
    trigger.stopWatcher();
  }
  var entries = all(t.ledger);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].verb, "send_input");
  assert.equal(entries[0].prompt, "from a file");
  assert.equal(entries[0].sender.kind, "declared");
  assert.equal(entries[0].sender.name, "cron-job");
});

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
  };
  (opts.existing || []).forEach(function (s) { sm.sessions.set(s.localId, s); });
  return {
    recorded: recorded,
    cwd: "/unused",
    sm: sm,
    sdk: {
      startQuery: function () { if (opts.startThrows) throw new Error("no runtime"); },
      pushMessage: function () {},
    },
    onProcessingChanged: function () {},
    getLinuxUserForSession: function () { return null; },
  };
}

// The target: a live session in project "p". The sender: a live session of the
// agent "holden" in project "q", which the console can resolve from the
// reference its environment carries.
function target() {
  return { localId: 100, cliSessionId: "cli-target", agentName: "reviewer", history: [], isProcessing: false, queryInstance: {} };
}
function senderSession() {
  return { localId: 7, cliSessionId: "cli-sender", agentName: "holden", history: [], isProcessing: true, queryInstance: {} };
}

function setup(over) {
  over = over || {};
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "outbound-si-"));
  var p = makeProject({ existing: [target()], startThrows: over.startThrows });
  var q = makeProject({ existing: [senderSession()] });
  var ledger = createOutboundLedger({ getBaseDir: function () { return dir; }, now: function () { return NOW; }, log: quiet() });
  var input = createSessionInput({
    getProject: function (slug) { return slug === "p" ? p : slug === "q" ? q : null; },
    agentCatalog: function () { return [{ name: "reviewer" }]; },
    outboundLedger: over.ledger || ledger,
    now: function () { return NOW; },
  });
  return { dir: dir, p: p, input: input, ledger: ledger };
}

function all(ledger) {
  return ledger.readAttributed().concat(ledger.readUnattributed());
}

var FROM_HOLDEN = { senderProject: "q", senderSessionId: "7" };

test("a delivered send-input is recorded with prompt, target, initiator and the same message id as the history entry", function () {
  var t = setup();
  var out = t.input.sendInput(Object.assign({ projectSlug: "p", sessionId: "cli-target", prompt: "please review", contextNote: "pr 12" }, FROM_HOLDEN));
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
    { kind: "extracted", attribution: "extracted", project: "q", sessionId: "7", cliSessionId: "cli-sender", agent: "holden" }
  );
  assert.equal(t.p.recorded.length, 1);
  assert.equal(e.messageId, t.p.recorded[0].messageId);
  assert.ok(e.messageId);
  assert.ok(fs.existsSync(path.join(t.dir, "outbound", "sessions", "q", "cli-sender.jsonl")));
});

test("an address and a reply are recorded as the caller gave them, with the session they resolved to", function () {
  var t = setup();
  t.input.sendInput(Object.assign({ to: "reviewer@p", prompt: "by address" }, FROM_HOLDEN));
  var e = all(t.ledger)[0];
  assert.equal(e.target.address, "reviewer@p");
  assert.equal(e.target.sessionId, "100");
  assert.equal(e.target.project, "p");
});

test("a delivered open-session is recorded once, as an open", function () {
  var t = setup();
  var out = t.input.openSession(Object.assign({ projectSlug: "p", prompt: "start here" }, FROM_HOLDEN));
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
  var refused = t.input.sendInput(Object.assign({ projectSlug: "nowhere", sessionId: "x1", prompt: "lost" }, FROM_HOLDEN));
  assert.equal(refused.result, "refused");
  var badInitiator = t.input.sendInput(Object.assign({ projectSlug: "p", sessionId: "cli-target", prompt: "as a person", initiator: "human" }, FROM_HOLDEN));
  assert.equal(badInitiator.result, "refused");

  var entries = all(t.ledger);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].result, "refused");
  assert.match(entries[0].reason, /unknown project/);
  assert.equal(entries[0].prompt, "lost");
  assert.equal(entries[0].sender.project, "q");
  assert.equal(entries[1].result, "refused");
  assert.match(entries[1].reason, /human/);
  assert.equal(entries[1].initiator, undefined);
  assert.equal(entries[1].messageId, undefined);
});

test("a refused open-session is recorded", function () {
  var t = setup();
  var out = t.input.openSession(Object.assign({ projectSlug: "p", prompt: "x", agentName: "nobody" }, FROM_HOLDEN));
  assert.equal(out.result, "refused");
  var entries = all(t.ledger);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].verb, "open_session");
  assert.match(entries[0].reason, /unknown agent/);
});

test("a request with no prompt is recorded without one", function () {
  var t = setup();
  t.input.sendInput(Object.assign({ projectSlug: "p", sessionId: "cli-target", prompt: "" }, FROM_HOLDEN));
  var e = all(t.ledger)[0];
  assert.equal(e.result, "refused");
  assert.equal("prompt" in e, false);
});

test("an open whose first turn fails to start is recorded as an error, with no message id", function () {
  var t = setup({ startThrows: true });
  var opened = t.input.openSession(Object.assign({ projectSlug: "p", prompt: "never starts" }, FROM_HOLDEN));
  assert.equal(opened.result, "error");
  var entries = all(t.ledger);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].verb, "open_session");
  assert.equal(entries[0].result, "error");
  assert.match(entries[0].reason, /open failed/);
  assert.equal(entries[0].prompt, "never starts");
  assert.equal("messageId" in entries[0], false);
});

test("a send that hits a failing start is recorded as an error with retryable set", function () {
  var t = setup({ startThrows: true });
  // An idle session with no runtime: delivery has to start a query, which fails.
  var idle = { localId: 101, cliSessionId: "cli-idle", history: [], isProcessing: false };
  t.p.sm.sessions.set(101, idle);
  var out = t.input.sendInput(Object.assign({ projectSlug: "p", sessionId: "cli-idle", prompt: "needs a start" }, FROM_HOLDEN));
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
  t.input.sendInput({ projectSlug: "p", sessionId: "cli-target", prompt: "forged", senderProject: "q", senderSessionId: "999", from: "holden@q" });
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
  var sent = t.input.sendInput(Object.assign({ projectSlug: "p", sessionId: "cli-target", prompt: "still delivered" }, FROM_HOLDEN));
  assert.equal(sent.result, "delivered");
  assert.equal(t.p.recorded.length, 1);
  var opened = t.input.openSession(Object.assign({ projectSlug: "p", prompt: "still opened" }, FROM_HOLDEN));
  assert.equal(opened.result, "opened");
  var refused = t.input.sendInput({ projectSlug: "nowhere", sessionId: "x", prompt: "still refused" });
  assert.equal(refused.result, "refused");
});

test("a ledger directory that cannot be written does not fail the send", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "outbound-si-bad-"));
  fs.writeFileSync(path.join(dir, "outbound"), "a file where the directory should be");
  var bad = createOutboundLedger({ getBaseDir: function () { return dir; }, now: function () { return NOW; }, log: quiet() });
  var t = setup({ ledger: bad });
  var sent = t.input.sendInput(Object.assign({ projectSlug: "p", sessionId: "cli-target", prompt: "delivered anyway" }, FROM_HOLDEN));
  assert.equal(sent.result, "delivered");
  assert.equal(t.p.recorded[0].text, "delivered anyway");
});

test("with no ledger configured nothing changes", function () {
  var p = makeProject({ existing: [target()] });
  var input = createSessionInput({ getProject: function (slug) { return slug === "p" ? p : null; } });
  assert.equal(input.sendInput({ projectSlug: "p", sessionId: "cli-target", prompt: "x" }).result, "delivered");
});

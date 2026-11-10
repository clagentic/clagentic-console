"use strict";
// answer-prompt answers one pending prompt of a live session through the prompt
// registry's respond(), the call a browser answer takes. An outcome table, the
// exactly-once race with the browser path, the responder record, the owner rule
// rows and the CLI arguments.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { createSessionInput } = require("../lib/session-input");
var { createOutboundLedger } = require("../lib/outbound-ledger");
var { promptsFor, ready } = require("../lib/prompt-registry");
var { attachPromptResponses } = require("../lib/project-prompt-responses");
var { handleSessionCommand } = require("../lib/session-input-ipc");
var { parseSessionArgs, exitCodeFor, SESSION_VERBS } = require("../lib/cli/session-subcommands");

var NOW = Date.now();
var BASH = { toolName: "Bash", toolInput: { command: "make" }, vendor: "claude" };
var PLAN = { toolName: "ExitPlanMode", toolInput: { plan: "p" }, vendor: "claude" };
var ONE_QUESTION = { questions: [{ question: "Which target?", options: [{ label: "prod" }, { label: "dev" }] }] };
var TWO_QUESTIONS = { questions: [{ question: "Which target?" }, { question: "Notify?" }] };

function liveSession(id, extra) {
  return Object.assign({
    localId: id,
    cliSessionId: "cli-" + id,
    history: [],
    isProcessing: true,
    queryInstance: { close: function () {} },
    abortController: { abort: function () {} },
    agentName: null,
  }, extra || {});
}

function makeWorld(sessions, opts) {
  opts = opts || {};
  var sent = [];
  var sm = {
    sessions: new Map(),
    sessionsDir: opts.sessionsDir,
    defaultVendor: "claude",
    sendAndRecord: function (s, m) { sent.push(m); s.history.push(m); },
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
  };
  sessions.forEach(function (s) { sm.sessions.set(s.localId, s); });
  var project = {
    cwd: "/unused",
    sm: sm,
    sdk: {},
    send: function () {},
    onProcessingChanged: function () {},
    getLinuxUserForSession: opts.getLinuxUserForSession || function () { return null; },
  };
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "answer-prompt-"));
  var ledger = createOutboundLedger({
    getBaseDir: function () { return dir; },
    now: function () { return NOW; },
    log: { error: function () {}, warn: function () {}, log: function () {} },
  });
  var input = createSessionInput({
    getProject: function (slug) { return slug === "p" ? project : null; },
    outboundLedger: ledger,
    now: function () { return NOW; },
  });
  return { input: input, sm: sm, sent: sent, ledger: ledger, project: project, dir: dir };
}

function open(w, s, kind, req, toolUseId) {
  return promptsFor(w.sm).open(s, kind, req, { toolUseId: toolUseId });
}

function resolvedEvents(w) {
  return w.sent.filter(function (m) { return m.type === "prompt_resolved"; });
}

function answer(w, requestId, decision, extra) {
  return w.input.answerPrompt(Object.assign({ projectSlug: "p", sessionId: "1", requestId: requestId, decision: decision }, extra || {}));
}

test.before(function () { return ready(); });

// ---- outcome table ----

test("answered: a permission prompt allowed through respond(), source caller:<from>", async function () {
  var s = liveSession(1);
  var w = makeWorld([s]);
  var p = open(w, s, "permission", BASH, "tu-1");
  var r = answer(w, p.requestId, "allow", { from: "coordinator" });
  assert.equal(r.ok, true);
  assert.equal(r.result, "answered");
  assert.equal(r.requestId, p.requestId);
  assert.equal(r.kind, "permission");
  assert.equal(r.source, "caller:coordinator");
  assert.equal((await p.answer).behavior, "allow");
  assert.equal(promptsFor(w.sm).lookup(p.requestId), null);
});

test("answered: deny and allow_always on a permission prompt", async function () {
  var s = liveSession(1);
  var w = makeWorld([s]);
  var denied = open(w, s, "permission", BASH, "tu-d");
  assert.equal(answer(w, denied.requestId, "deny").result, "answered");
  assert.equal((await denied.answer).behavior, "deny");
  var always = open(w, s, "permission", BASH, "tu-a");
  assert.equal(answer(w, always.requestId, "allow_always").result, "answered");
  assert.equal((await always.answer).behavior, "allow");
  assert.equal(resolvedEvents(w)[1].decision, "allow_always");
});

test("answered: a plan prompt resolves as the matching browser answer", async function () {
  var s = liveSession(1);
  var w = makeWorld([s]);
  var p = open(w, s, "plan", PLAN, "tu-plan");
  var r = answer(w, p.requestId, "allow");
  assert.equal(r.result, "answered");
  assert.equal(r.kind, "plan");
  assert.equal((await p.answer).behavior, "allow");
  assert.equal(resolvedEvents(w)[0].decision, "allow");
});

test("answered: a single question takes the decision as its answer text, and skip skips", async function () {
  var s = liveSession(1);
  var w = makeWorld([s]);
  var q = open(w, s, "ask_user", { input: ONE_QUESTION }, "tu-q");
  var r = answer(w, q.requestId, "prod");
  assert.equal(r.result, "answered");
  assert.equal(r.kind, "ask_user");
  var value = await q.answer;
  assert.equal(value.behavior, "allow");
  assert.deepEqual(resolvedEvents(w)[0].answers, { 0: "prod" });
  var skipped = open(w, s, "ask_user", { input: ONE_QUESTION }, "tu-skip");
  assert.equal(answer(w, skipped.requestId, "skip").result, "answered");
  assert.equal((await skipped.answer).behavior, "deny");
});

test("answered: an elicitation is accepted or declined by allow and deny", async function () {
  var s = liveSession(1);
  var w = makeWorld([s]);
  var declined = open(w, s, "elicitation", { serverName: "srv", message: "?" }, "tu-e");
  assert.equal(answer(w, declined.requestId, "deny").result, "answered");
  assert.equal((await declined.answer).action, "reject");
});

test("answered: a subagent's prompt resolves by request id through the same path", async function () {
  var s = liveSession(1);
  var w = makeWorld([s]);
  var registry = promptsFor(w.sm);
  registry.taskStarted(s, "task-1");
  registry.noteSubagentTool(s, "tu-sub", "task-1");
  var p = open(w, s, "permission", BASH, "tu-sub");
  var r = answer(w, p.requestId, "allow", { from: "coordinator" });
  assert.equal(r.result, "answered");
  assert.equal((await p.answer).behavior, "allow");
});

test("not-found: an unknown request id changes nothing", function () {
  var s = liveSession(1);
  var w = makeWorld([s]);
  var p = open(w, s, "permission", BASH, "tu-1");
  var r = answer(w, "no-such-request", "allow");
  assert.equal(r.ok, false);
  assert.equal(r.result, "not-found");
  assert.equal(r.requestId, "no-such-request");
  assert.ok(promptsFor(w.sm).lookup(p.requestId));
  assert.equal(resolvedEvents(w).length, 0);
});

test("not-found: a request that belongs to another session is not answered", function () {
  var a = liveSession(1);
  var b = liveSession(2);
  var w = makeWorld([a, b]);
  var p = open(w, b, "permission", BASH, "tu-b");
  var r = answer(w, p.requestId, "allow");
  assert.equal(r.result, "not-found");
  assert.ok(promptsFor(w.sm).lookup(p.requestId));
});

test("not-found: a session id the console does not hold", async function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "answer-store-"));
  var w = makeWorld([liveSession(1)], { sessionsDir: dir });
  var r = await answer(w, "r", "allow", { sessionId: "nope" });
  assert.equal(r.ok, false);
  assert.equal(r.result, "not-found");
});

test("not-found: a kind the operator may not answer", function () {
  var s = liveSession(1);
  var w = makeWorld([s]);
  var p = open(w, null, "extension", { command: "x" }, "tu-x");
  var r = w.input.answerPrompt({ projectSlug: "p", sessionId: "1", requestId: p.requestId, decision: "allow" });
  assert.equal(r.result, "not-found");
});

test("already-settled: a request the browser path answered first changes nothing", function () {
  var s = liveSession(1);
  var w = makeWorld([s]);
  var p = open(w, s, "permission", BASH, "tu-1");
  assert.equal(answer(w, p.requestId, "allow", { from: "first" }).result, "answered");
  var again = answer(w, p.requestId, "deny", { from: "second" });
  assert.equal(again.ok, false);
  assert.equal(again.result, "already-settled");
  assert.equal(again.settledBy, "caller:first");
  assert.equal(resolvedEvents(w).length, 1);
});

test("already-settled: a request cancelled with its session", function () {
  var s = liveSession(1);
  var w = makeWorld([s]);
  var p = open(w, s, "permission", BASH, "tu-1");
  promptsFor(w.sm).cancelSession(s, "ended", { source: "user" });
  assert.equal(answer(w, p.requestId, "allow").result, "already-settled");
});

test("invalid: a decision the kind does not accept leaves the prompt pending", function () {
  var s = liveSession(1);
  var w = makeWorld([s]);
  var perm = open(w, s, "permission", BASH, "tu-1");
  var plan = open(w, s, "plan", PLAN, "tu-2");
  var ask = open(w, s, "ask_user", { input: ONE_QUESTION }, "tu-3");
  var many = open(w, s, "ask_user", { input: TWO_QUESTIONS }, "tu-4");
  var elicit = open(w, s, "elicitation", { serverName: "srv", message: "?" }, "tu-5");
  [
    [perm, "maybe"],
    [plan, "deny_with_feedback"],
    [plan, "nonsense"],
    [ask, "allow"],
    [many, "prod"],
    [elicit, "allow_always"],
  ].forEach(function (row) {
    var r = answer(w, row[0].requestId, row[1]);
    assert.equal(r.ok, false);
    assert.equal(r.result, "invalid", row[1]);
    assert.ok(r.reason);
    assert.ok(promptsFor(w.sm).lookup(row[0].requestId), "still pending after " + row[1]);
  });
  assert.equal(resolvedEvents(w).length, 0);
});

test("invalid: allow_always on an ask that does not offer it stays pending", function () {
  var s = liveSession(1);
  var w = makeWorld([s]);
  var p = open(w, s, "permission", Object.assign({ suppressAlwaysAllowRule: true }, BASH), "tu-1");
  var r = answer(w, p.requestId, "allow_always");
  assert.equal(r.result, "invalid");
  assert.ok(promptsFor(w.sm).lookup(p.requestId));
});

test("ambiguous: an address matching several sessions answers none and lists candidates", function () {
  var a = liveSession(1);
  var b = liveSession(2);
  var w = makeWorld([a, b]);
  var p = open(w, a, "permission", BASH, "tu-1");
  // Both sessions wait on a prompt, so they share the prompt-blocked tier; a
  // running twin of a prompt-blocked session would outrank it.
  open(w, b, "permission", BASH, "tu-2");
  var r = w.input.answerPrompt({ to: "@p", requestId: p.requestId, decision: "allow" });
  assert.equal(r.ok, false);
  assert.equal(r.result, "ambiguous");
  assert.equal(r.candidates.length, 2);
  assert.ok(promptsFor(w.sm).lookup(p.requestId));
});

test("an address matching one session answers its prompt", function () {
  var a = liveSession(1);
  var w = makeWorld([a]);
  var p = open(w, a, "permission", BASH, "tu-1");
  assert.equal(w.input.answerPrompt({ to: "@p", requestId: p.requestId, decision: "allow" }).result, "answered");
});

test("refused: a bad from, an empty request id and conflicting targets", function () {
  var w = makeWorld([liveSession(1)]);
  assert.equal(answer(w, "r", "allow", { from: "bad name!" }).result, "refused");
  assert.equal(answer(w, "", "allow").result, "refused");
  assert.equal(answer(w, "r", "").result, "refused");
  assert.equal(answer(w, "r", "allow", { to: "@p" }).result, "refused");
});

// ---- exactly once: the browser path and the verb answer together ----

test("race: the browser answer and the verb answer together, exactly one wins and the record shows which", function () {
  [["browser first", true], ["verb first", false]].forEach(function (row) {
    var s = liveSession(1);
    var w = makeWorld([s]);
    var noop = function () {};
    var staleReplies = [];
    var responses = attachPromptResponses({
      sm: w.sm, sdk: {}, send: noop, sendToSession: noop,
      sendTo: function (ws, m) { staleReplies.push(m); },
      getSessionForWs: function () { return s; },
      ensureProjectAccessForSession: function () { return null; },
    });
    var p = open(w, s, "permission", BASH, "tu-race");
    var viaVerb;
    var viaBrowser = function () { responses.handlePromptMessage({}, { type: "prompt_response", kind: "permission", requestId: p.requestId, decision: "allow" }); };
    var verb = function () { viaVerb = answer(w, p.requestId, "deny", { from: "coordinator" }); };
    if (row[1]) { viaBrowser(); verb(); } else { verb(); viaBrowser(); }

    var events = resolvedEvents(w);
    assert.equal(events.length, 1, row[0]);
    if (row[1]) {
      assert.equal(viaVerb.result, "already-settled", row[0]);
      assert.equal(events[0].source.kind, "ws");
      assert.equal(events[0].decision, "allow");
      assert.equal(staleReplies.length, 0);
    } else {
      assert.equal(viaVerb.result, "answered", row[0]);
      assert.equal(events[0].source, "caller:coordinator");
      assert.equal(events[0].decision, "deny");
      assert.equal(staleReplies.length, 1);
      assert.equal(staleReplies[0].reason, "stale");
    }
  });
});

test("race: two verb calls on one request, one answers and the other is already-settled", function () {
  var s = liveSession(1);
  var w = makeWorld([s]);
  var p = open(w, s, "permission", BASH, "tu-1");
  var results = [answer(w, p.requestId, "allow", { from: "a" }), answer(w, p.requestId, "allow", { from: "b" })];
  assert.deepEqual(results.map(function (r) { return r.result; }), ["answered", "already-settled"]);
  assert.equal(resolvedEvents(w).length, 1);
});

// ---- the responder record ----

test("responder record: caller:<from> with --from, user without, on the session event and in the outcome", function () {
  var s = liveSession(1);
  var w = makeWorld([s]);
  var named = open(w, s, "permission", BASH, "tu-n");
  var anon = open(w, s, "permission", BASH, "tu-u");
  assert.equal(answer(w, named.requestId, "allow", { from: "ci.bot" }).source, "caller:ci.bot");
  assert.equal(answer(w, anon.requestId, "allow").source, "user");
  var events = resolvedEvents(w);
  assert.deepEqual(events.map(function (e) { return e.source; }), ["caller:ci.bot", "user"]);
  assert.deepEqual(events.map(function (e) { return e.requestId; }), [named.requestId, anon.requestId]);
});

test("the outbound ledger records the call without the decision text", function () {
  var s = liveSession(1);
  var w = makeWorld([s]);
  var p = open(w, s, "ask_user", { input: ONE_QUESTION }, "tu-q");
  answer(w, p.requestId, "prod", { from: "coordinator" });
  var files = fs.readdirSync(w.dir, { recursive: true }).filter(function (f) { return /\.jsonl?$/.test(String(f)); });
  assert.ok(files.length > 0, "a ledger file was written");
  var text = files.map(function (f) { return fs.readFileSync(path.join(w.dir, String(f)), "utf8"); }).join("\n");
  var entry = JSON.parse(text.trim().split("\n").pop());
  assert.equal(entry.verb, "answer_prompt");
  assert.equal(entry.result, "answered");
  assert.equal(entry.requestId, p.requestId);
  assert.equal(entry.promptKind, "ask_user");
  assert.equal(entry.target.sessionId, "1");
  assert.equal(entry.sender.name, "coordinator");
  assert.ok(text.indexOf("prod") === -1, "the answer text is not stored");
});

// ---- owner rule: the trust send-input applies ----

test("owner rule: os-users mode, a session running as another OS user is answered as send-input reaches it", function () {
  var s = liveSession(1);
  var w = makeWorld([s], { getLinuxUserForSession: function () { return "otheruser"; } });
  var p = open(w, s, "permission", BASH, "tu-1");
  assert.equal(answer(w, p.requestId, "allow").result, "answered");
});

test("owner rule: multi-user mode, a session owned by another user is answered as send-input reaches it", function () {
  var s = liveSession(1, { ownerId: "u-other", visibility: "private" });
  var w = makeWorld([s]);
  var p = open(w, s, "permission", BASH, "tu-1");
  assert.equal(answer(w, p.requestId, "allow").result, "answered");
});

test("owner rule: a reply-style reference is not a way to name the target", function () {
  var w = makeWorld([liveSession(1)]);
  var r = w.input.answerPrompt({ reply: true, requestId: "r", decision: "allow" });
  assert.notEqual(r.result, "answered");
});

// ---- IPC and CLI ----

test("the IPC handler passes the answer_prompt fields through", function () {
  var seen;
  var fake = { answerPrompt: function (req) { seen = req; return { ok: true }; } };
  handleSessionCommand(fake, { cmd: "answer_prompt", projectSlug: "p", sessionId: "1", to: "t", requestId: "r", decision: "d", from: "f", fromSession: "fs" });
  assert.deepEqual(
    { p: seen.projectSlug, s: seen.sessionId, t: seen.to, r: seen.requestId, d: seen.decision, f: seen.from, fs: seen.fromSession },
    { p: "p", s: "1", t: "t", r: "r", d: "d", f: "f", fs: "fs" });
});

test("cli: answer-prompt is a session verb", function () {
  assert.ok(SESSION_VERBS.indexOf("answer-prompt") !== -1);
});

test("cli: by id and by address parse, with the request, decision and sender flags", function () {
  var byId = parseSessionArgs("answer-prompt", ["--project", "p", "--session", "3", "--request", "r1", "--decision", "allow", "--from", "coord", "--from-session", "abc"]);
  assert.deepEqual(byId.request, { projectSlug: "p", sessionId: "3", requestId: "r1", decision: "allow", from: "coord", fromSession: "abc" });
  assert.deepEqual(parseSessionArgs("answer-prompt", ["--to", "a@p", "--request", "r1", "--decision", "deny"]).request, { to: "a@p", requestId: "r1", decision: "deny" });
});

test("cli: the request and the decision are required", function () {
  assert.match(parseSessionArgs("answer-prompt", ["--project", "p", "--session", "3", "--decision", "allow"]).error, /--request/);
  assert.match(parseSessionArgs("answer-prompt", ["--project", "p", "--session", "3", "--request", "r"]).error, /--decision/);
});

test("cli: the target rules match end-session", function () {
  var rest = ["--request", "r", "--decision", "allow"];
  assert.match(parseSessionArgs("answer-prompt", rest).error, /Missing the target/);
  assert.match(parseSessionArgs("answer-prompt", ["--project", "p"].concat(rest)).error, /--session/);
  assert.match(parseSessionArgs("answer-prompt", ["--session", "3"].concat(rest)).error, /--project/);
  assert.match(parseSessionArgs("answer-prompt", ["--to", "a@p", "--session", "3"].concat(rest)).error, /one way only/);
});

test("cli: options that belong to other verbs are unknown", function () {
  var base = ["--project", "p", "--session", "1", "--request", "r", "--decision", "allow"];
  assert.match(parseSessionArgs("answer-prompt", base.concat(["--prompt", "x"])).error, /Unknown option/);
  assert.match(parseSessionArgs("answer-prompt", base.concat(["--reason", "x"])).error, /Unknown option/);
  assert.match(parseSessionArgs("answer-prompt", base.concat(["--reply"])).error, /Unknown option/);
  assert.match(parseSessionArgs("answer-prompt", ["--request"]).error, /Missing value/);
  assert.match(parseSessionArgs("send-input", ["--project", "p", "--session", "1", "--prompt", "x", "--request", "r"]).error, /Unknown option/);
});

test("cli: exit codes follow end-session (answered 0, ambiguous 3, not found by address 4, else 1)", function () {
  assert.equal(exitCodeFor({ ok: true, result: "answered" }, { sessionId: "1" }), 0);
  assert.equal(exitCodeFor({ ok: false, result: "ambiguous" }, { to: "@p" }), 3);
  assert.equal(exitCodeFor({ ok: false, result: "not-found" }, { to: "@p" }), 4);
  assert.equal(exitCodeFor({ ok: false, result: "not-found" }, { sessionId: "1" }), 1);
  assert.equal(exitCodeFor({ ok: false, result: "already-settled" }, { sessionId: "1" }), 1);
  assert.equal(exitCodeFor({ ok: false, result: "invalid" }, { sessionId: "1" }), 1);
});

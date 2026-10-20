// list-sessions, send-input --to / --reply and open-session --to: the session
// directory, address resolution, the refusal on ambiguity, and the CLI shapes.

var test = require("node:test");
var assert = require("node:assert/strict");

var { createSessionInput } = require("../lib/session-input");
var directory = require("../lib/session-directory");
var { senderFields } = require("../lib/injected-sender");
var { handleSessionCommand } = require("../lib/session-input-ipc");
var sender = require("../lib/sender-ref");
var cli = require("../lib/cli/session-subcommands");

// A session as the manager holds it. `runtime` is "live" (a turn running),
// "idle" (runtime attached) or "reaped" (none).
function session(localId, opts) {
  opts = opts || {};
  var runtime = opts.runtime || "idle";
  return {
    localId: localId,
    cliSessionId: opts.cliSessionId === undefined ? "cli-" + localId : opts.cliSessionId,
    agentName: opts.agent || null,
    vendor: opts.vendor === undefined ? "claude" : opts.vendor,
    title: opts.title || "t" + localId,
    lastActivity: opts.lastActivity || 1700000000000 + localId * 1000,
    isProcessing: runtime === "live",
    queryInstance: runtime === "reaped" ? null : {},
    history: opts.history || [],
    hidden: !!opts.hidden,
  };
}

function project(sessions, calls) {
  var sm = {
    sessions: new Map(),
    defaultVendor: "claude",
    recordHistoryEntry: function (s, e) { s.history.push(e); calls.recorded.push({ localId: s.localId, entry: e }); },
    appendToSessionFile: function () {},
    createSession: function (o) {
      calls.created.push(o);
      var s = session(900 + calls.created.length, { cliSessionId: null, runtime: "reaped", vendor: o.vendor || null, agent: o.agentName });
      sm.sessions.set(s.localId, s);
      return s;
    },
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    deleteSession: function () {},
  };
  sessions.forEach(function (s) { sm.sessions.set(s.localId, s); });
  return {
    cwd: "/unused",
    sm: sm,
    sdk: {
      startQuery: function (s, text, images, user, initiator) { calls.start.push({ localId: s.localId, text: text, initiator: initiator }); },
      pushMessage: function (s, text, images, initiator) { calls.push.push({ localId: s.localId, text: text, initiator: initiator }); },
    },
    onProcessingChanged: function () {},
    getLinuxUserForSession: function () { return null; },
  };
}

function world(byProject) {
  var calls = { recorded: [], created: [], start: [], push: [] };
  var projects = {};
  Object.keys(byProject).forEach(function (slug) { projects[slug] = project(byProject[slug], calls); });
  var input = createSessionInput({
    getProject: function (slug) { return Object.prototype.hasOwnProperty.call(projects, slug) ? projects[slug] : null; },
    listProjects: function () { return Object.keys(projects).map(function (slug) { return { slug: slug, project: projects[slug] }; }); },
    agentCatalog: function () { return [{ name: "Holden" }, { name: "naomi" }]; },
  });
  return { calls: calls, input: input, projects: projects };
}

// ---- list-sessions ----

test("list: every kind of session, with label, state and activity, newest first", function () {
  var w = world({
    lore: [
      session(1, { vendor: "claude", runtime: "reaped" }),
      session(2, { vendor: "codex", runtime: "idle" }),
      session(3, { agent: "Holden", runtime: "live" }),
      session(4, { vendor: "claude", hidden: true }),
      session(5, { cliSessionId: null, runtime: "reaped" }),
    ],
  });
  var r = w.input.listSessions({});
  assert.equal(r.ok, true);
  assert.equal(r.result, "listed");
  assert.equal(r.count, 3);
  assert.deepEqual(r.sessions.map(function (s) { return s.consoleSessionId; }), ["3", "2", "1"]);
  var named = r.sessions[0];
  assert.equal(named.label, "Holden@lore");
  assert.equal(named.agent, "Holden");
  assert.equal(named.state, "live");
  assert.equal(named.project, "lore");
  assert.equal(named.sessionId, "cli-3");
  assert.equal(named.lastActivity, new Date(1700000003000).toISOString());
  assert.equal(r.sessions[1].label, "codex@lore");
  assert.equal(r.sessions[1].agent, null);
  assert.equal(r.sessions[1].state, "idle");
  assert.equal(r.sessions[2].state, "reaped");
});

test("list: a plain session with no vendor of its own takes the project default", function () {
  var w = world({ lore: [session(1, { vendor: null })] });
  assert.equal(w.input.listSessions({}).sessions[0].label, "claude@lore");
});

test("list: filters by project, agent, vendor and state combine", function () {
  var w = world({
    lore: [session(1, { vendor: "claude" }), session(2, { vendor: "codex", runtime: "reaped" }), session(3, { agent: "Holden", runtime: "live" })],
    other: [session(1, { vendor: "claude" })],
  });
  var ids = function (req) { return w.input.listSessions(req).sessions.map(function (s) { return s.project + "/" + s.consoleSessionId; }).sort(); };
  assert.deepEqual(ids({ projectSlug: "other" }), ["other/1"]);
  assert.deepEqual(ids({ agentName: "holden" }), ["lore/3"]);
  assert.deepEqual(ids({ vendor: "codex" }), ["lore/2"]);
  assert.deepEqual(ids({ state: "reaped" }), ["lore/2"]);
  assert.deepEqual(ids({ projectSlug: "lore", vendor: "claude", state: "idle" }), ["lore/1"]);
  assert.equal(ids({ state: "any" }).length, 4);
});

test("list: an unknown state or project is refused, and nothing is written", function () {
  var w = world({ lore: [session(1)] });
  var state = w.input.listSessions({ state: "asleep" });
  assert.equal(state.result, "refused");
  assert.match(state.reason, /asleep/);
  assert.equal(w.input.listSessions({ projectSlug: "nope" }).result, "refused");
  assert.equal(w.calls.recorded.length + w.calls.push.length + w.calls.start.length + w.calls.created.length, 0);
});

// ---- address parsing ----

test("parseAddress: the three forms, and what is refused", function () {
  assert.deepEqual(directory.parseAddress("holden@lore"), { project: "lore", token: "holden" });
  assert.deepEqual(directory.parseAddress("Claude@lore"), { project: "lore", token: "claude" });
  assert.deepEqual(directory.parseAddress("@lore"), { project: "lore", token: "" });
  ["", "lore", "a@", "a@b@c", "a b@lore", "!!!@lore", 7, null].forEach(function (bad) {
    assert.ok(directory.parseAddress(bad).error, "refused: " + String(bad));
  });
  assert.ok(directory.parseAddress("a@" + "x".repeat(300)).error);
});

// ---- send-input --to ----

test("to: a named agent resolves by agent and is delivered into its running query", function () {
  var w = world({ lore: [session(1, { vendor: "claude" }), session(2, { agent: "Holden" })] });
  var r = w.input.sendInput({ to: "holden@lore", prompt: "hi" });
  assert.equal(r.result, "delivered");
  assert.equal(r.resolvedBy, "to");
  assert.equal(r.project, "lore");
  assert.equal(r.label, "Holden@lore");
  assert.equal(r.consoleSessionId, "2");
  assert.deepEqual(w.calls.push.map(function (c) { return c.localId; }), [2]);
});

test("to: vendor@project reaches the one plain claude session, and plain codex the codex one", function () {
  var w = world({ lore: [session(1, { vendor: "claude" }), session(2, { vendor: "codex" }), session(3, { agent: "Holden", vendor: "claude" })] });
  assert.equal(w.input.sendInput({ to: "claude@lore", prompt: "a" }).consoleSessionId, "1");
  assert.equal(w.input.sendInput({ to: "codex@lore", prompt: "b" }).consoleSessionId, "2");
  assert.deepEqual(w.calls.push.map(function (c) { return c.localId; }), [1, 2]);
});

test("to: a vendor address never reaches a named-agent session of that vendor", function () {
  var w = world({ lore: [session(3, { agent: "Holden", vendor: "claude" })] });
  var r = w.input.sendInput({ to: "claude@lore", prompt: "a" });
  assert.equal(r.result, "not-found");
  assert.equal(w.calls.push.length, 0);
});

test("to: several plain sessions are refused with candidates, nothing is delivered", function () {
  var w = world({ lore: [session(1, { title: "first" }), session(2, { title: "second", runtime: "live" })] });
  var r = w.input.sendInput({ to: "claude@lore", prompt: "hi" });
  assert.equal(r.ok, false);
  assert.equal(r.result, "ambiguous");
  assert.equal(r.to, "claude@lore");
  assert.deepEqual(r.candidates.map(function (c) { return c.consoleSessionId; }), ["2", "1"]);
  var c = r.candidates[0];
  assert.equal(c.label, "claude@lore");
  assert.equal(c.title, "second");
  assert.equal(c.state, "live");
  assert.equal(c.project, "lore");
  assert.ok(c.lastActivity);
  assert.equal(w.calls.push.length + w.calls.start.length + w.calls.recorded.length, 0);
});

test("to: @project is ambiguous with several sessions and delivers with exactly one", function () {
  var several = world({ lore: [session(1), session(2, { agent: "Holden" })] });
  assert.equal(several.input.sendInput({ to: "@lore", prompt: "x" }).result, "ambiguous");
  var one = world({ lore: [session(7)] });
  var r = one.input.sendInput({ to: "@lore", prompt: "x" });
  assert.equal(r.result, "delivered");
  assert.equal(r.consoleSessionId, "7");
});

test("to: a refused ambiguity is resolved by the id it lists", function () {
  var w = world({ lore: [session(1), session(2)] });
  var r = w.input.sendInput({ to: "@lore", prompt: "x" });
  var pick = r.candidates[1];
  var again = w.input.sendInput({ projectSlug: pick.project, sessionId: pick.consoleSessionId, prompt: "x" });
  assert.equal(again.result, "delivered");
  assert.equal(again.consoleSessionId, pick.consoleSessionId);
});

test("to: a session with a runtime is preferred over a reaped one", function () {
  var w = world({ lore: [session(1, { agent: "Holden", runtime: "reaped" }), session(2, { agent: "Holden", runtime: "idle" })] });
  var r = w.input.sendInput({ to: "holden@lore", prompt: "x" });
  assert.equal(r.result, "delivered");
  assert.equal(r.consoleSessionId, "2");
  assert.equal(w.calls.start.length, 0);
});

test("to: several with a runtime are ambiguous even when a reaped one exists", function () {
  var w = world({ lore: [session(1, { agent: "Holden", runtime: "reaped" }), session(2, { agent: "Holden" }), session(3, { agent: "Holden", runtime: "live" })] });
  var r = w.input.sendInput({ to: "holden@lore", prompt: "x" });
  assert.equal(r.result, "ambiguous");
  assert.deepEqual(r.candidates.map(function (c) { return c.consoleSessionId; }).sort(), ["2", "3"]);
});

test("to: a single reaped match is resumed and delivered", function () {
  var w = world({ lore: [session(1, { agent: "Holden", runtime: "reaped" })] });
  var r = w.input.sendInput({ to: "holden@lore", prompt: "wake up", initiator: "scheduled" });
  assert.equal(r.result, "resumed-and-delivered");
  assert.equal(r.resolvedBy, "to");
  assert.deepEqual(w.calls.start, [{ localId: 1, text: "wake up", initiator: "scheduled" }]);
  assert.equal(w.calls.push.length, 0);
});

test("to: no match is not-found, an unknown project or bad address is refused", function () {
  var w = world({ lore: [session(1, { vendor: "claude" })] });
  var none = w.input.sendInput({ to: "codex@lore", prompt: "x" });
  assert.equal(none.result, "not-found");
  assert.equal(none.ok, false);
  assert.equal(w.input.sendInput({ to: "claude@nowhere", prompt: "x" }).result, "refused");
  assert.equal(w.input.sendInput({ to: "claude-lore", prompt: "x" }).result, "refused");
  assert.equal(w.calls.push.length + w.calls.start.length, 0);
});

test("to: --project beside --to must be the address's project; one way of naming only", function () {
  var w = world({ lore: [session(1)], other: [session(1)] });
  assert.equal(w.input.sendInput({ to: "@lore", projectSlug: "lore", prompt: "x" }).result, "delivered");
  var mismatch = w.input.sendInput({ to: "@lore", projectSlug: "other", prompt: "x" });
  assert.equal(mismatch.result, "refused");
  var both = w.input.sendInput({ to: "@lore", sessionId: "1", projectSlug: "lore", prompt: "x" });
  assert.equal(both.result, "refused");
  assert.match(both.reason, /one way only/);
  assert.equal(w.input.sendInput({ to: "@lore", reply: true, prompt: "x" }).result, "refused");
});

test("to: the delivered input is recorded with the caller's extracted sender", function () {
  var w = world({
    lane: [session(3, { agent: "naomi", runtime: "idle" })],
    lore: [session(2, { agent: "Holden" })],
  });
  var r = w.input.sendInput({ to: "holden@lore", prompt: "report", senderProject: "lane", senderSessionId: "3" });
  assert.equal(r.result, "delivered");
  var entry = w.calls.recorded[0].entry;
  assert.equal(entry.senderKind, "extracted");
  assert.equal(entry.fromName, "naomi@lane");
  assert.equal(entry.senderSessionId, "3");
  assert.equal(entry.senderCliSessionId, "cli-3", "recorded from the sender's own session at injection time");
});

// ---- send-input --reply ----

function injected(extra) {
  return Object.assign({ type: "user_message", text: "ping", source: "external-trigger", initiator: "trigger" }, extra);
}

// cliSessionId defaults to what session() gives the sender; null records none.
function extractedFrom(name, project, sessionId, cliSessionId) {
  var parts = name.split("@");
  return senderFields("trigger", undefined, {
    name: name,
    project: project,
    sessionId: sessionId,
    cliSessionId: cliSessionId === undefined ? "cli-" + sessionId : cliSessionId,
    agent: parts[0] === "claude" ? null : parts[0],
    agentSlug: parts[0] === "claude" ? null : parts[0],
    vendor: "claude",
  });
}

test("reply: goes to the session that last injected into the caller", function () {
  var history = [
    { type: "user_message", text: "typed" },
    injected(extractedFrom("naomi@lane", "lane", "3")),
    { type: "assistant_message", text: "ok" },
  ];
  var w = world({
    lore: [session(2, { agent: "Holden", history: history })],
    lane: [session(3, { agent: "naomi" })],
  });
  var r = w.input.sendInput({ reply: true, prompt: "done", senderProject: "lore", senderSessionId: "2" });
  assert.equal(r.result, "delivered");
  assert.equal(r.resolvedBy, "reply");
  assert.equal(r.project, "lane");
  assert.equal(r.consoleSessionId, "3");
  assert.deepEqual(w.calls.push.map(function (c) { return c.localId; }), [3]);
  var recorded = w.calls.recorded[0].entry;
  assert.equal(recorded.fromName, "Holden@lore");
  assert.equal(recorded.senderSessionId, "2");
});

test("reply: only the most recent injected message counts", function () {
  var history = [
    injected(extractedFrom("naomi@lane", "lane", "3")),
    injected(extractedFrom("claude@lane", "lane", "4")),
  ];
  var w = world({
    lore: [session(2, { agent: "Holden", history: history })],
    lane: [session(3, { agent: "naomi" }), session(4, { vendor: "claude" })],
  });
  var r = w.input.sendInput({ reply: true, prompt: "done", senderProject: "lore", senderSessionId: "2" });
  assert.equal(r.consoleSessionId, "4");
});

test("reply: a reaped sender is resumed and delivered", function () {
  var w = world({
    lore: [session(2, { agent: "Holden", history: [injected(extractedFrom("naomi@lane", "lane", "3"))] })],
    lane: [session(3, { agent: "naomi", runtime: "reaped" })],
  });
  var r = w.input.sendInput({ reply: true, prompt: "done", senderProject: "lore", senderSessionId: "2" });
  assert.equal(r.result, "resumed-and-delivered");
  assert.equal(w.calls.start[0].localId, 3);
});

test("reply: the caller's history is loaded before it is read", function () {
  var loaded = [];
  var caller = session(2, { agent: "Holden" });
  var w = world({ lore: [caller], lane: [session(3, { agent: "naomi" })] });
  w.projects.lore.sm.loadSessionHistory = function (s) {
    loaded.push(s.localId);
    s.history = [injected(extractedFrom("naomi@lane", "lane", "3"))];
  };
  var r = w.input.sendInput({ reply: true, prompt: "done", senderProject: "lore", senderSessionId: "2" });
  assert.deepEqual(loaded, [2]);
  assert.equal(r.result, "delivered");
});

test("reply: refused, with the reason, when there is no recorded sender", function () {
  var cases = [
    { name: "declared", history: [injected({ senderKind: "declared", fromName: "someone", from: "injected:trigger" })], why: /declared/ },
    { name: "undeclared", history: [injected({ senderKind: "undeclared", from: "injected:trigger" })], why: /undeclared/ },
    { name: "legacy", history: [injected({})], why: /no recorded sender/ },
    { name: "none", history: [{ type: "user_message", text: "typed by a person" }], why: /no injected message/ },
  ];
  cases.forEach(function (c) {
    var w = world({ lore: [session(2, { agent: "Holden", history: c.history })] });
    var r = w.input.sendInput({ reply: true, prompt: "x", senderProject: "lore", senderSessionId: "2" });
    assert.equal(r.result, "refused", c.name);
    assert.match(r.reason, c.why, c.name);
    assert.equal(w.calls.push.length + w.calls.start.length, 0, c.name);
  });
});

test("reply: refused from outside a console session, or on a reference the console does not hold running", function () {
  var history = [injected(extractedFrom("naomi@lane", "lane", "3"))];
  var w = world({
    lore: [session(2, { agent: "Holden", history: history }), session(5, { agent: "Holden", runtime: "reaped", history: history })],
    lane: [session(3, { agent: "naomi" })],
  });
  var outside = w.input.sendInput({ reply: true, prompt: "x" });
  assert.equal(outside.result, "refused");
  assert.match(outside.reason, /CLAGENTIC_CONSOLE_SESSION_ID is not set/);
  var notRunning = w.input.sendInput({ reply: true, prompt: "x", senderProject: "lore", senderSessionId: "5" });
  assert.equal(notRunning.result, "refused");
  var unknown = w.input.sendInput({ reply: true, prompt: "x", senderProject: "nowhere", senderSessionId: "2" });
  assert.equal(unknown.result, "refused");
  var badId = w.input.sendInput({ reply: true, prompt: "x", senderProject: "lore", senderSessionId: "../2" });
  assert.equal(badId.result, "refused");
  assert.equal(w.calls.push.length + w.calls.start.length, 0);
});

test("reply: a recorded sender id that now names a different session is refused, never redirected", function () {
  var w = world({
    lore: [session(2, { agent: "Holden", history: [injected(extractedFrom("naomi@lane", "lane", "3"))] })],
    lane: [session(3, { agent: "someone-else", cliSessionId: "cli-other" })],
  });
  var r = w.input.sendInput({ reply: true, prompt: "x", senderProject: "lore", senderSessionId: "2" });
  assert.equal(r.result, "refused");
  assert.match(r.reason, /someone-else@lane/);
  assert.equal(w.calls.push.length, 0);
});

test("reply: a different session with the SAME label under the recorded console id is refused", function () {
  var w = world({
    lore: [session(2, { agent: "Holden", history: [injected(extractedFrom("claude@lane", "lane", "3", "cli-original"))] })],
    lane: [session(3, { vendor: "claude", cliSessionId: "cli-impostor" })],
  });
  var r = w.input.sendInput({ reply: true, prompt: "x", senderProject: "lore", senderSessionId: "2" });
  assert.equal(r.result, "refused");
  assert.match(r.reason, /not the sender/);
  assert.equal(w.calls.push.length + w.calls.start.length, 0);
});

test("reply: delivers when the stable id matches, even for a reaped plain session", function () {
  var w = world({
    lore: [session(2, { agent: "Holden", history: [injected(extractedFrom("claude@lane", "lane", "3", "cli-keep"))] })],
    lane: [session(3, { vendor: "claude", cliSessionId: "cli-keep", runtime: "reaped" })],
  });
  var r = w.input.sendInput({ reply: true, prompt: "x", senderProject: "lore", senderSessionId: "2" });
  assert.equal(r.result, "resumed-and-delivered");
  assert.equal(w.calls.start[0].localId, 3);
});

test("reply: a message with no stable sender id is refused with a reason, never matched by label", function () {
  var recorded = extractedFrom("naomi@lane", "lane", "3", null);
  assert.equal(recorded.senderCliSessionId, undefined);
  var w = world({
    lore: [session(2, { agent: "Holden", history: [injected(recorded)] })],
    lane: [session(3, { agent: "naomi" })],
  });
  var r = w.input.sendInput({ reply: true, prompt: "x", senderProject: "lore", senderSessionId: "2" });
  assert.equal(r.result, "refused");
  assert.match(r.reason, /no stable identifier/);
  assert.equal(w.calls.push.length + w.calls.start.length, 0);
});

test("sender record: the vendor session id is stored beside the console id", function () {
  var fields = extractedFrom("naomi@lane", "lane", "3");
  assert.equal(fields.senderSessionId, "3");
  assert.equal(fields.senderCliSessionId, "cli-3");
});

test("reply: a sender that no longer exists is not-found", async function () {
  var w = world({
    lore: [session(2, { agent: "Holden", history: [injected(extractedFrom("naomi@lane", "lane", "3"))] })],
    lane: [],
  });
  var r = await w.input.sendInput({ reply: true, prompt: "x", senderProject: "lore", senderSessionId: "2" });
  assert.equal(r.ok, false);
  assert.equal(r.result, "not-found");
});

// ---- open-session --to ----

test("open --to: an agent address opens that agent in the project, and a vendor address a plain session", function () {
  var w = world({ lore: [] });
  assert.equal(w.input.openSession({ to: "holden@lore", prompt: "go" }).result, "opened");
  assert.deepEqual(w.calls.created[0], { agentName: "Holden" });
  assert.equal(w.input.openSession({ to: "codex@lore", prompt: "go" }).result, "opened");
  assert.deepEqual(w.calls.created[1], { vendor: "codex" });
  assert.equal(w.input.openSession({ to: "@lore", prompt: "go" }).result, "opened");
  assert.deepEqual(w.calls.created[2], {});
});

test("open --to: an unknown name, a clashing flag or a project mismatch is refused and opens nothing", function () {
  var w = world({ lore: [], other: [] });
  assert.equal(w.input.openSession({ to: "nobody@lore", prompt: "go" }).result, "refused");
  assert.equal(w.input.openSession({ to: "holden@lore", vendor: "codex", prompt: "go" }).result, "refused");
  assert.equal(w.input.openSession({ to: "holden@lore", agentName: "naomi", prompt: "go" }).result, "refused");
  assert.equal(w.input.openSession({ to: "holden@lore", projectSlug: "other", prompt: "go" }).result, "refused");
  assert.equal(w.input.openSession({ to: "holden@nowhere", prompt: "go" }).result, "refused");
  assert.equal(w.calls.created.length, 0);
});

// ---- IPC ----

test("ipc: to, reply and list_sessions reach session-input", function () {
  var seen = [];
  var fake = {
    sendInput: function (req) { seen.push(["send", req]); return { ok: true }; },
    openSession: function (req) { seen.push(["open", req]); return { ok: true }; },
    listSessions: function (req) { seen.push(["list", req]); return { ok: true }; },
  };
  handleSessionCommand(fake, { cmd: "send_session_input", to: "a@b", reply: true, prompt: "x", senderProject: "p", senderSessionId: "1" });
  handleSessionCommand(fake, { cmd: "open_session", to: "a@b", prompt: "x" });
  handleSessionCommand(fake, { cmd: "list_sessions", projectSlug: "p", agentName: "a", vendor: "claude", state: "live" });
  assert.equal(seen[0][1].to, "a@b");
  assert.equal(seen[0][1].reply, true);
  assert.equal(seen[0][1].senderSessionId, "1");
  assert.equal(seen[1][1].to, "a@b");
  assert.deepEqual(seen[2][1], { projectSlug: "p", agentName: "a", vendor: "claude", state: "live" });
});

// ---- the CLI ----

test("cli: send-input takes --to, or --reply, in place of a project and session", function () {
  var to = cli.parseSessionArgs("send-input", ["--to", "holden@lore", "--prompt", "x"]);
  assert.deepEqual(to.request, { to: "holden@lore", prompt: "x" });
  var reply = cli.parseSessionArgs("send-input", ["--reply", "--prompt", "x"]);
  assert.deepEqual(reply.request, { reply: true, prompt: "x" });
  var withProject = cli.parseSessionArgs("send-input", ["--project", "lore", "--to", "@lore", "--prompt", "x"]);
  assert.equal(withProject.request.projectSlug, "lore");
});

test("cli: the target is named one way only", function () {
  assert.match(cli.parseSessionArgs("send-input", ["--to", "a@b", "--session", "1", "--prompt", "x"]).error, /one way only/);
  assert.match(cli.parseSessionArgs("send-input", ["--to", "a@b", "--reply", "--prompt", "x"]).error, /one way only/);
  assert.match(cli.parseSessionArgs("send-input", ["--reply", "--project", "p", "--prompt", "x"]).error, /one way only/);
  assert.match(cli.parseSessionArgs("send-input", ["--prompt", "x"]).error, /Missing the target/);
  assert.match(cli.parseSessionArgs("send-input", ["--session", "1", "--prompt", "x"]).error, /--project/);
  assert.match(cli.parseSessionArgs("send-input", ["--reply"]).error, /--prompt/);
  assert.match(cli.parseSessionArgs("open-session", ["--reply", "--prompt", "x"]).error, /--reply/);
  assert.match(cli.parseSessionArgs("open-session", ["--prompt", "x"]).error, /Missing the target/);
});

test("cli: open-session takes --to in place of --project", function () {
  assert.deepEqual(cli.parseSessionArgs("open-session", ["--to", "codex@lore", "--prompt", "x"]).request, { to: "codex@lore", prompt: "x" });
});

test("cli: list-sessions takes only its four filters, all optional", function () {
  assert.deepEqual(cli.parseSessionArgs("list-sessions", []).request, {});
  var all = cli.parseSessionArgs("list-sessions", ["--project", "p", "--agent", "a", "--vendor", "codex", "--state", "reaped"]);
  assert.deepEqual(all.request, { projectSlug: "p", agentName: "a", vendor: "codex", state: "reaped" });
  assert.match(cli.parseSessionArgs("list-sessions", ["--prompt", "x"]).error, /--prompt/);
  assert.ok(cli.SESSION_VERBS.indexOf("list-sessions") !== -1);
});

test("cli: exit codes tell ambiguity and not-found by address apart", function () {
  var E = cli.EXIT;
  assert.equal(cli.exitCodeFor({ ok: true, result: "delivered" }, { to: "a@b" }), E.OK);
  assert.equal(cli.exitCodeFor({ ok: true, result: "listed" }, {}), E.OK);
  assert.equal(cli.exitCodeFor({ ok: false, result: "ambiguous" }, { to: "a@b" }), 3);
  assert.equal(cli.exitCodeFor({ ok: false, result: "not-found" }, { to: "a@b" }), 4);
  assert.equal(cli.exitCodeFor({ ok: false, result: "not-found" }, { reply: true }), 4);
  assert.equal(cli.exitCodeFor({ ok: false, result: "not-found" }, { sessionId: "9" }), 1);
  assert.equal(cli.exitCodeFor({ ok: false, result: "refused" }, { to: "a@b" }), 1);
  assert.equal(cli.exitCodeFor({ ok: false, result: "error" }, {}), 1);
});

test("cli: the caller's session reference is passed, and absent outside a console session", function () {
  var inside = cli.withSenderRef({ reply: true }, { [sender.PROJECT_ENV]: "lore", [sender.SESSION_ENV]: "2" });
  assert.equal(inside.senderProject, "lore");
  assert.equal(inside.senderSessionId, "2");
  var outside = cli.withSenderRef({ reply: true }, {});
  assert.equal(outside.senderProject, undefined);
  assert.equal(outside.senderSessionId, undefined);
});

test("cli: a caller outside the console reaches a daemon that refuses a reply for lack of a reference", async function () {
  var w = world({ lore: [session(2, { history: [injected(extractedFrom("naomi@lane", "lane", "3"))] })] });
  var request = cli.withSenderRef({ cmd: "send_session_input", reply: true, prompt: "x" }, {});
  var res = await cli.requestDaemon(request, {
    isDaemonAlive: function () { return Promise.resolve(true); },
    sendIPC: function (req) { return Promise.resolve(handleSessionCommand(w.input, req)); },
  });
  assert.equal(res.result, "refused");
  assert.equal(cli.exitCodeFor(res, request), 1);
});

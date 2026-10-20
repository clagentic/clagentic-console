var test = require("node:test");
var assert = require("node:assert/strict");

var { createSessionInput } = require("../lib/session-input");
var sender = require("../lib/injected-sender");
var { parseSessionArgs } = require("../lib/cli/session-subcommands");
var { handleSessionCommand } = require("../lib/session-input-ipc");

function makeProject() {
  var recorded = [];
  var live = [];
  var session = { localId: 1, cliSessionId: "cli-1", history: [], isProcessing: false, queryInstance: {} };
  var sm = {
    sessions: new Map([[1, session]]),
    recordHistoryEntry: function (s, e) { s.history.push(e); recorded.push(e); },
    appendToSessionFile: function () {},
    sendToSession: function (s, obj) { live.push(obj); },
  };
  return {
    recorded: recorded,
    live: live,
    project: {
      cwd: "/unused",
      sm: sm,
      sdk: { pushMessage: function () {}, startQuery: function () {} },
      onProcessingChanged: function () {},
      getLinuxUserForSession: function () { return null; },
    },
  };
}

function send(world, extra) {
  var input = createSessionInput({ getProject: function () { return world.project; }, agentCatalog: function () { return []; } });
  return input.sendInput(Object.assign({ projectSlug: "p", sessionId: "cli-1", prompt: "report", initiator: "trigger", contextNote: "lore-a3 PR 1967 report" }, extra || {}));
}

test("send-input with --from records a declared sender", function () {
  var w = makeProject();
  assert.equal(send(w, { from: "lore-a3" }).result, "delivered");
  var e = w.recorded[0];
  assert.equal(e.senderKind, "declared");
  assert.equal(e.fromName, "lore-a3");
  assert.equal(e.from, "injected:trigger");
  assert.equal(e.contextNote, "lore-a3 PR 1967 report");
  assert.equal(e.initiator, "trigger");
});

test("send-input without --from records an undeclared sender and no name", function () {
  var w = makeProject();
  send(w);
  var e = w.recorded[0];
  assert.equal(e.senderKind, "undeclared");
  assert.equal("fromName" in e, false);
  assert.equal(e.from, "injected:trigger");
});

test("live injected message reaches clients with sender fields", function () {
  var w = makeProject();
  send(w, { from: "lore-a3" });
  assert.equal(w.live.length, 1);
  assert.equal(w.live[0].type, "user_message");
  assert.equal(w.live[0].senderKind, "declared");
  assert.equal(w.live[0].fromName, "lore-a3");
  assert.equal(w.live[0].contextNote, "lore-a3 PR 1967 report");
  assert.equal(w.live[0].initiator, "trigger");
});

test("--from is bounded and free of control characters", function () {
  var w = makeProject();
  assert.equal(send(w, { from: "x".repeat(65) }).result, "refused");
  assert.equal(send(w, { from: "a\nb" }).result, "refused");
  assert.equal(send(w, { from: "a\u009bb" }).result, "refused");
  assert.equal(send(w, { from: 5 }).result, "refused");
  assert.equal(send(w, { from: "x".repeat(64) }).result, "delivered");
  assert.equal(w.recorded.length, 1);
});

test("legacy injected entry is attributed as unrecorded, never the local user", function () {
  var legacy = { type: "user_message", text: "hi", source: "external-trigger", initiator: "trigger", contextNote: "n" };
  var out = sender.forClient(legacy);
  assert.equal(out.senderKind, "unrecorded");
  assert.equal(out.from, "injected:trigger");
  assert.equal(out.contextNote, "n");
  assert.equal(legacy.from, undefined);
});

test("a stored sender cannot claim a user id or a spoofed kind on the way out", function () {
  var forged = { type: "user_message", text: "hi", source: "external-trigger", initiator: "trigger", from: "u1", fromName: "Andy", senderKind: "bogus" };
  var out = sender.forClient(forged);
  assert.equal(out.from, "injected:trigger");
  assert.equal(out.senderKind, "unrecorded");
  assert.equal("fromName" in out, false);
});

test("an operator-typed message is returned untouched", function () {
  var typed = { type: "user_message", text: "hi", from: "u1", fromName: "Andy" };
  assert.equal(sender.forClient(typed), typed);
  var stamped = { type: "user_message", text: "hi", initiator: "human" };
  assert.equal(sender.forClient(stamped), stamped);
});

test("an entry with neither an operator marker nor a sender is attributed, not drawn as the operator", function () {
  var plain = { type: "user_message", text: "hi" };
  var out = sender.forClient(plain);
  assert.equal(out.senderKind, "unrecorded");
  assert.equal(out.from.indexOf("injected:"), 0);
  assert.equal(plain.senderKind, undefined);
});

test("CLI and IPC carry --from for both verbs", function () {
  var p = parseSessionArgs("send-input", ["--project", "p", "--session", "s", "--prompt", "x", "--from", "lore-a3"]);
  assert.equal(p.request.from, "lore-a3");
  var o = parseSessionArgs("open-session", ["--project", "p", "--prompt", "x", "--from", "lore-a3"]);
  assert.equal(o.request.from, "lore-a3");
  var seen;
  handleSessionCommand({ sendInput: function (r) { seen = r; } }, { cmd: "send_session_input", from: "lore-a3" });
  assert.equal(seen.from, "lore-a3");
  handleSessionCommand({ openSession: function (r) { seen = r; } }, { cmd: "open_session", from: "lore-a3" });
  assert.equal(seen.from, "lore-a3");
});

"use strict";
// --from-session: the optional sending-session id on open-session, send-input and
// the file drop, and the message id every recorded user message carries.

var test = require("node:test");
var assert = require("node:assert/strict");

var sender = require("../lib/injected-sender");
var { parseSessionArgs } = require("../lib/cli/session-subcommands");
var { handleSessionCommand } = require("../lib/session-input-ipc");

test("validateFromSession: absent and blank are none, a plain id is kept, bad ones are errors", function () {
  assert.deepEqual(sender.validateFromSession(undefined), {});
  assert.deepEqual(sender.validateFromSession(null), {});
  assert.deepEqual(sender.validateFromSession("   "), {});
  assert.deepEqual(sender.validateFromSession("  ses_abc  "), { fromSession: "ses_abc" });
  assert.match(sender.validateFromSession(42).error, /string/);
  assert.match(sender.validateFromSession("a\u0000b").error, /control/);
  assert.match(sender.validateFromSession("x".repeat(sender.MAX_FROM_SESSION_LENGTH + 1)).error, /longer/);
  assert.deepEqual(sender.validateFromSession("x".repeat(sender.MAX_FROM_SESSION_LENGTH)), { fromSession: "x".repeat(sender.MAX_FROM_SESSION_LENGTH) });
});

test("senderFields: a declared sending session is stored; an extracted one wins over it", function () {
  var declared = sender.senderFields("trigger", "ops-bot", null, "ses_declared");
  assert.equal(declared.fromSession, "ses_declared");
  assert.equal(declared.senderKind, "declared");

  var extracted = { name: "holden@p", project: "p", sessionId: "3", vendor: "claude", cliSessionId: "cli-holden" };
  var both = sender.senderFields("trigger", "ops-bot", extracted, "ses_declared");
  assert.equal(both.fromSession, "cli-holden");
  assert.equal(both.senderKind, "extracted");

  var noVendorId = sender.senderFields("trigger", null, { name: "holden@p", project: "p", sessionId: "3", vendor: "claude" }, "ses_declared");
  assert.equal(noVendorId.fromSession, "ses_declared", "an extracted sender without a vendor session id falls back to the declared one");

  assert.equal("fromSession" in sender.senderFields("trigger", "ops-bot", null), false);
});

test("stampRecord gives every message its own id and keeps one the writer already minted", function () {
  var a = sender.stampRecord({ type: "user_message", text: "a", initiator: "human" });
  var b = sender.stampRecord({ type: "user_message", text: "b", initiator: "human" });
  assert.match(a.messageId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a.messageId, b.messageId);
  assert.equal(sender.stampRecord({ type: "user_message", messageId: "fixed" }).messageId, "fixed");
  assert.ok(sender.consoleTurnEntry("loop", "t").messageId);
});

test("cli: --from-session is accepted on open-session and send-input only", function () {
  var open = parseSessionArgs("open-session", ["--project", "p", "--prompt", "go", "--from", "bot", "--from-session", "ses_1"]);
  assert.deepEqual(open.request, { projectSlug: "p", prompt: "go", from: "bot", fromSession: "ses_1" });
  var send = parseSessionArgs("send-input", ["--reply", "--prompt", "x", "--from-session", "ses_2"]);
  assert.equal(send.request.fromSession, "ses_2");
  var absent = parseSessionArgs("send-input", ["--project", "p", "--session", "s", "--prompt", "x"]);
  assert.equal("fromSession" in absent.request, false);
  assert.match(parseSessionArgs("list-sessions", ["--from-session", "x"]).error, /--from-session/);
  assert.match(parseSessionArgs("send-input", ["--project", "p", "--session", "s", "--prompt", "x", "--from-session"]).error, /Missing value/);
});

test("ipc: fromSession reaches session-input for both verbs", function () {
  var seen = [];
  var input = {
    openSession: function (req) { seen.push(req); return {}; },
    sendInput: function (req) { seen.push(req); return {}; },
  };
  handleSessionCommand(input, { cmd: "open_session", projectSlug: "p", prompt: "x", fromSession: "ses_a" });
  handleSessionCommand(input, { cmd: "send_session_input", projectSlug: "p", sessionId: "s", prompt: "x", fromSession: "ses_b" });
  assert.deepEqual(seen.map(function (r) { return r.fromSession; }), ["ses_a", "ses_b"]);
});

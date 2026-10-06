"use strict";
// The urgent "Input needed" alert follows whether any prompt, of any kind, is
// still awaiting the operator; it is never decided by the message that
// arrived last. With two prompts open, settling one leaves the alert on for
// the other; a turn ending leaves it on for a sub-agent prompt that outlives
// the turn.
//
// app-messages.js is not importable outside a browser (see the other
// app-messages CI-invariant tests), so its wiring is pinned by source checks
// over the derivation it calls, which is exercised for real below.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var { setupToolsEnv } = require("./fake-dom-prompt-cards");

var APP_MESSAGES = path.join(__dirname, "..", "lib", "public", "modules", "app-messages.js");

function permission(id) {
  return { type: "prompt_request", requestId: id, kind: "permission", toolName: "Bash", toolInput: { command: "make" }, decisionReason: "" };
}

function ask(id) {
  return { type: "prompt_request", requestId: id, kind: "ask_user", toolUseId: id, input: { questions: [{ question: "Q?", options: [{ label: "a" }] }] } };
}

test("the pending-prompt derivation stays on while any prompt of any kind is unanswered", async function (t) {
  var env = await setupToolsEnv(t);
  assert.equal(env.tools.hasPendingPrompts(), false);

  env.tools.applyPromptMessage(permission("p-1"));
  env.tools.applyPromptMessage(ask("a-1"));
  assert.equal(env.tools.hasPendingPrompts(), true);

  env.tools.applyPromptMessage({ type: "prompt_resolved", requestId: "p-1", kind: "permission", decision: "allow" });
  assert.equal(env.tools.hasPendingPrompts(), true, "settling one of two prompts leaves the other awaiting the operator");

  env.tools.resetToolState();
  assert.equal(env.tools.hasPendingPrompts(), true, "a turn's tool reset does not end a prompt that outlives the turn");

  env.tools.applyPromptMessage({ type: "prompt_cancel", requestId: "a-1", kind: "ask_user", reason: "stale" });
  assert.equal(env.tools.hasPendingPrompts(), false);

  env.tools.applyPromptMessage(permission("p-2"));
  env.tools.clearPromptStates();
  assert.equal(env.tools.hasPendingPrompts(), false, "a rebuilt transcript starts from the server's word again");
});

function stripLineComments(src) {
  return src.split("\n").map(function (line) { return line.replace(/^\s*\/\/.*$/, ""); }).join("\n");
}

// The text of a top-level function or handler entry, from its header to the
// first line that closes it at the given indent.
function block(src, header, closer) {
  var start = src.indexOf(header);
  assert.ok(start !== -1, "expected " + JSON.stringify(header) + " in app-messages.js");
  var end = src.indexOf(closer, start + header.length);
  assert.ok(end !== -1, "expected the end of " + JSON.stringify(header));
  return src.slice(start, end);
}

test("CI invariant: app-messages.js decides the alert from every prompt, at each place it used to stop it", function () {
  var src = stripLineComments(fs.readFileSync(APP_MESSAGES, "utf8"));
  var sync = block(src, "function syncUrgentBlink()", "\n}\n");
  assert.match(sync, /hasPendingPrompts\(\)/, "syncUrgentBlink derives the alert from hasPendingPrompts()");

  var onPrompt = block(src, "function handlePromptMessage(msg)", "\n}\n");
  assert.match(onPrompt, /syncUrgentBlink\(\)/);
  assert.doesNotMatch(onPrompt, /stopUrgentBlink\(|startUrgentBlink\(/, "a prompt message never sets the alert from its own state alone");

  var done = block(src, "  done: function (msg) {", "\n  },\n");
  assert.match(done, /syncUrgentBlink\(\)/);
  assert.doesNotMatch(done, /stopUrgentBlink\(/, "a finished turn does not hide a prompt that outlives it");
});

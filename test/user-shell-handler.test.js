"use strict";
// The server side of the composer's ! mode, over the real session manager, the
// real SDK bridge (so the permission gate is the one a Bash tool call goes
// through) and in-memory clients. The safety table: the setting, OS-user
// isolation and plan mode refuse before anything is asked; the gate is prompted
// exactly as a Bash call is; acceptEdits and bypass decide as they do for Bash;
// the configured timeout and cap reach the adapter; an interrupt, a reconnect
// and a failure each end in a visible, recorded result.

var test = require("node:test");
var assert = require("node:assert/strict");

var world = require("./prompt-harness-world");
var { promptsFor } = require("../lib/prompt-registry");
var { attachUserShell, REASONS } = require("../lib/project-user-shell");
var userShellSettings = require("../lib/user-shell-settings");

// The own-key lookups the settings use are loaded by the daemon at start-up
// (lib/prompt-registry.js); a unit test loads them itself.
test.before(function () { return require("../lib/prompt-kinds/codecs").load(); });

var NEEDS_PROMPT = "npm publish";
var READ_ONLY = "git status";

function settle() {
  return world.flush().then(world.flush).then(world.flush);
}

function ok(output) {
  return { exitCode: 0, durationMs: 5, output: output || "", truncated: false, timedOut: false };
}

// Runs fn with a handler over a live session. o: config (daemon.json), osUsers,
// usersModule, projectAccess, run (the adapter method's behaviour).
async function withShell(o, fn) {
  o = o || {};
  await world.withServer(async function (server) {
    var session = server.session;
    var config = Object.assign({}, o.config);
    var h = { server: server, session: session, config: config, runs: [], sent: [], broadcast: [], forwarded: [] };
    h.client = world.client();
    h.ws = h.client.ws;
    server.connect(h.ws);
    h.handle = session.queryInstance;
    h.handle.runUserShellCommand = function (command, cwd, timeoutMs, maxBytes, runOpts) {
      var call = { command: command, cwd: cwd, timeoutMs: timeoutMs, maxBytes: maxBytes, signal: runOpts && runOpts.signal };
      h.runs.push(call);
      return o.run ? o.run(call) : Promise.resolve(ok("ran: " + command));
    };
    h.handler = attachUserShell({
      slug: "harness", cwd: server.home, osUsers: !!o.osUsers, sm: server.sm, sdk: server.bridge,
      send: function (m) { h.broadcast.push(m); },
      sendTo: function (ws, m) { h.sent.push(m); },
      usersModule: o.usersModule || null,
      projectAccess: o.projectAccess || null,
      opts: {
        onGetUserShellSettings: function () { return userShellSettings.readUserShellSettings(config); },
        onSetUserShellSettings: function (values) { userShellSettings.applySettingChanges(config, values); },
        broadcastAll: function (m) { h.broadcast.push(m); },
      },
      getSessionForWs: function () { return session; },
      sendAsMessage: function (ws, text, vendor) { h.forwarded.push({ text: text, vendor: vendor }); return true; },
    });
    h.say = async function (command, extra) {
      var handled = h.handler.handleUserShellMessage(h.ws, Object.assign({ type: "shell", command: command }, extra));
      await settle();
      return handled;
    };
    h.results = function () { return h.client.inbox.filter(function (m) { return m.type === "shell_result"; }); };
    h.refusals = function () { return h.sent.filter(function (m) { return m.type === "shell_result" && m.refused; }); };
    h.recorded = function () { return session.history.filter(function (e) { return e.type === "shell_result"; }); };
    h.prompts = function () { return promptsFor(server.sm); };
    await fn(h);
  });
}

function assertNothingRan(h, why) {
  assert.equal(h.runs.length, 0, why + ": nothing ran");
  assert.equal(h.server.heldPromptIds().length, 0, why + ": nothing was asked");
}

// ---------------------------------------------------------------- the gate

test("default mode: a command with no allow rule opens the Bash prompt and runs only after approval", async function () {
  await withShell({}, async function (h) {
    assert.equal(await h.say(NEEDS_PROMPT), true);
    var held = h.server.heldPromptIds();
    assert.equal(held.length, 1, "the permission prompt is open");
    assert.equal(h.runs.length, 0, "nothing ran before the answer");
    var request = h.client.inbox.filter(function (m) { return m.type === "prompt_request" || m.type === "permission_request"; }).pop();
    assert.equal(request.toolName, "Bash");
    assert.deepEqual(request.toolInput, { command: NEEDS_PROMPT });

    h.prompts().respond(held[0], { decision: "allow" });
    await settle();
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].command, NEEDS_PROMPT);
    assert.equal(h.runs[0].cwd, h.session.cwd || h.server.home, "in the session's folder");
    assert.equal(h.runs[0].timeoutMs, 10 * 60 * 1000, "the documented default timeout");
    assert.equal(h.runs[0].maxBytes, 256 * 1024, "the documented default cap");
    assert.equal(h.results().length, 1);
    assert.equal(h.results()[0].exitCode, 0);
    assert.equal(h.results()[0].output, "ran: " + NEEDS_PROMPT);
    assert.equal(h.recorded().length, 1, "the outcome is part of the session's history");
  });
});

test("default mode: a denied command does not run and the result says it was not approved", async function () {
  await withShell({}, async function (h) {
    await h.say(NEEDS_PROMPT);
    h.prompts().respond(h.server.heldPromptIds()[0], { decision: "deny" });
    await settle();
    assert.equal(h.runs.length, 0);
    assert.equal(h.results().length, 1);
    assert.equal(h.results()[0].denied, true);
    assert.equal(h.recorded().length, 1);
  });
});

test("the gate is the Bash call's own: a read-only command the allowlist waves through runs without a prompt", async function () {
  await withShell({}, async function (h) {
    var control = h.server.ask("Bash", { command: READ_ONLY }, {});
    assert.equal(control.opened.length, 0);
    assert.equal((await control.promise).behavior, "allow");
    await h.say(READ_ONLY);
    assert.equal(h.server.heldPromptIds().length, 0, "no prompt, as for the Bash call");
    assert.equal(h.runs.length, 1);
  });
});

test("acceptEdits decides exactly as a Bash tool call does", async function () {
  await withShell({}, async function (h) {
    h.session.permissionMode = "acceptEdits";
    var control = h.server.ask("Bash", { command: NEEDS_PROMPT }, {});
    assert.equal(control.opened.length, 1, "a Bash call in acceptEdits is prompted");
    h.prompts().respond(control.id, { decision: "deny" });
    await control.promise;

    await h.say(NEEDS_PROMPT);
    assert.equal(h.server.heldPromptIds().length, 1, "so is the ! command");
    assert.equal(h.runs.length, 0);
    h.prompts().respond(h.server.heldPromptIds()[0], { decision: "allow" });
    await settle();
    assert.equal(h.runs.length, 1);

    var controlRO = h.server.ask("Bash", { command: READ_ONLY }, {});
    assert.equal(controlRO.opened.length, 0, "and a read-only Bash call is not");
    await controlRO.promise;
    await h.say(READ_ONLY);
    assert.equal(h.server.heldPromptIds().length, 0);
    assert.equal(h.runs.length, 2);
  });
});

test("bypass mode decides exactly as a Bash tool call does: no prompt", async function () {
  await withShell({}, async function (h) {
    h.session.permissionMode = "bypassPermissions";
    var control = h.server.ask("Bash", { command: NEEDS_PROMPT }, {});
    assert.equal(control.opened.length, 0, "a Bash call in bypass mode is allowed at once");
    assert.equal((await control.promise).behavior, "allow");
    await h.say(NEEDS_PROMPT);
    assert.equal(h.server.heldPromptIds().length, 0);
    assert.equal(h.runs.length, 1);
  });
});

// ---------------------------------------------------------------- refusals, in order

test("plan mode refuses with a visible reason, asks nothing, runs nothing and records nothing", async function () {
  await withShell({}, async function (h) {
    h.session.permissionMode = "plan";
    await h.say(NEEDS_PROMPT);
    assertNothingRan(h, "plan mode");
    assert.equal(h.refusals().length, 1);
    assert.equal(h.refusals()[0].reason, REASONS.plan);
    assert.equal(h.refusals()[0].command, NEEDS_PROMPT);
    assert.equal(h.recorded().length, 0, "a refusal is not part of the conversation");
  });
});

test("plan mode is read from the project mode when the session has none of its own", async function () {
  await withShell({}, async function (h) {
    delete h.session.permissionMode;
    h.server.sm.currentPermissionMode = "plan";
    await h.say(READ_ONLY);
    assertNothingRan(h, "plan mode from the project default");
    assert.equal(h.refusals()[0].reason, REASONS.plan);
  });
});

test("with the setting off the line goes on as ordinary text and nothing is asked or run", async function () {
  await withShell({ config: { userShellEnabled: false } }, async function (h) {
    assert.equal(await h.say(NEEDS_PROMPT, { vendor: "claude" }), true);
    assert.deepEqual(h.forwarded, [{ text: "!" + NEEDS_PROMPT, vendor: "claude" }]);
    assertNothingRan(h, "setting off");
    assert.equal(h.refusals().length, 0);
    assert.equal(h.results().length, 0);
  });
});

test("OS-user mode refuses with the reason; nothing runs as the daemon's user", async function () {
  await withShell({ osUsers: true }, async function (h) {
    await h.say(READ_ONLY);
    assertNothingRan(h, "OS-user mode");
    assert.equal(h.refusals().length, 1);
    assert.equal(h.refusals()[0].reason, REASONS.osUsers);
    assert.match(REASONS.osUsers, /never runs one as the daemon's account/);
    assert.equal(h.recorded().length, 0);
  });
});

test("with the setting off a blank or oversized ! line also goes on as ordinary text", async function () {
  await withShell({ config: { userShellEnabled: false } }, async function (h) {
    await h.say("   ", { vendor: "claude" });
    var big = "x".repeat(70 * 1024);
    await h.say(big);
    assert.deepEqual(h.forwarded.map(function (f) { return f.text; }), ["!   ", "!" + big]);
    assertNothingRan(h, "setting off");
    assert.equal(h.refusals().length, 0, "nothing is refused while the mode is off");
  });
});

test("the checks decide in order: setting, then OS-user mode, then plan mode, then the gate", async function () {
  await withShell({ config: { userShellEnabled: false }, osUsers: true }, async function (h) {
    h.session.permissionMode = "plan";
    await h.say(NEEDS_PROMPT);
    assert.equal(h.forwarded.length, 1, "setting off beats OS-user mode and plan mode");
    assert.equal(h.refusals().length, 0);
  });
  await withShell({ osUsers: true }, async function (h) {
    h.session.permissionMode = "plan";
    await h.say(NEEDS_PROMPT);
    assert.equal(h.refusals()[0].reason, REASONS.osUsers, "OS-user mode beats plan mode");
  });
  await withShell({}, async function (h) {
    h.session.permissionMode = "plan";
    await h.say(NEEDS_PROMPT);
    assert.equal(h.refusals()[0].reason, REASONS.plan, "plan mode comes before the gate");
    assert.equal(h.server.heldPromptIds().length, 0, "so no prompt was opened");
  });
});

test("a user who may not use a terminal may not run a command either", async function () {
  var usersModule = { getEffectivePermissions: function () { return { terminal: false }; } };
  await withShell({ usersModule: usersModule }, async function (h) {
    h.ws._clagenticUser = { id: "u1" };
    await h.say(READ_ONLY);
    assertNothingRan(h, "no terminal permission");
    assert.equal(h.refusals()[0].reason, REASONS.noTerminal);
  });
});

test("a busy agent, a missing live process and an adapter without the method each refuse before the gate", async function () {
  await withShell({}, async function (h) {
    h.session.isProcessing = true;
    await h.say(NEEDS_PROMPT);
    assertNothingRan(h, "agent busy");
    assert.equal(h.refusals()[0].reason, REASONS.busy);
    h.session.isProcessing = false;
  });
  await withShell({}, async function (h) {
    h.session.queryInstance = null;
    await h.say(NEEDS_PROMPT);
    assertNothingRan(h, "no live process");
    assert.equal(h.refusals()[0].reason, REASONS.noLive);
    h.session.queryInstance = h.handle;
  });
  await withShell({}, async function (h) {
    delete h.handle.runUserShellCommand;
    await h.say(NEEDS_PROMPT);
    assertNothingRan(h, "adapter lacks the method");
    assert.equal(h.refusals()[0].reason, REASONS.unsupported);
  });
});

test("an empty command and an over-long one are refused with a reason", async function () {
  await withShell({}, async function (h) {
    await h.say("   ");
    await h.say("x".repeat(70 * 1024));
    assertNothingRan(h, "bad input");
    assert.deepEqual(h.refusals().map(function (r) { return r.reason; }), [REASONS.empty, REASONS.tooLong]);
  });
});

test("the typed tail is preserved through the gate, the run and the record", async function () {
  await withShell({}, async function (h) {
    var typed = "echo a\\ ";
    await h.say("  " + typed);
    assert.equal(h.server.heldPromptIds().length, 1, "the gate was asked about the command");
    var request = h.client.inbox.filter(function (m) { return m.type === "prompt_request" || m.type === "permission_request"; }).pop();
    assert.equal(request.toolInput.command, typed);
    h.prompts().respond(h.server.heldPromptIds()[0], { decision: "allow" });
    await settle();
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].command, typed, "leading space dropped, trailing escaped space kept");
    assert.equal(h.results()[0].command, typed);
    assert.equal(h.recorded()[0].command, typed);
  });
});

// ---------------------------------------------------------------- limits, interrupt, reconnect, failure

test("the configured timeout and output cap are what the adapter is given", async function () {
  await withShell({ config: { userShellTimeoutMinutes: 2, userShellMaxOutputKiB: 4 } }, async function (h) {
    await h.say(READ_ONLY);
    assert.equal(h.runs[0].timeoutMs, 120000);
    assert.equal(h.runs[0].maxBytes, 4096);
  });
});

test("a command that timed out or was cut says so in its recorded result", async function () {
  var result = { exitCode: null, durationMs: 600000, output: "partial\n[output truncated at 10 bytes]", truncated: true, timedOut: true };
  await withShell({ run: function () { return Promise.resolve(result); } }, async function (h) {
    await h.say(READ_ONLY);
    var shown = h.results()[0];
    assert.equal(shown.timedOut, true);
    assert.equal(shown.truncated, true);
    assert.equal(shown.exitCode, null);
    assert.match(shown.output, /output truncated at 10 bytes/);
    assert.equal(h.recorded()[0].timedOut, true);
  });
});

test("an interrupt while the command waits for approval cancels the prompt and runs nothing", async function () {
  await withShell({}, async function (h) {
    await h.say(NEEDS_PROMPT);
    assert.equal(h.server.heldPromptIds().length, 1);
    assert.equal(h.handler.handleUserShellMessage(h.ws, { type: "stop" }), false, "stop still reaches the sessions handler");
    await settle();
    assert.equal(h.server.heldPromptIds().length, 0, "the prompt ended");
    assert.equal(h.runs.length, 0);
    assert.equal(h.results().length, 1);
    assert.equal(h.results()[0].interrupted, true);
  });
});

test("an interrupt while the command runs aborts the signal the adapter was given", async function () {
  var release;
  await withShell({
    run: function (call) {
      return new Promise(function (resolve) {
        call.signal.addEventListener("abort", function () {
          resolve({ exitCode: null, durationMs: 40, output: "cut short", truncated: false, timedOut: false, interrupted: true });
        });
        release = resolve;
      });
    },
  }, async function (h) {
    await h.say(READ_ONLY);
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].signal.aborted, false);
    h.handler.handleUserShellMessage(h.ws, { type: "stop" });
    await settle();
    assert.equal(h.runs[0].signal.aborted, true);
    assert.equal(h.results()[0].interrupted, true);
    assert.equal(h.recorded()[0].interrupted, true);
    assert.ok(release);
  });
});

test("a second command while one runs is refused; a stop with nothing running does nothing", async function () {
  await withShell({ run: function () { return new Promise(function () {}); } }, async function (h) {
    await h.say(READ_ONLY);
    await h.say(READ_ONLY);
    assert.equal(h.runs.length, 1);
    assert.equal(h.refusals()[0].reason, REASONS.running);
  });
  await withShell({}, async function (h) {
    assert.equal(h.handler.handleUserShellMessage(h.ws, { type: "stop" }), false);
    assert.equal(h.results().length, 0);
  });
});

test("a client that connects while the command runs gets the result when it lands, and a later one replays it", async function () {
  var finish;
  await withShell({ run: function () { return new Promise(function (resolve) { finish = resolve; }); } }, async function (h) {
    await h.say(READ_ONLY);
    assert.equal(h.results().length, 0, "still running");

    var reconnected = world.client();
    h.server.connect(reconnected.ws);
    finish(ok("done after reconnect"));
    await settle();
    var live = reconnected.inbox.filter(function (m) { return m.type === "shell_result"; });
    assert.equal(live.length, 1, "the reconnected client shows it when it lands");
    assert.equal(live[0].output, "done after reconnect");

    var later = world.client();
    h.server.connect(later.ws);
    await settle();
    var replayed = later.inbox.filter(function (m) { return m.type === "shell_result"; });
    assert.equal(replayed.length, 1, "a client that arrives afterwards replays it from the history");
    assert.equal(replayed[0].command, READ_ONLY);
  });
});

test("a failure of the adapter's method is a recorded, visible result, never a silent drop", async function () {
  await withShell({ run: function () { return Promise.reject(new Error("thread not found")); } }, async function (h) {
    await h.say(READ_ONLY);
    var shown = h.results()[0];
    assert.equal(shown.error, true);
    assert.match(shown.output, /thread not found/);
    assert.equal(h.recorded().length, 1);
  });
});

test("a query that ended while the approval waited means the command does not run, and the result says why", async function () {
  await withShell({}, async function (h) {
    await h.say(NEEDS_PROMPT);
    h.session.queryInstance = null;
    h.prompts().respond(h.server.heldPromptIds()[0], { decision: "allow" });
    await settle();
    assert.equal(h.runs.length, 0);
    assert.equal(h.results()[0].error, true);
    assert.equal(h.results()[0].output, REASONS.gone);
    h.session.queryInstance = h.handle;
  });
});

// ---------------------------------------------------------------- the setting's own message

test("only an admin changes the ! settings; an accepted change is stored and announced", async function () {
  var projectAccess = { isAdmin: function (user) { return !!(user && user.role === "admin"); }, authOf: function () { return {}; } };
  await withShell({ projectAccess: projectAccess }, async function (h) {
    h.handler.handleUserShellMessage(h.ws, { type: "set_user_shell_settings", userShellEnabled: false });
    assert.equal(h.config.userShellEnabled, undefined, "a non-admin changed nothing");
    assert.match(h.sent[h.sent.length - 1].text, /Only admins/);

    h.ws._clagenticUser = { id: "a", role: "admin" };
    h.handler.handleUserShellMessage(h.ws, { type: "set_user_shell_settings", userShellEnabled: false, userShellTimeoutMinutes: 3 });
    assert.equal(h.config.userShellEnabled, false);
    assert.equal(h.config.userShellTimeoutMinutes, 3);
    assert.deepEqual(h.broadcast[h.broadcast.length - 1], {
      type: "user_shell_settings", userShellEnabled: false, userShellTimeoutMinutes: 3, userShellMaxOutputKiB: 256,
    });

    h.handler.handleUserShellMessage(h.ws, { type: "set_user_shell_settings", userShellTimeoutMinutes: 0, bogus: true });
    assert.match(h.sent[h.sent.length - 1].text, /Unknown or invalid/);
    assert.equal(h.config.userShellTimeoutMinutes, 3, "an invalid value changed nothing");
  });
});

test("messages of other types are not the handler's", async function () {
  await withShell({}, async function (h) {
    assert.equal(h.handler.handleUserShellMessage(h.ws, { type: "message", text: "!ls" }), false);
    assert.equal(h.handler.handleUserShellMessage(h.ws, { type: "permission_response" }), false);
  });
});

test("the server holds no chat: a send that reaches it during a command (a second client) goes to the handle as before", async function () {
  var finish;
  await withShell({ run: function () { return new Promise(function (resolve) { finish = resolve; }); } }, async function (h) {
    var delivered = [];
    h.handle.pushMessage = function (text) { delivered.push(text); };
    await h.say(READ_ONLY);
    assert.equal(h.runs.length, 1);
    assert.equal(h.session.isProcessing, true, "the session is busy as it is during a turn");

    h.server.bridge.pushMessage(h.session, "typed meanwhile", null, "human", "m-wait");
    await settle();
    assert.deepEqual(delivered, ["typed meanwhile"], "nothing is held or dropped server-side");

    finish(ok("done"));
    await settle();
    assert.equal(h.recorded().length, 1, "the result is recorded");
    assert.equal(h.session.isProcessing, false);
  });
});

test("a command that ends with nothing waiting leaves the session idle again", async function () {
  await withShell({}, async function (h) {
    await h.say(READ_ONLY);
    assert.equal(h.runs.length, 1);
    assert.equal(h.session.isProcessing, false);
  });
});

test("a turn that started while the approval waited means the command does not run", async function () {
  await withShell({}, async function (h) {
    await h.say(NEEDS_PROMPT);
    h.session.isProcessing = true;
    h.prompts().respond(h.server.heldPromptIds()[0], { decision: "allow" });
    await settle();
    assert.equal(h.runs.length, 0);
    assert.equal(h.results()[0].denied, true);
    assert.equal(h.results()[0].reason, REASONS.busy);
    assert.equal(h.session.isProcessing, true, "the running turn's busy state is left alone");
    h.session.isProcessing = false;
  });
});

test("a command that fails to run or is stopped leaves the session idle again", async function () {
  await withShell({ run: function () { return Promise.reject(new Error("spawn failed")); } }, async function (h) {
    await h.say(READ_ONLY);
    assert.equal(h.session.isProcessing, false, "an adapter failure");
  });
  await withShell({ run: function () { return Promise.resolve({ exitCode: null, durationMs: 9, output: "", truncated: false, timedOut: true }); } }, async function (h) {
    await h.say(READ_ONLY);
    assert.equal(h.session.isProcessing, false, "a timeout");
  });
});

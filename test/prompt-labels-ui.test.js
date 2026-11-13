"use strict";
// The client side of labelled prompts and whole-tool grants, on the real card,
// banner and grants-list modules over the hand-built DOM: the card and the
// banner say whose prompt it is, every tool's card offers Allow for session,
// and the grants list offers a Revoke for each grant.

var test = require("node:test");
var assert = require("node:assert/strict");
var dom = require("./fake-dom-prompt-cards");

var LABEL = { project: "Project Alpha", session: "DO NOT ANSWER probe", agent: "scan the repository" };
var FILE_TOOL_INPUTS = [
  ["Write", { file_path: "/work/a.txt", content: "x" }],
  ["Edit", { file_path: "/work/a.txt" }],
  ["MultiEdit", { file_path: "/work/a.txt" }],
  ["NotebookEdit", { notebook_path: "/work/n.ipynb" }],
];

function request(id, extra) {
  return Object.assign({
    type: "prompt_request", requestId: id, kind: "permission", toolName: "Bash",
    toolInput: { command: "find /var/tmp" }, decisionReason: "", label: LABEL,
  }, extra || {});
}

test("the card names the project, the session and the agent, and offers Allow for session", async function (t) {
  var env = await dom.setupToolsEnv(t);
  env.tools.applyPromptMessage(request("l1"));
  var card = dom.cardFor(env, "l1");
  var label = card.querySelector(".prompt-label");
  assert.ok(label, "the card carries a label");
  assert.equal(label.textContent, "Project: Project Alpha | Session: DO NOT ANSWER probe | Agent: scan the repository");
  assert.ok(card.querySelector(".perm-always"), "Bash offers Allow for session");
});

test("the card offers Allow for session for every file tool as well", async function (t) {
  var env = await dom.setupToolsEnv(t);
  FILE_TOOL_INPUTS.forEach(function (call, i) {
    var id = "l2-" + i;
    env.tools.applyPromptMessage(request(id, { toolName: call[0], toolInput: call[1] }));
    var card = dom.cardFor(env, id);
    assert.ok(card.querySelector(".perm-always"), call[0] + ": Allow for session is offered");
    assert.ok(card.querySelector(".perm-allow"), call[0] + ": Allow once stays");
    assert.ok(card.querySelector(".prompt-label"), call[0] + ": the label stays");
  });
});

test("the card for an older recorded request with no label is drawn as before", async function (t) {
  var env = await dom.setupToolsEnv(t);
  env.tools.applyPromptMessage({ type: "prompt_request", requestId: "l3", kind: "permission", toolName: "Bash", toolInput: { command: "ls" }, decisionReason: "" });
  var card = dom.cardFor(env, "l3");
  assert.equal(card.querySelector(".prompt-label"), null);
  assert.ok(card.querySelector(".perm-always"), "the button is still offered");
});

test("every kind of card carries the label", async function (t) {
  var env = await dom.setupToolsEnv(t);
  env.tools.applyPromptMessage({ type: "prompt_request", requestId: "k-plan", kind: "plan", toolName: "ExitPlanMode", toolInput: { plan: "p" }, label: LABEL });
  env.tools.applyPromptMessage({ type: "prompt_request", requestId: "k-el", kind: "elicitation", serverName: "srv", message: "?", label: LABEL });
  env.tools.applyPromptMessage({ type: "prompt_request", requestId: "k-ask", kind: "ask_user", input: { questions: [{ question: "Which?", options: [{ label: "a" }] }] }, toolUseId: "k-ask", label: LABEL });
  ["k-plan", "k-el", "k-ask"].forEach(function (id) {
    var card = dom.cardFor(env, id);
    assert.ok(card, id + " is drawn");
    assert.equal(card.querySelector(".prompt-label").textContent, "Project: Project Alpha | Session: DO NOT ANSWER probe | Agent: scan the repository", id);
  });
});

test("the label drops the parts that are absent and reads nothing that is not a string", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var label = await import(dom.moduleUrl("prompt-label.js"));
  assert.equal(label.promptLabelText({ project: "P", session: "S", agent: "" }), "Project: P | Session: S");
  assert.equal(label.promptLabelText({ project: 1, session: {}, agent: null }), "");
  assert.equal(label.promptLabelText(null), "");
  assert.equal(label.promptLabelHtml(null), "");
  assert.equal(label.promptLabelHtml({ project: "<b>x</b>", session: "S" }), '<div class="notif-banner-label">Project: &lt;b&gt;x&lt;/b&gt; | Session: S</div>', "escaped for the banner's innerHTML");
});

test("a permission banner drawn by the notification module carries the label, and one without a label does not", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var storeMod = await import(dom.moduleUrl("store.js"));
  storeMod.createStore({ connected: true });
  var notifications = await import(dom.moduleUrl("app-notifications.js"));
  notifications.initAppNotifications();
  var container = global.document.body.querySelector(".overlay-stack");
  assert.ok(container, "the banner container exists");

  function created(id, meta) {
    notifications.handleNotificationCreated({
      unreadCount: 1,
      notification: {
        id: id, type: "permission_request", slug: "alpha", sessionId: 7, title: "Permission", body: "",
        meta: Object.assign({ requestId: "r-" + id, kind: "permission", toolName: "Bash", toolInput: { command: "find /var/tmp" } }, meta),
      },
    });
    return container.querySelector('[data-notif-id="' + id + '"]');
  }

  var labelled = created("n1", { label: LABEL });
  assert.ok(labelled, "the banner is drawn");
  assert.ok(labelled.innerHTML.indexOf('<div class="notif-banner-label">Project: Project Alpha | Session: DO NOT ANSWER probe | Agent: scan the repository</div>') !== -1, "the label is in the banner");

  var plain = created("n2", {});
  assert.ok(plain, "an older notification is still drawn");
  assert.equal(plain.innerHTML.indexOf("notif-banner-label"), -1, "no label, none shown");
});

test("a banner offers Allow for session for any permission ask except a suppressed one", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var banner = await import(dom.moduleUrl("prompt-banner.js"));
  function decisions(meta) {
    return banner.bannerActions("permission", meta).map(function (a) { return a.decision; });
  }
  assert.deepEqual(decisions({ toolName: "Write" }), ["allow", "allow_always", "deny"]);
  assert.deepEqual(decisions({ toolName: "Bash" }), ["allow", "allow_always", "deny"]);
  assert.deepEqual(decisions({ suppressAlwaysAllowRule: true }), ["allow", "deny"]);
});

test("the grants list draws one row per grant with a Revoke, marks whole-tool grants, and sends the revoke", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var mod = await import(dom.moduleUrl("session-grants.js"));
  var list = new dom.FakeElement("div");
  var sent = [];
  var grants = [
    { key: "Bash", tool: "Bash", wholeTool: true, text: "Every Bash call, whatever it does (whole-tool grant)" },
    { key: "Write", tool: "Write", wholeTool: true, text: "Every Write call, whatever it does (whole-tool grant)" },
  ];
  mod.renderGrantList(list, grants, 7, function (m) { sent.push(m); return true; });
  var rows = list.querySelectorAll(".session-grants-row");
  assert.equal(rows.length, 2);
  assert.ok(rows[1].classList.contains("session-grants-whole"), "a whole-tool grant is marked");
  assert.match(rows[1].textContent, /whole-tool/);
  rows[0].querySelector(".session-grants-revoke").click();
  assert.deepEqual(sent, [{ type: "revoke_session_grant", sessionId: 7, key: "Bash" }]);
  assert.equal(rows[0].querySelector(".session-grants-revoke").disabled, true, "disabled while the request is in flight");
  assert.equal(list.querySelectorAll(".session-grants-row").length, 2, "the row stays until the server confirms");

  mod.renderGrantList(list, [], 7, function () { return true; });
  assert.equal(list.querySelectorAll(".session-grants-row").length, 0);
  assert.match(list.textContent, /no Allow for session grants/);
});

test("a revoke whose send fails re-enables the button and says so, so it can be retried", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var mod = await import(dom.moduleUrl("session-grants.js"));
  var list = new dom.FakeElement("div");
  var attempts = 0;
  var grants = [{ key: "Bash", tool: "Bash", wholeTool: true, text: "Every Bash call, whatever it does (whole-tool grant)" }];
  mod.renderGrantList(list, grants, 7, function () { attempts++; return attempts > 1; });
  var button = list.querySelector(".session-grants-revoke");
  button.click();
  assert.equal(button.disabled, false, "a false sendMsg leaves the button usable");
  assert.match(list.querySelector(".session-grants-error").textContent, /Could not revoke/);
  assert.equal(list.querySelectorAll(".session-grants-row").length, 1, "the grant is still listed");
  button.click();
  assert.equal(attempts, 2);
  assert.equal(button.disabled, true, "the retry is in flight");
  assert.equal(list.querySelector(".session-grants-error").textContent, "", "the old failure is cleared");
});

test("a server refusal re-enables every Revoke and shows why; the server's list removes the row", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var mod = await import(dom.moduleUrl("session-grants.js"));
  var list = new dom.FakeElement("div");
  var grants = [
    { key: "Bash", tool: "Bash", wholeTool: true, text: "Every Bash call (whole-tool grant)" },
    { key: "Write", tool: "Write", wholeTool: true, text: "Every Write call (whole-tool grant)" },
  ];
  mod.renderGrantList(list, grants, 7, function () { return true; });
  list.querySelectorAll(".session-grants-revoke").forEach(function (b) { b.click(); });
  mod.showGrantError(list, "Could not revoke: that session is not available to you");
  list.querySelectorAll(".session-grants-revoke").forEach(function (b) { assert.equal(b.disabled, false); });
  assert.match(list.querySelector(".session-grants-error").textContent, /not available to you/);
  assert.equal(list.querySelectorAll(".session-grants-row").length, 2);

  mod.renderGrantList(list, [grants[1]], 7, function () { return true; });
  assert.equal(list.querySelectorAll(".session-grants-row").length, 1, "confirmed: the revoked row is gone");
  assert.equal(list.querySelector(".session-grants-error").textContent, "");
});

// --- what the ask, the card and the banner say of a call --------------------

var GAVE_NO_COMMAND = "a Bash call that gave no command";
var LONG = "x".repeat(200);

// [name, toolName, toolInput, expected verb, expected target]
var ASK_ROWS = [
  ["AC1 the command, never the description", "Bash", { command: "find /var/tmp", description: "placeholder" }, "run", "find /var/tmp"],
  ["AC1 a long command is trimmed", "Bash", { command: LONG }, "run", "x".repeat(80) + "..."],
  ["AC4 export prefix shortened to names", "Bash", { command: "export CLAGENTIC_SUBAGENT_ID=af5860c5-1111; find /var/tmp -name x", description: "placeholder" }, "run", "(sets CLAGENTIC_SUBAGENT_ID) find /var/tmp -name x"],
  ["AC4 inline assignments, quoted value is not shortened", "Bash", { command: "A=1 B='x y' make test" }, "run", "A=1 B='x y' make test"],
  ["AC4 several export statements", "Bash", { command: "export A=1; export B=2 && ls -l" }, "run", "(sets A, B) ls -l"],
  ["AC4 many names are counted", "Bash", { command: "A=1 B=2 C=3 D=4 E=5 make" }, "run", "(sets A, B, C +2) make"],
  ["AC4 a value that runs a command is not hidden", "Bash", { command: "A=$(rm -rf x) ls" }, "run", "A=$(rm -rf x) ls"],
  ["AC4 assignments alone are shown as they are", "Bash", { command: "export A=1" }, "run", "export A=1"],
  ["AC5 empty command", "Bash", { command: "", description: "placeholder" }, "run", GAVE_NO_COMMAND],
  ["AC5 missing command", "Bash", { description: "placeholder" }, "run", GAVE_NO_COMMAND],
  ["AC5 blank command", "Bash", { command: "  \n", description: "placeholder" }, "run", GAVE_NO_COMMAND],
  ["AC3 override character shown, not interpreted", "Bash", { command: "echo " + String.fromCharCode(0x202e) + "txt.exe" }, "run", "echo \\u202Etxt.exe"],
  ["AC3 newline is one line in the ask, shown as a mark and not as a space", "Bash", { command: "ls\nrm x" }, "run", "ls ⏎ rm x"],
  ["AC7 Write", "Write", { file_path: "/a/b/c/d/e.txt" }, "write to", ".../c/d/e.txt"],
  ["AC7 Edit", "Edit", { file_path: "/a/b.txt" }, "edit", "/a/b.txt"],
  ["AC7 Read", "Read", { file_path: "/a/b.txt" }, "read", "/a/b.txt"],
  ["AC7 Grep", "Grep", { pattern: "foo" }, "search", "foo"],
  ["AC7 Glob", "Glob", { pattern: "*.js" }, "search for files in", "*.js"],
  ["AC7 WebFetch", "WebFetch", { url: "https://example.test/" }, "fetch", "https://example.test/"],
  ["AC7 WebSearch", "WebSearch", { query: "q" }, "search the web for", "q"],
  ["AC7 another tool", "Other", { description: "d" }, "use Other", ""],
];

test("askWording names the command, never the description, and leaves the other tools as they were", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var mod = await import(dom.moduleUrl("prompt-kinds/permission.js"));
  ASK_ROWS.forEach(function (row) {
    var wording = mod.askWording(row[1], row[2]);
    assert.deepEqual(wording, { verb: row[3], target: row[4] }, row[0]);
  });
});

test("the card shows the description as the agent's own, the full command verbatim, and a plain ask", async function (t) {
  var env = await dom.setupToolsEnv(t);
  var esc = String.fromCharCode(27);
  var command = "export CLAGENTIC_SUBAGENT_ID=af5860c5-1111; echo hi" + esc + "[31m\n" + String.fromCharCode(0x202e) + "tail " + LONG;
  env.tools.applyPromptMessage(request("c1", { toolInput: { command: command, description: "placeholder" } }));
  var card = dom.cardFor(env, "c1");
  assert.match(card.querySelector(".perm-ask").textContent, /^Can I run \(sets CLAGENTIC_SUBAGENT_ID\) echo hi/);
  assert.doesNotMatch(card.querySelector(".perm-ask").textContent, /placeholder/, "AC1 the description is not in the ask");
  assert.equal(card.querySelector(".perm-description").textContent, "Agent's description: placeholder", "AC2");
  var block = card.querySelector(".perm-command");
  assert.ok(block, "AC3 the command block is on the card, outside Details");
  assert.equal(block._parent.className.indexOf("perm-details"), -1);
  var shown = block.textContent;
  assert.ok(shown.indexOf("export CLAGENTIC_SUBAGENT_ID=af5860c5-1111; echo hi") === 0, "AC4 the full command keeps its assignments");
  assert.ok(shown.indexOf("\\x1B[31m\n\\u202Etail ") !== -1, "AC3 controls and overrides are shown visibly; line breaks stay");
  assert.ok(shown.indexOf(LONG) !== -1, "AC3 verbatim, not trimmed");
  assert.ok(shown.indexOf(esc) === -1 && shown.indexOf(String.fromCharCode(0x202e)) === -1);
});

test("a Bash card with no command says so, shows no command block, and does not offer the description as the command", async function (t) {
  var env = await dom.setupToolsEnv(t);
  env.tools.applyPromptMessage(request("c2", { toolInput: { description: "placeholder" } }));
  var card = dom.cardFor(env, "c2");
  assert.equal(card.querySelector(".perm-ask").textContent, "Can I run " + GAVE_NO_COMMAND + "?");
  assert.equal(card.querySelector(".perm-command"), null);
  assert.equal(card.querySelector(".perm-description").textContent, "Agent's description: placeholder");
});

test("a card for another tool draws no description or command block", async function (t) {
  var env = await dom.setupToolsEnv(t);
  env.tools.applyPromptMessage(request("c3", { toolName: "Write", toolInput: { file_path: "/work/a.txt", description: "d", command: "c" } }));
  var card = dom.cardFor(env, "c3");
  assert.equal(card.querySelector(".perm-description"), null);
  assert.equal(card.querySelector(".perm-command"), null);
  assert.equal(card.querySelector(".perm-ask").textContent, "Can I write to /work/a.txt?");
});

test("the card speaker is the session's vendor, else a neutral identity, never Claude by default", async function (t) {
  var env = await dom.setupToolsEnv(t);
  var storeMod = await import(dom.moduleUrl("store.js"));
  function speaker(id, extra) {
    env.tools.applyPromptMessage(request(id, extra));
    var card = dom.cardFor(env, id);
    return { name: card.querySelector(".dm-bubble-name").textContent, avatar: card.querySelector(".dm-bubble-avatar") };
  }

  var codex = speaker("v1", { vendor: "codex" });
  assert.equal(codex.name, "Codex");
  assert.equal(codex.avatar.src, "/codex-avatar.png");

  var claude = speaker("v2", { vendor: "claude" });
  assert.equal(claude.name, "Claude Code");

  var unknown = speaker("v3", {});
  assert.equal(unknown.name, "Assistant", "AC6 no vendor anywhere: neutral");
  assert.equal(unknown.avatar.tagName, "SPAN", "and no vendor avatar");
  assert.equal(unknown.avatar.src, undefined);

  storeMod.store.set({ sessionVendors: { 7: "codex" }, activeSessionId: 7 });
  var listed = speaker("v4", {});
  assert.equal(listed.name, "Codex", "the session list's vendor stands in when the request names none");
  assert.equal(listed.avatar.src, "/codex-avatar.png");
});

test("the banner title is the same ask: the command, not the description; its summary shows the command an export prefixes", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var storeMod = await import(dom.moduleUrl("store.js"));
  storeMod.createStore({ connected: true });
  var notifications = await import(dom.moduleUrl("app-notifications.js"));
  notifications.initAppNotifications();
  var container = global.document.body.querySelector(".overlay-stack");
  notifications.handleNotificationCreated({
    unreadCount: 1,
    notification: {
      id: "b1", type: "permission_request", slug: "alpha", sessionId: 7, title: "Permission", body: "",
      meta: {
        requestId: "r-b1", kind: "permission", toolName: "Bash",
        toolInput: { command: "export CLAGENTIC_SUBAGENT_ID=af5860c5-1111; find /var/tmp", description: "placeholder" },
      },
    },
  });
  var banner = container.querySelector('[data-notif-id="b1"]');
  assert.ok(banner, "the banner is drawn");
  assert.ok(banner.innerHTML.indexOf("Can I run (sets CLAGENTIC_SUBAGENT_ID) find /var/tmp?") !== -1, "AC1 AC4 the title names the command");
  assert.equal(banner.innerHTML.indexOf("placeholder"), -1, "the description is not on the banner");
});

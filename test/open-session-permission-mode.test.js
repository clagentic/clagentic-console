"use strict";
// Mode of a session opened by the CLI or a trigger: the open request's
// --permission-mode, else the server setting, else accept edits. Every value
// passes the shared mode check for the vendor the session will run on.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { createSessionInput } = require("../lib/session-input");
var { handleSessionCommand } = require("../lib/session-input-ipc");
var { parseSessionArgs } = require("../lib/cli/session-subcommands");
var { attachExternalTrigger } = require("../lib/project-external-trigger");
var policy = require("../lib/permission-mode-policy");
var { claudeCapabilities } = require("../lib/yoke/adapters/claude-capabilities");

var CLAUDE_MODES = claudeCapabilities().permissionModes;

// Loaded by the daemon at start-up (lib/prompt-registry.js); a unit test loads
// the own-key lookups the mode check uses itself.
test.before(function () { return require("../lib/prompt-kinds/codecs").load(); });

// A project with just what openSession touches. `modesByVendor` is what each
// vendor declares; skip-permissions is off, as on main.
function makeProject(modesByVendor) {
  var created = [];
  var started = [];
  var firstEmitted = [];
  var sm = {
    sessions: new Map(),
    defaultVendor: "claude",
    createSession: function (options) {
      created.push(options);
      // As the real manager does, the new session starts in the mode the creator
      // names, else the project default, and the first session_switched is sent
      // from createSession itself: record the mode it would carry.
      var s = { localId: created.length, history: [], vendor: options.vendor || null, permissionMode: options.permissionMode || "default" };
      firstEmitted.push(s.permissionMode);
      sm.sessions.set(s.localId, s);
      return s;
    },
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    recordHistoryEntry: function (s, e) { s.history.push(e); },
    appendToSessionFile: function () {},
    deleteSession: function () {},
  };
  return {
    created: created,
    firstEmitted: firstEmitted,
    started: started,
    cwd: "/unused",
    sm: sm,
    sdk: { startQuery: function (s, text) { started.push({ session: s, text: text }); } },
    onProcessingChanged: function () {},
    getLinuxUserForSession: function () { return null; },
    checkPermissionModeFor: function (session, mode) {
      var vendor = (session && session.vendor) || "claude";
      return policy.checkPermissionMode(mode, { skipPermissionsAllowed: false, supportedModes: modesByVendor[vendor] || [] });
    },
  };
}

// The mode the first session opened in this project was left in.
function openedMode(project) {
  return project.sm.sessions.get(1).permissionMode;
}

function open(project, settings, request) {
  var input = createSessionInput({
    getProject: function (slug) { return slug === "p" ? project : null; },
    agentCatalog: function () { return [{ name: "reviewer-agent" }]; },
    getPermissionSettings: function () { return settings; },
  });
  return input.openSession(Object.assign({ projectSlug: "p", prompt: "go" }, request || {}));
}

var CLAUDE = { claude: CLAUDE_MODES, codex: [] };

test("without the flag or a setting a session opens in accept edits, as it always did", function () {
  var project = makeProject(CLAUDE);
  var r = open(project, null, {});
  assert.equal(r.result, "opened");
  assert.equal(openedMode(project), "acceptEdits");
  var stored = open(makeProject(CLAUDE), { autoApproveReadOnly: true, openedSessionMode: "acceptEdits" }, {});
  assert.equal(stored.result, "opened");
});

test("the server setting is the mode when the request names none", function () {
  var project = makeProject(CLAUDE);
  assert.equal(open(project, { openedSessionMode: "plan" }, {}).result, "opened");
  assert.equal(openedMode(project), "plan");
});

test("the first session_switched of an opened session already carries the requested mode", function () {
  var project = makeProject(CLAUDE);
  assert.equal(open(project, null, { permissionMode: "plan" }).result, "opened");
  assert.deepEqual(project.firstEmitted, ["plan"]);
  var stored = makeProject(CLAUDE);
  assert.equal(open(stored, { openedSessionMode: "default" }, {}).result, "opened");
  assert.deepEqual(stored.firstEmitted, ["default"]);
});

test("the flag wins over the server setting", function () {
  var project = makeProject(CLAUDE);
  assert.equal(open(project, { openedSessionMode: "plan" }, { permissionMode: "default" }).result, "opened");
  assert.equal(openedMode(project), "default");
  var other = makeProject(CLAUDE);
  assert.equal(open(other, { openedSessionMode: "acceptEdits" }, { permissionMode: "plan" }).result, "opened");
  assert.equal(openedMode(other), "plan");
});

test("a flag the shared check refuses fails the open with a clear error and starts nothing", function () {
  ["bypassPermissions", "nonsense", "constructor"].forEach(function (mode) {
    var project = makeProject(CLAUDE);
    var r = open(project, { openedSessionMode: "plan" }, { permissionMode: mode });
    assert.equal(r.ok, false, mode);
    assert.equal(r.result, "refused");
    assert.match(r.reason, /permissionMode/);
    assert.equal(project.created.length, 0);
    assert.equal(project.started.length, 0);
  });
  var notAString = open(makeProject(CLAUDE), null, { permissionMode: 5 });
  assert.equal(notAString.result, "refused");
});

test("the flag is checked against the vendor the session will run on", function () {
  var codex = makeProject(CLAUDE);
  var refused = open(codex, null, { permissionMode: "auto", vendor: "codex" });
  assert.equal(refused.result, "refused");
  assert.match(refused.reason, /does not support the auto/);
  assert.equal(codex.created.length, 0);
  var claude = makeProject(CLAUDE);
  assert.equal(open(claude, null, { permissionMode: "auto" }).result, "opened");
  assert.equal(openedMode(claude), "auto");
});

test("a stored setting the check now refuses falls back to accept edits and logs it", function () {
  var lines = [];
  var warn = console.warn;
  console.warn = function (line) { lines.push(String(line)); };
  try {
    var project = makeProject(CLAUDE);
    var r = open(project, { openedSessionMode: "bypassPermissions" }, {});
    assert.equal(r.result, "opened", "the open itself goes ahead");
    assert.equal(openedMode(project), "acceptEdits");
    var gated = makeProject(CLAUDE);
    assert.equal(open(gated, { openedSessionMode: "auto" }, { vendor: "codex" }).result, "opened");
    assert.equal(openedMode(gated), "acceptEdits");
  } finally {
    console.warn = warn;
  }
  assert.equal(lines.filter(function (l) { return l.indexOf("stored opened-session mode") !== -1; }).length, 2);
});

test("a project double without the vendor check still gets the mode and server checks", function () {
  var project = makeProject(CLAUDE);
  delete project.checkPermissionModeFor;
  assert.equal(open(project, null, { permissionMode: "plan" }).result, "opened");
  assert.equal(open(project, null, { permissionMode: "bypassPermissions" }).result, "refused");
});

test("the CLI flag reaches the daemon request and the IPC handler passes it on", function () {
  var parsed = parseSessionArgs("open-session", ["--project", "p", "--prompt", "go", "--permission-mode", "plan"]);
  assert.equal(parsed.request.permissionMode, "plan");
  assert.match(parseSessionArgs("open-session", ["--project", "p", "--prompt", "go", "--permission-mode"]).error, /Missing value/);
  assert.match(parseSessionArgs("send-input", ["--project", "p", "--session", "s", "--prompt", "go", "--permission-mode", "plan"]).error, /Unknown option/);

  var seen = null;
  handleSessionCommand({ openSession: function (req) { seen = req; return { ok: true }; } },
    { cmd: "open_session", projectSlug: "p", prompt: "go", permissionMode: "plan" });
  assert.equal(seen.permissionMode, "plan");
});

test("a trigger file cannot name a mode: it opens in the server setting's mode", async function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-mode-trigger-"));
  var trigger = null;
  try {
    var project = makeProject(CLAUDE);
    var input = createSessionInput({
      getProject: function () { return project; },
      getPermissionSettings: function () { return { openedSessionMode: "default" }; },
    });
    trigger = attachExternalTrigger({ triggersDir: dir, getProject: function () { return project; }, sessionInput: input });
    fs.writeFileSync(path.join(dir, "t1.json"), JSON.stringify({
      version: 2, id: "t1", projectSlug: "p", initialPrompt: "go", permissionMode: "plan",
    }));
    trigger.startWatcher();
    await new Promise(function (resolve) { setTimeout(resolve, 1500); });
    assert.equal(project.created.length, 1);
    assert.equal(openedMode(project), "default");
  } finally {
    if (trigger) trigger.stopWatcher();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

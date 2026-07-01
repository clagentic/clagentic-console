// Unit tests for lib/settings-preflight.js (lr-1a26, epic lr-1a52 stage 5/5).
//
// Coverage:
//   - validateSettingsObject: malformed JSON already parsed → empty (not our concern)
//   - validateSettingsObject: valid settings (no hooks) → empty diagnostics
//   - validateSettingsObject: valid settings (known hooks only) → empty diagnostics
//   - validateSettingsObject: unknown hook key → warning diagnostic naming the key
//   - validateSettingsObject: hooks field is wrong type → warning diagnostic
//   - validateSettingsFile: missing file → no diagnostic (not an error)
//   - validateSettingsFile: unreadable file (mocked) → info diagnostic
//   - validateSettingsFile: malformed JSON → error diagnostic
//   - validateSettingsFile: valid JSON, no issues → empty diagnostics
//   - validateSettingsFile: valid JSON, unknown hook → warning diagnostic
//   - VALID_HOOK_EVENTS: exported and contains expected known events
//
// Strategy: validateSettingsObject is pure — no mocking needed. validateSettingsFile
// is tested with a real tmp dir (Node test:tmp or manual). validateSettingsFile
// exercised against a non-existent path to confirm it returns [] (missing = silent).
//
// We do NOT test runPreflight against real ~/.claude/ paths because the test
// environment may have any content there. validateSettingsFile is the unit seam.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var preflight = require("../lib/settings-preflight");
var validateSettingsObject = preflight.validateSettingsObject;
var validateSettingsFile = preflight.validateSettingsFile;
var runPreflight = preflight.runPreflight;
var VALID_HOOK_EVENTS = preflight.VALID_HOOK_EVENTS;

// ============================================================
// VALID_HOOK_EVENTS
// ============================================================

test("VALID_HOOK_EVENTS is a non-empty array of strings", function() {
  assert.ok(Array.isArray(VALID_HOOK_EVENTS), "must be an array");
  assert.ok(VALID_HOOK_EVENTS.length > 0, "must have at least one entry");
  for (var i = 0; i < VALID_HOOK_EVENTS.length; i++) {
    assert.strictEqual(typeof VALID_HOOK_EVENTS[i], "string", "each entry must be a string");
    assert.ok(VALID_HOOK_EVENTS[i].length > 0, "no empty strings");
  }
});

test("VALID_HOOK_EVENTS contains known hook names", function() {
  // These are the documented events. If this test fails after an intended sync,
  // update VALID_HOOK_EVENTS in settings-preflight.js and this comment.
  assert.ok(VALID_HOOK_EVENTS.indexOf("PreToolUse") !== -1, "PreToolUse must be valid");
  assert.ok(VALID_HOOK_EVENTS.indexOf("PostToolUse") !== -1, "PostToolUse must be valid");
  assert.ok(VALID_HOOK_EVENTS.indexOf("Stop") !== -1, "Stop must be valid");
});

test("VALID_HOOK_EVENTS: lr-7e22 sync adds events verified against code.claude.com/docs/en/hooks", function() {
  // Fixes false-positive "unknown hook event" warnings for operators using
  // these real, current Claude Code hook events that the older allowlist
  // predates. See settings-preflight.js header comment for verification source.
  var addedEvents = [
    "PreCompact",
    "PostCompact",
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "TaskCreated",
    "TeammateIdle",
    "TaskCompleted",
  ];
  for (var i = 0; i < addedEvents.length; i++) {
    assert.ok(VALID_HOOK_EVENTS.indexOf(addedEvents[i]) !== -1, addedEvents[i] + " must be valid (lr-7e22)");
  }
});

test("validateSettingsObject: PreCompact hook key produces no diagnostic (lr-7e22 regression)", function() {
  // Regression test for the operator's false-positive: PreCompact is a real
  // Claude Code hook event and must not be flagged as unknown.
  var settings = {
    hooks: {
      PreCompact: [{ hooks: [{ type: "command", command: "lore hook precompact-handler" }] }],
    },
  };
  var diags = validateSettingsObject(settings, "/home/user/.claude/settings.json");
  assert.strictEqual(diags.length, 0, "PreCompact must not produce a diagnostic");
});

// ============================================================
// validateSettingsObject — pure function tests
// ============================================================

test("validateSettingsObject: null/non-object returns empty diagnostics", function() {
  assert.deepStrictEqual(validateSettingsObject(null, "test"), []);
  assert.deepStrictEqual(validateSettingsObject(undefined, "test"), []);
  assert.deepStrictEqual(validateSettingsObject([], "test"), []);
  assert.deepStrictEqual(validateSettingsObject("string", "test"), []);
});

test("validateSettingsObject: empty object (no hooks field) returns empty diagnostics", function() {
  var diags = validateSettingsObject({}, "settings.json");
  assert.strictEqual(diags.length, 0, "clean settings must produce no diagnostics");
});

test("validateSettingsObject: object with valid known hooks only returns empty diagnostics", function() {
  var settings = {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
      PostToolUse: [],
    },
  };
  var diags = validateSettingsObject(settings, "/home/user/.claude/settings.json");
  assert.strictEqual(diags.length, 0, "all-known hooks must produce no diagnostics");
});

test("validateSettingsObject: unknown hook key produces warning diagnostic naming the key", function() {
  var settings = {
    hooks: {
      AgentTeams: [{ type: "command", command: "echo hi" }],
    },
  };
  var diags = validateSettingsObject(settings, "/home/user/.claude/settings.json");
  assert.strictEqual(diags.length, 1, "one unknown hook key → one diagnostic");
  var d = diags[0];
  assert.strictEqual(d.type, "diagnostic", "must be diagnostic type");
  assert.strictEqual(d.severity, "warning", "unknown hook must be warning severity");
  assert.strictEqual(d.source, "preflight", "source must be 'preflight'");
  assert.ok(d.message.indexOf("AgentTeams") !== -1, "message must name the unknown key");
  assert.ok(typeof d.message === "string" && d.message.length > 0, "message must be non-empty");
});

test("validateSettingsObject: multiple unknown hook keys produce one warning each", function() {
  var settings = {
    hooks: {
      AgentTeams: [],
      CustomHookXyz: [],
      PreToolUse: [],  // valid — must not appear in diagnostics
    },
  };
  var diags = validateSettingsObject(settings, "settings.json");
  assert.strictEqual(diags.length, 2, "two unknown keys → two diagnostics");
  var messages = diags.map(function(d) { return d.message; });
  assert.ok(messages.some(function(m) { return m.indexOf("AgentTeams") !== -1; }), "AgentTeams mentioned");
  assert.ok(messages.some(function(m) { return m.indexOf("CustomHookXyz") !== -1; }), "CustomHookXyz mentioned");
  // No diagnostic entry names PreToolUse as the offending unknown key. Note:
  // each diagnostic message legitimately echoes the full "Valid events: ..."
  // list (by design, for operator guidance), so PreToolUse — a valid event —
  // DOES appear as a substring of both messages. The correct assertion is
  // that neither message's "unknown hook event '<key>'" quoted key is
  // PreToolUse, not that the substring never appears anywhere (lr-7e22 fix —
  // this assertion was checking the wrong thing prior to this change).
  assert.ok(!messages.some(function(m) { return m.indexOf("unknown hook event 'PreToolUse'") !== -1; }), "PreToolUse must not be flagged as an unknown key");
});

test("validateSettingsObject: scope param is attached to each diagnostic (lr-7e22)", function() {
  var settings = { hooks: { AgentTeams: [] } };
  var diagsUser = validateSettingsObject(settings, "/home/user/.claude/settings.json", "user");
  var diagsProject = validateSettingsObject(settings, "/repo/.claude/settings.json", "project");
  assert.strictEqual(diagsUser[0].scope, "user", "scope must be 'user' when passed");
  assert.strictEqual(diagsProject[0].scope, "project", "scope must be 'project' when passed");
});

test("validateSettingsObject: scope is omitted (undefined) when caller does not pass it", function() {
  var settings = { hooks: { AgentTeams: [] } };
  var diags = validateSettingsObject(settings, "settings.json");
  assert.strictEqual(diags[0].scope, undefined, "scope must be undefined when not provided");
});

test("validateSettingsObject: hooks field is wrong type → warning diagnostic", function() {
  var settings = { hooks: "not-an-object" };
  var diags = validateSettingsObject(settings, "settings.json");
  assert.strictEqual(diags.length, 1);
  assert.strictEqual(diags[0].severity, "warning");
  assert.strictEqual(diags[0].source, "preflight");
  assert.ok(diags[0].message.indexOf("hooks") !== -1, "message must mention 'hooks' field");
});

test("validateSettingsObject: hooks field is null (not set, valid) → no diagnostic", function() {
  // null hooks could be valid in some CLI versions — treat as absent
  var diags = validateSettingsObject({ hooks: null }, "settings.json");
  assert.strictEqual(diags.length, 0, "null hooks must not produce a diagnostic");
});

test("validateSettingsObject: hooks is an array → warning diagnostic", function() {
  var settings = { hooks: [{ type: "command", command: "echo hi" }] };
  var diags = validateSettingsObject(settings, "settings.json");
  assert.strictEqual(diags.length, 1);
  assert.strictEqual(diags[0].severity, "warning");
});

test("validateSettingsObject: all diagnostics have required fields", function() {
  var settings = {
    hooks: {
      AgentTeams: [],
    },
  };
  var diags = validateSettingsObject(settings, "settings.json");
  assert.ok(diags.length > 0, "expected at least one diagnostic");
  for (var i = 0; i < diags.length; i++) {
    var d = diags[i];
    assert.strictEqual(d.type, "diagnostic", "type must be 'diagnostic'");
    assert.ok(["info", "warning", "error"].indexOf(d.severity) !== -1, "severity must be valid");
    assert.strictEqual(d.source, "preflight", "source must be 'preflight'");
    assert.ok(typeof d.message === "string" && d.message.length > 0, "message must be non-empty string");
  }
});

// ============================================================
// validateSettingsFile — IO tests (real tmp dir)
// ============================================================

// Helper: create a temp file with given content, return its path.
function writeTmp(name, content) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-preflight-test-"));
  var filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

test("validateSettingsFile: missing file returns empty diagnostics", function() {
  var nonExistent = path.join(os.tmpdir(), "does-not-exist-" + Date.now() + ".json");
  var diags = validateSettingsFile(nonExistent);
  assert.strictEqual(diags.length, 0, "missing file must produce no diagnostics");
});

test("validateSettingsFile: malformed JSON → error-severity diagnostic", function() {
  var filePath = writeTmp("settings.json", "{ not valid json }");
  var diags = validateSettingsFile(filePath);
  assert.strictEqual(diags.length, 1, "malformed JSON must produce exactly one diagnostic");
  assert.strictEqual(diags[0].severity, "error", "must be error severity");
  assert.strictEqual(diags[0].source, "preflight", "source must be 'preflight'");
  assert.ok(diags[0].message.indexOf(filePath) !== -1, "message must name the file");
});

test("validateSettingsFile: valid JSON with no hooks → empty diagnostics", function() {
  var filePath = writeTmp("settings.json", JSON.stringify({ model: "claude-opus-4" }));
  var diags = validateSettingsFile(filePath);
  assert.strictEqual(diags.length, 0, "clean settings must produce no diagnostics");
});

test("validateSettingsFile: valid JSON with valid hooks only → empty diagnostics", function() {
  var settings = {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [] }],
      Stop: [],
    },
  };
  var filePath = writeTmp("settings.json", JSON.stringify(settings));
  var diags = validateSettingsFile(filePath);
  assert.strictEqual(diags.length, 0, "valid hooks must produce no diagnostics");
});

test("validateSettingsFile: valid JSON with unknown hook key → warning naming the key", function() {
  var settings = {
    hooks: {
      AgentTeams: [{ type: "command", command: "echo hi" }],
      PreToolUse: [],
    },
  };
  var filePath = writeTmp("settings.json", JSON.stringify(settings));
  var diags = validateSettingsFile(filePath);
  assert.strictEqual(diags.length, 1, "one unknown key → one diagnostic");
  assert.strictEqual(diags[0].severity, "warning", "must be warning");
  assert.ok(diags[0].message.indexOf("AgentTeams") !== -1, "message must name AgentTeams");
});

test("validateSettingsFile: scope param is attached to the resulting diagnostics (lr-7e22)", function() {
  var settings = { hooks: { AgentTeams: [] } };
  var filePath = writeTmp("settings.json", JSON.stringify(settings));
  var diags = validateSettingsFile(filePath, "project");
  assert.strictEqual(diags.length, 1);
  assert.strictEqual(diags[0].scope, "project", "scope must propagate from validateSettingsFile to the diagnostic");
});

// ============================================================
// runPreflight — scope tagging across user vs project files (lr-7e22)
// ============================================================

test("runPreflight: user settings diagnostics carry scope:'user', project diagnostics carry scope:'project'", function() {
  var userDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-preflight-user-"));
  fs.mkdirSync(path.join(userDir, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(userDir, ".claude", "settings.json"),
    JSON.stringify({ hooks: { AgentTeams: [] } }),
    "utf8"
  );

  var projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-preflight-project-"));
  fs.mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, ".claude", "settings.json"),
    JSON.stringify({ hooks: { CustomHookXyz: [] } }),
    "utf8"
  );

  var diags = runPreflight({ userHome: userDir, projectDir: projectDir });
  assert.strictEqual(diags.length, 2, "one diagnostic per file");

  var userDiag = diags.filter(function(d) { return d.message.indexOf("AgentTeams") !== -1; })[0];
  var projectDiag = diags.filter(function(d) { return d.message.indexOf("CustomHookXyz") !== -1; })[0];
  assert.ok(userDiag, "AgentTeams diagnostic must be present");
  assert.ok(projectDiag, "CustomHookXyz diagnostic must be present");
  assert.strictEqual(userDiag.scope, "user", "diagnostic from ~/.claude/settings.json must carry scope:'user'");
  assert.strictEqual(projectDiag.scope, "project", "diagnostic from <project>/.claude/settings.json must carry scope:'project'");
});

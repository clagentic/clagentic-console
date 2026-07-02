// Regression + unit tests for lib/yoke/adapters/diagnostic-patterns.js (lr-28ee)
// epic lr-1a52 stage 2/5: capture CLI stderr diagnostics in claude-worker.
//
// Coverage:
//   9a — each seeded pattern produces the expected { severity, source }
//   9b — non-matching lines return null (no spurious diagnostics)
//   9c — AgentTeams-style "Unknown hook event" line yields a warning/hook diagnostic (regression)
//   9d — returned events pass validateDiagnosticEvent from the YOKE interface
//   9e — PATTERNS is an array (extensibility: adding a pattern is one data line)

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var diagnosticPatterns = require("../lib/yoke/adapters/diagnostic-patterns");
var parseDiagnosticLine = diagnosticPatterns.parseDiagnosticLine;
var PATTERNS = diagnosticPatterns.PATTERNS;

var validateDiagnosticEvent = require("../lib/yoke/interface").validateDiagnosticEvent;

// ---------------------------------------------------------------------------
// Test 9a — seeded patterns: each produces the expected severity and source
// ---------------------------------------------------------------------------

var SEED_CASES = [
  {
    label: "Settings Warning: prefix → warning/settings",
    line: "Settings Warning: unknown key 'foo' in settings.json",
    expectedSeverity: "warning",
    expectedSource: "settings",
  },
  {
    // lr-e901: PostToolUse is in VALID_HOOK_EVENTS (settings-preflight.js),
    // so a CLI "Unknown hook event: PostToolUse" line is now reconciled away
    // as a stale/false warning rather than forwarded (see 9g below). Use a
    // genuinely-unknown event name here so this seed case still exercises
    // the "Unknown hook event" pattern's happy path.
    label: "Unknown hook event → warning/hook",
    line: "Unknown hook event: SomeFutureHookEvent",
    expectedSeverity: "warning",
    expectedSource: "hook",
  },
  {
    label: "Deprecated (lowercase) → warning/cli",
    line: "deprecated flag --foo is no longer supported",
    expectedSeverity: "warning",
    expectedSource: "cli",
  },
  {
    label: "Deprecated (capital D) → warning/cli",
    line: "Deprecated: --bar will be removed in the next release",
    expectedSeverity: "warning",
    expectedSource: "cli",
  },
  {
    label: "Ignoring prefix → info/cli",
    line: "Ignoring unknown configuration key 'baz'",
    expectedSeverity: "info",
    expectedSource: "cli",
  },
];

for (var i = 0; i < SEED_CASES.length; i++) {
  // Capture loop variable for async closure safety (not needed for sync tests,
  // but conventional style in this repo's test suite)
  (function(tc) {
    test("9a: " + tc.label, function() {
      var result = parseDiagnosticLine(tc.line);
      assert.ok(result !== null,
        "parseDiagnosticLine must return a diagnostic object for: " + tc.line);
      assert.strictEqual(result.type, "diagnostic",
        "event type must be 'diagnostic'");
      assert.strictEqual(result.severity, tc.expectedSeverity,
        "severity must be '" + tc.expectedSeverity + "', got: " + result.severity);
      assert.strictEqual(result.source, tc.expectedSource,
        "source must be '" + tc.expectedSource + "', got: " + result.source);
      assert.strictEqual(typeof result.message, "string",
        "message must be a string");
      assert.ok(result.message.length > 0,
        "message must be non-empty");
    });
  })(SEED_CASES[i]);
}

// ---------------------------------------------------------------------------
// Test 9b — non-matching lines return null
// ---------------------------------------------------------------------------

var NON_MATCHING = [
  "Loaded MCP server: filesystem",
  "[sdk-worker] SDK loaded",
  "Running query with model claude-sonnet-4-5",
  "",
  "   ",
  "Session resumed from ~/.clagentic/sessions/abc123.json",
  "Tool call: Bash({\"command\":\"ls\"})",
];

for (var j = 0; j < NON_MATCHING.length; j++) {
  (function(line) {
    var label = line.length === 0 ? "(empty string)" : (line.trim().length === 0 ? "(whitespace only)" : line.substring(0, 50));
    test("9b: non-matching line returns null: " + label, function() {
      var result = parseDiagnosticLine(line);
      assert.strictEqual(result, null,
        "parseDiagnosticLine must return null for non-matching line: " + JSON.stringify(line));
    });
  })(NON_MATCHING[j]);
}

// ---------------------------------------------------------------------------
// Test 9c — AgentTeams regression: "Unknown hook event" yields warning/hook
//
// This is the exact stderr pattern emitted by the Claude CLI when a hook event
// type defined in an AgentTeams workflow is not recognised by the installed
// CLI version. It was previously dropped silently as [CLI-STDERR].
// ---------------------------------------------------------------------------

test("9c (regression): AgentTeams 'Unknown hook event' stderr line yields warning/hook diagnostic", function() {
  // Exact real-world line emitted by the Claude CLI
  var line = "Unknown hook event: AgentTeamsMemberSpawned";
  var result = parseDiagnosticLine(line);

  assert.ok(result !== null,
    "AgentTeams hook event line must produce a diagnostic, not be dropped");
  assert.strictEqual(result.type, "diagnostic");
  assert.strictEqual(result.severity, "warning",
    "AgentTeams unknown hook event must be severity 'warning'");
  assert.strictEqual(result.source, "hook",
    "AgentTeams unknown hook event must have source 'hook'");
  assert.ok(result.message.indexOf("Unknown hook event") !== -1,
    "message must preserve the original line text");
});

// ---------------------------------------------------------------------------
// Test 9d — all returned events pass validateDiagnosticEvent (YOKE contract)
// ---------------------------------------------------------------------------

test("9d: every seeded match produces a valid YOKE diagnostic event", function() {
  var lines = SEED_CASES.map(function(tc) { return tc.line; });
  for (var k = 0; k < lines.length; k++) {
    var result = parseDiagnosticLine(lines[k]);
    assert.ok(result !== null, "expected diagnostic for: " + lines[k]);
    // Will throw if invalid — that is the test
    assert.doesNotThrow(function() {
      validateDiagnosticEvent(result);
    }, "validateDiagnosticEvent must accept result for: " + lines[k]);
  }
});

// ---------------------------------------------------------------------------
// Test 9e — PATTERNS is an array (structural contract for extensibility)
// ---------------------------------------------------------------------------

test("9e: PATTERNS is an exported array with at least the 4 seeded entries", function() {
  assert.ok(Array.isArray(PATTERNS),
    "PATTERNS must be an exported array");
  assert.ok(PATTERNS.length >= 4,
    "PATTERNS must contain at least the 4 seeded entries, got: " + PATTERNS.length);

  // Each entry must have matcher, severity, source
  for (var m = 0; m < PATTERNS.length; m++) {
    var p = PATTERNS[m];
    assert.ok(
      typeof p.matcher === "string" || p.matcher instanceof RegExp,
      "PATTERNS[" + m + "].matcher must be a string or RegExp"
    );
    assert.ok(["info", "warning", "error"].indexOf(p.severity) !== -1,
      "PATTERNS[" + m + "].severity must be a valid DIAGNOSTIC_SEVERITY, got: " + p.severity);
    assert.strictEqual(typeof p.source, "string",
      "PATTERNS[" + m + "].source must be a string");
    assert.ok(p.source.length > 0,
      "PATTERNS[" + m + "].source must be non-empty");
  }
});

// ---------------------------------------------------------------------------
// Test 9f — message is bounded to 500 chars (matches [CLI-STDERR] ceiling)
// ---------------------------------------------------------------------------

test("9f: message is truncated to 500 chars for very long lines", function() {
  var longLine = "Settings Warning: " + "x".repeat(600);
  var result = parseDiagnosticLine(longLine);
  assert.ok(result !== null, "long Settings Warning line must still match");
  assert.ok(result.message.length <= 500,
    "message must be bounded to 500 chars, got: " + result.message.length);
});

// ---------------------------------------------------------------------------
// Test 9g (lr-e901 regression) — CLI "Unknown hook event" reconciled against
// VALID_HOOK_EVENTS (settings-preflight.js). A hook the Console's own
// allowlist considers valid must NOT produce a diagnostic, even though the
// CLI's stderr text says "Unknown" (installed-CLI-version lag, not a real
// unknown-hook condition). Genuinely unknown events must still pass through.
// ---------------------------------------------------------------------------

var VALID_HOOK_EVENTS = require("../lib/settings-preflight").VALID_HOOK_EVENTS;

test("9g: 'Unknown hook event' line for an event IN VALID_HOOK_EVENTS is suppressed (null)", function() {
  for (var i = 0; i < VALID_HOOK_EVENTS.length; i++) {
    var event = VALID_HOOK_EVENTS[i];
    var result = parseDiagnosticLine("Unknown hook event: " + event);
    assert.strictEqual(result, null,
      "'Unknown hook event: " + event + "' must be suppressed — " + event +
      " is in VALID_HOOK_EVENTS, so the CLI's warning is stale/false, not a real defect");
  }
});

test("9g: 'Unknown hook event' line for an event NOT in VALID_HOOK_EVENTS still produces a diagnostic", function() {
  var result = parseDiagnosticLine("Unknown hook event: TotallyMadeUpEvent");
  assert.ok(result !== null,
    "a genuinely unknown hook event must still produce a diagnostic");
  assert.strictEqual(result.severity, "warning");
  assert.strictEqual(result.source, "hook");
});

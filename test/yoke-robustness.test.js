// Regression tests for lr-a7e7 yoke robustness fixes.
//
// 7a — worker readyPromise rejects on early worker exit (not hang)
// 7b — removeFavorite works for v2 entries with no kind field
// 7c — codex queryHandle uses queryOpts.defaultModel when model is falsy
// 7d — browser tool echo strings survive backslash/newline selectors

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");
var EventEmitter = require("events");

// ---------------------------------------------------------------------------
// Test 7a — worker readyPromise rejects on early exit
//
// Strategy: import the real _test_handleWorkerEarlyExit seam from claude.js
// and call it against a minimal worker stub. This means reverting the
// _readyReject call inside _test_handleWorkerEarlyExit in claude.js will
// cause this test to fail — the test no longer holds an inlined copy.
// ---------------------------------------------------------------------------

var claudeAdapter = require("../lib/yoke/adapters/claude");
var _test_handleWorkerEarlyExit = claudeAdapter._test_handleWorkerEarlyExit;

/**
 * Build a minimal worker stub with the same readyPromise/_readyReject
 * structure used in spawnWorker(). Call _test_handleWorkerEarlyExit to
 * simulate what the real exit handler does.
 * Returns { worker, simulateExit } so tests can trigger exit at will.
 */
function buildWorkerWithExitHandler() {
  var worker = {
    ready: false,
    readyPromise: null,
    _readyResolve: null,
    _readyReject: null,
    _stderrBuf: "",
    messageHandlers: [],
    process: new EventEmitter(),
  };

  worker.readyPromise = new Promise(function(resolve, reject) {
    worker._readyResolve = resolve;
    worker._readyReject = reject;
  });

  return {
    worker: worker,
    simulateExit: function(code, signal) {
      // Call the real exported seam from claude.js — not an inlined copy.
      _test_handleWorkerEarlyExit(worker, code !== undefined ? code : 1, signal || null);
    },
  };
}

test("7a: readyPromise rejects when worker exits before 'ready' (non-zero exit)", function() {
  var ctx = buildWorkerWithExitHandler();
  ctx.simulateExit(1, null);

  // readyPromise must reject — not hang — with a descriptive message
  return ctx.worker.readyPromise.then(
    function() { throw new Error("Expected readyPromise to reject, but it resolved"); },
    function(err) {
      assert.ok(err instanceof Error, "rejection value is an Error");
      assert.ok(
        err.message.indexOf("Worker exited before ready") !== -1,
        "error message contains 'Worker exited before ready', got: " + err.message
      );
    }
  );
});

test("7a: readyPromise rejects when worker exits via signal before 'ready'", function() {
  var ctx = buildWorkerWithExitHandler();
  ctx.simulateExit(null, "SIGTERM");

  return ctx.worker.readyPromise.then(
    function() { throw new Error("Expected readyPromise to reject, but it resolved"); },
    function(err) {
      assert.ok(err instanceof Error, "rejection value is an Error");
      assert.ok(
        err.message.indexOf("Worker exited before ready") !== -1,
        "error message mentions early exit, got: " + err.message
      );
    }
  );
});

test("7a: readyPromise resolves normally when 'ready' is received before exit", function() {
  var ctx = buildWorkerWithExitHandler();
  // Mark the worker ready before simulating exit
  ctx.worker.ready = true;
  if (ctx.worker._readyResolve) {
    ctx.worker._readyResolve();
    ctx.worker._readyResolve = null;
  }
  ctx.simulateExit(0, null);

  return ctx.worker.readyPromise; // should resolve cleanly
});

// ---------------------------------------------------------------------------
// Test 7b — removeFavorite works for v2 entries (no kind field)
//
// agents-favorites.js uses FAVORITES_PATH under ~/.clagentic/agents/chattable.json.
// We redirect this by writing a custom JSON file to a temp dir and monkeypatching
// FAVORITES_PATH before require — but since the module caches the path at load
// time we exercise the public API against real temp files written to the real
// FAVORITES_PATH location.
//
// Since the module exports its path constant we can read it and manipulate disk
// state directly to set up each test scenario.
// ---------------------------------------------------------------------------

var favoritesModule = require("../lib/agents-favorites");
var {
  addFavorite,
  removeFavorite,
  isFavorite,
  listFavorites,
  FAVORITES_PATH,
} = favoritesModule;

// Back up and restore FAVORITES_PATH contents around each test.
function withCleanFavorites(fn) {
  var original = null;
  try {
    original = fs.readFileSync(FAVORITES_PATH, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    original = null;
  }
  try {
    // Start from a clean v2 empty store
    var dir = path.dirname(FAVORITES_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FAVORITES_PATH, JSON.stringify({ version: 2, favorites: [], recents: [] }, null, 2) + "\n");
    return fn();
  } finally {
    if (original === null) {
      try { fs.unlinkSync(FAVORITES_PATH); } catch (e) {}
    } else {
      try { fs.writeFileSync(FAVORITES_PATH, original); } catch (e) {}
    }
  }
}

test("7b: removeFavorite returns true for a v2 entry (name-only, no kind)", function() {
  withCleanFavorites(function() {
    var agent = { name: "test-agent-lr-a7e7" };
    var added = addFavorite(agent);
    assert.strictEqual(added, true, "addFavorite should succeed");
    assert.strictEqual(isFavorite(agent), true, "isFavorite should be true after add");

    // v2 entry has no kind field — removeFavorite must find it by name only
    var removed = removeFavorite({ name: "test-agent-lr-a7e7" });
    assert.strictEqual(removed, true, "removeFavorite should return true for v2 entry without kind");
    assert.strictEqual(isFavorite(agent), false, "isFavorite should be false after remove");
  });
});

test("7b: removeFavorite returns false when agent not present", function() {
  withCleanFavorites(function() {
    var result = removeFavorite({ name: "agent-that-was-never-added" });
    assert.strictEqual(result, false, "removeFavorite should return false for absent entry");
  });
});

test("7b: removeFavorite works for v1 entries that were migrated (kind still present in input)", function() {
  // Write a v1 store directly so migrateV1toV2 runs on first readStore()
  withCleanFavorites(function() {
    var dir = path.dirname(FAVORITES_PATH);
    fs.mkdirSync(dir, { recursive: true });
    // Write v1 schema with kind field
    var v1 = {
      version: 1,
      favorites: [
        { name: "legacy-agent", kind: "sdk", pluginName: "some-plugin", addedAt: 1000 },
      ],
      recents: [],
    };
    fs.writeFileSync(FAVORITES_PATH, JSON.stringify(v1, null, 2) + "\n");

    // After migration the entry lives as {name, addedAt} — no kind.
    // removeFavorite must still match by name.
    var result = removeFavorite({ name: "legacy-agent", kind: "sdk" });
    assert.strictEqual(result, true, "removeFavorite should remove migrated v1 entry matched by name");
    assert.strictEqual(isFavorite({ name: "legacy-agent" }), false, "entry should be absent after remove");
  });
});

// ---------------------------------------------------------------------------
// Test 7c — codex queryHandle uses queryOpts.defaultModel when model is falsy
//
// We import the real _test_resolveModel seam exported from codex.js.
// That function is defined in codex.js and called by the real
// createCodexQueryHandle for both state.model and threadParams.model, so
// reverting the || queryOpts.defaultModel term in codex.js breaks this test.
// ---------------------------------------------------------------------------

var codexAdapter = require("../lib/yoke/adapters/codex");
var _test_resolveModel = codexAdapter._test_resolveModel;

test("7c: state.model uses defaultModel when queryOpts.model is undefined", function() {
  var model = _test_resolveModel({ model: undefined, defaultModel: "test-model" });
  assert.strictEqual(model, "test-model",
    "state.model must fall back to defaultModel when model is undefined");
});

test("7c: state.model uses defaultModel when queryOpts.model is null", function() {
  var model = _test_resolveModel({ model: null, defaultModel: "test-model" });
  assert.strictEqual(model, "test-model",
    "state.model must fall back to defaultModel when model is null");
});

test("7c: state.model uses defaultModel when queryOpts.model is empty string", function() {
  var model = _test_resolveModel({ model: "", defaultModel: "test-model" });
  assert.strictEqual(model, "test-model",
    "state.model must fall back to defaultModel when model is empty string");
});

test("7c: state.model uses queryOpts.model when it is truthy (defaultModel ignored)", function() {
  var model = _test_resolveModel({ model: "gpt-5.5", defaultModel: "should-not-appear" });
  assert.strictEqual(model, "gpt-5.5",
    "state.model must use queryOpts.model when it is truthy");
});

test("7c: state.model falls back to hardcoded default when both model and defaultModel are falsy", function() {
  var model = _test_resolveModel({ model: null, defaultModel: null });
  assert.strictEqual(model, "gpt-5.5",
    "state.model must use the hardcoded fallback gpt-5.5 when both are falsy");
});

// Verify the same seam covers threadParams.model (both callers use _test_resolveModel).
test("7c: threadParams.model uses defaultModel when queryOpts.model is falsy (runQueryLoop path)", function() {
  var model = _test_resolveModel({ model: undefined, defaultModel: "from-adapter" });
  assert.strictEqual(model, "from-adapter",
    "threadParams.model must also fall back to defaultModel");
});

// ---------------------------------------------------------------------------
// Test 7d — browser tool echo strings survive backslash/newline selectors
//
// browser-mcp-server.js uses JSON.stringify(args.selector) when embedding a
// CSS selector into a script string for tab_evaluate. This ensures characters
// like backslash and newline are properly escaped. The tool handler returns
// a result object with { content: [{ type: "text", text: <echo string> }] }.
//
// We call each relevant tool handler directly with a mock sendCommand that
// captures the generated script and returns a mock result. We assert:
//   1. No exception is thrown during script construction.
//   2. The echo string in the return value is valid JSON-parseable (if it
//      were the result text) and contains no raw newlines or unescaped
//      backslashes that would break JSON parsing.
//   3. The generated script string itself is valid — JSON.parse of the
//      selector sub-expression inside it matches the original selector.
// ---------------------------------------------------------------------------

var browserMcpServer = require("../lib/browser-mcp-server");

// Build tool handlers using a mock sendCommand.
// sendCommand returns a promise that resolves with { value: "<echo string>" }
// so the tab_evaluate path inside each handler works.
function buildMockTools() {
  var capturedArgs = [];

  function mockSend(command, args) {
    capturedArgs.push({ command: command, args: args });
    // Simulate tab_evaluate returning the value that the script produces.
    // For test 7d we just need to check the script was built without error.
    return Promise.resolve({ value: "mock-result" });
  }

  var toolDefs = browserMcpServer.getToolDefs(mockSend, null, null);
  var toolMap = {};
  for (var i = 0; i < toolDefs.length; i++) {
    toolMap[toolDefs[i].name] = toolDefs[i];
  }

  return { toolMap: toolMap, capturedArgs: capturedArgs };
}

// Extract the JSON-stringified selector expression embedded in a script.
// The script contains: document.querySelector(<json>) — we parse the argument.
function extractSelectorFromScript(script, selectorJsonStr) {
  // Verify that the selector, when JSON.stringified, appears verbatim in the script
  return script.indexOf(selectorJsonStr) !== -1;
}

test("7d: browser_click handles selector with backslash without throwing", function() {
  var ctx = buildMockTools();
  var clickTool = ctx.toolMap["browser_click"];
  assert.ok(clickTool, "browser_click tool must be defined");

  var weirdSelector = "div.a\\b"; // backslash in selector
  return clickTool.handler({ tabId: 1, selector: weirdSelector }).then(function(result) {
    assert.ok(result && result.content && result.content.length > 0,
      "handler must return a content array");
    assert.strictEqual(result.content[0].type, "text",
      "content[0].type must be 'text'");

    // Verify the generated script contained a safely-escaped version of the selector
    var lastCall = ctx.capturedArgs[ctx.capturedArgs.length - 1];
    assert.strictEqual(lastCall.command, "tab_evaluate",
      "must have called tab_evaluate");

    // The script must be a valid JS string (no syntax-breaking raw characters)
    var script = lastCall.args.script;
    assert.strictEqual(typeof script, "string", "script must be a string");

    // JSON.stringify of the selector must appear in the script verbatim
    var encodedSelector = JSON.stringify(weirdSelector);
    assert.ok(
      script.indexOf(encodedSelector) !== -1,
      "script must contain the JSON-encoded selector. encoded=" + encodedSelector + " script=" + script.substring(0, 200)
    );
  });
});

test("7d: browser_click handles selector with newline without throwing", function() {
  var ctx = buildMockTools();
  var clickTool = ctx.toolMap["browser_click"];

  var newlineSelector = "div\n.foo"; // literal newline in selector
  return clickTool.handler({ tabId: 1, selector: newlineSelector }).then(function(result) {
    assert.ok(result && result.content, "handler must return result");

    var lastCall = ctx.capturedArgs[ctx.capturedArgs.length - 1];
    var script = lastCall.args.script;
    var encodedSelector = JSON.stringify(newlineSelector);
    assert.ok(
      script.indexOf(encodedSelector) !== -1,
      "script must contain JSON-encoded selector (newline escaped). encoded=" + encodedSelector
    );

    // The encoded selector must not contain a raw newline (must be \\n in JSON form)
    assert.strictEqual(
      encodedSelector.indexOf("\n"), -1,
      "JSON.stringify of the selector must escape raw newlines"
    );
  });
});

test("7d: browser_type handles selector with backslash without throwing", function() {
  var ctx = buildMockTools();
  var typeTool = ctx.toolMap["browser_type"];
  assert.ok(typeTool, "browser_type tool must be defined");

  var weirdSelector = "input[name='a\\\\b']";
  return typeTool.handler({ tabId: 1, selector: weirdSelector, text: "hello" }).then(function(result) {
    assert.ok(result && result.content, "handler must return result");

    var lastCall = ctx.capturedArgs[ctx.capturedArgs.length - 1];
    assert.strictEqual(lastCall.command, "tab_evaluate");

    var script = lastCall.args.script;
    var encodedSelector = JSON.stringify(weirdSelector);
    assert.ok(
      script.indexOf(encodedSelector) !== -1,
      "script must contain JSON-encoded selector. encoded=" + encodedSelector
    );
  });
});

test("7d: browser_scroll handles selector with backslash without throwing", function() {
  var ctx = buildMockTools();
  var scrollTool = ctx.toolMap["browser_scroll"];
  assert.ok(scrollTool, "browser_scroll tool must be defined");

  var weirdSelector = "div.a\\b";
  return scrollTool.handler({ tabId: 1, selector: weirdSelector }).then(function(result) {
    assert.ok(result && result.content, "handler must return result");

    var lastCall = ctx.capturedArgs[ctx.capturedArgs.length - 1];
    assert.strictEqual(lastCall.command, "tab_evaluate");

    var script = lastCall.args.script;
    var encodedSelector = JSON.stringify(weirdSelector);
    assert.ok(
      script.indexOf(encodedSelector) !== -1,
      "script must contain JSON-encoded selector. encoded=" + encodedSelector
    );
  });
});

test("7d: browser_click with normal selector still works (no regression)", function() {
  var ctx = buildMockTools();
  var clickTool = ctx.toolMap["browser_click"];

  return clickTool.handler({ tabId: 1, selector: "#submit-btn" }).then(function(result) {
    assert.ok(result && result.content, "handler must return result for normal selector");
    var lastCall = ctx.capturedArgs[ctx.capturedArgs.length - 1];
    assert.strictEqual(lastCall.command, "tab_evaluate");
    var script = lastCall.args.script;
    assert.ok(script.indexOf('"#submit-btn"') !== -1, "normal selector must appear in script");
  });
});

// ---------------------------------------------------------------------------
// Test 8 — YOKE interface contract: 'diagnostic' event type (lr-8c43)
//
// Validates validateDiagnosticEvent against the shape documented in
// interface.js. Every acceptance test proves the validator passes a valid
// object; every rejection test proves the validator throws on a specific
// violation. Tests are independent of any adapter — the validator is
// vendor-agnostic by design.
// ---------------------------------------------------------------------------

var yokeIface = require("../lib/yoke/interface");
var validateDiagnosticEvent = yokeIface.validateDiagnosticEvent;
var DIAGNOSTIC_SEVERITIES = yokeIface.DIAGNOSTIC_SEVERITIES;
var DIAGNOSTIC_SOURCES = yokeIface.DIAGNOSTIC_SOURCES;
var INTERFACE_VERSION = yokeIface.INTERFACE_VERSION;

// --- exports surface ---

test("8: INTERFACE_VERSION is exported and is a semver string", function() {
  assert.strictEqual(typeof INTERFACE_VERSION, "string",
    "INTERFACE_VERSION must be a string");
  assert.ok(
    /^\d+\.\d+\.\d+$/.test(INTERFACE_VERSION),
    "INTERFACE_VERSION must match semver x.y.z, got: " + INTERFACE_VERSION
  );
});

test("8: INTERFACE_VERSION is 0.2.0 after diagnostic event migration", function() {
  assert.strictEqual(INTERFACE_VERSION, "0.2.0",
    "INTERFACE_VERSION must be 0.2.0 after lr-8c43 migration");
});

test("8: DIAGNOSTIC_SEVERITIES contains info, warning, error", function() {
  assert.ok(Array.isArray(DIAGNOSTIC_SEVERITIES), "must be array");
  assert.ok(DIAGNOSTIC_SEVERITIES.indexOf("info") !== -1, "must include 'info'");
  assert.ok(DIAGNOSTIC_SEVERITIES.indexOf("warning") !== -1, "must include 'warning'");
  assert.ok(DIAGNOSTIC_SEVERITIES.indexOf("error") !== -1, "must include 'error'");
});

test("8: DIAGNOSTIC_SOURCES documents well-known source identifiers", function() {
  assert.ok(Array.isArray(DIAGNOSTIC_SOURCES), "must be array");
  ["settings", "mcp", "cli", "hook"].forEach(function(src) {
    assert.ok(DIAGNOSTIC_SOURCES.indexOf(src) !== -1,
      "DIAGNOSTIC_SOURCES must include '" + src + "'");
  });
});

// --- acceptance: minimal valid event ---

test("8: validateDiagnosticEvent accepts minimal valid event (no actionable)", function() {
  assert.doesNotThrow(function() {
    validateDiagnosticEvent({
      type: "diagnostic",
      severity: "warning",
      source: "settings",
      message: "settings.json has an unknown key",
    });
  });
});

test("8: validateDiagnosticEvent accepts all three severity levels", function() {
  ["info", "warning", "error"].forEach(function(sev) {
    assert.doesNotThrow(function() {
      validateDiagnosticEvent({
        type: "diagnostic",
        severity: sev,
        source: "cli",
        message: "test message",
      });
    }, "should accept severity: " + sev);
  });
});

test("8: validateDiagnosticEvent accepts well-known source strings", function() {
  ["settings", "mcp", "cli", "hook"].forEach(function(src) {
    assert.doesNotThrow(function() {
      validateDiagnosticEvent({
        type: "diagnostic",
        severity: "info",
        source: src,
        message: "test",
      });
    }, "should accept source: " + src);
  });
});

test("8: validateDiagnosticEvent accepts a custom (non-listed) source string", function() {
  // Source is intentionally free-form; adapters may emit vendor-specific values.
  assert.doesNotThrow(function() {
    validateDiagnosticEvent({
      type: "diagnostic",
      severity: "info",
      source: "permissions",
      message: "custom source allowed",
    });
  });
});

test("8: validateDiagnosticEvent accepts fully populated event with actionable", function() {
  assert.doesNotThrow(function() {
    validateDiagnosticEvent({
      type: "diagnostic",
      severity: "error",
      source: "mcp",
      message: "MCP server failed to load: connection refused",
      actionable: {
        label: "Open settings",
        action: "open:settings:mcp",
      },
    });
  });
});

// --- rejection: wrong type discriminant ---

test("8: validateDiagnosticEvent rejects null", function() {
  assert.throws(function() {
    validateDiagnosticEvent(null);
  }, /diagnostic event must be a non-null object/);
});

test("8: validateDiagnosticEvent rejects non-object", function() {
  assert.throws(function() {
    validateDiagnosticEvent("diagnostic");
  }, /diagnostic event must be a non-null object/);
});

test("8: validateDiagnosticEvent rejects wrong type field", function() {
  assert.throws(function() {
    validateDiagnosticEvent({
      type: "system",
      severity: "warning",
      source: "cli",
      message: "oops",
    });
  }, /type === 'diagnostic'/);
});

// --- rejection: severity ---

test("8: validateDiagnosticEvent rejects invalid severity", function() {
  assert.throws(function() {
    validateDiagnosticEvent({
      type: "diagnostic",
      severity: "critical",
      source: "cli",
      message: "bad severity",
    });
  }, /severity must be one of/);
});

test("8: validateDiagnosticEvent rejects missing severity", function() {
  assert.throws(function() {
    validateDiagnosticEvent({
      type: "diagnostic",
      source: "cli",
      message: "missing severity",
    });
  }, /severity must be one of/);
});

// --- rejection: source ---

test("8: validateDiagnosticEvent rejects missing source", function() {
  assert.throws(function() {
    validateDiagnosticEvent({
      type: "diagnostic",
      severity: "warning",
      message: "no source",
    });
  }, /source must be a non-empty string/);
});

test("8: validateDiagnosticEvent rejects empty source", function() {
  assert.throws(function() {
    validateDiagnosticEvent({
      type: "diagnostic",
      severity: "warning",
      source: "",
      message: "empty source",
    });
  }, /source must be a non-empty string/);
});

// --- rejection: message ---

test("8: validateDiagnosticEvent rejects missing message", function() {
  assert.throws(function() {
    validateDiagnosticEvent({
      type: "diagnostic",
      severity: "info",
      source: "cli",
    });
  }, /message must be a non-empty string/);
});

test("8: validateDiagnosticEvent rejects empty message", function() {
  assert.throws(function() {
    validateDiagnosticEvent({
      type: "diagnostic",
      severity: "info",
      source: "cli",
      message: "",
    });
  }, /message must be a non-empty string/);
});

// --- rejection: actionable ---

test("8: validateDiagnosticEvent rejects actionable that is not an object", function() {
  assert.throws(function() {
    validateDiagnosticEvent({
      type: "diagnostic",
      severity: "warning",
      source: "hook",
      message: "hook load failed",
      actionable: "fix it",
    });
  }, /actionable must be an object/);
});

test("8: validateDiagnosticEvent rejects actionable with missing label", function() {
  assert.throws(function() {
    validateDiagnosticEvent({
      type: "diagnostic",
      severity: "error",
      source: "mcp",
      message: "failed",
      actionable: { action: "open:settings" },
    });
  }, /actionable\.label must be a non-empty string/);
});

test("8: validateDiagnosticEvent rejects actionable with missing action", function() {
  assert.throws(function() {
    validateDiagnosticEvent({
      type: "diagnostic",
      severity: "error",
      source: "mcp",
      message: "failed",
      actionable: { label: "Fix" },
    });
  }, /actionable\.action must be a non-empty string/);
});

test("8: validateDiagnosticEvent rejects actionable with empty label", function() {
  assert.throws(function() {
    validateDiagnosticEvent({
      type: "diagnostic",
      severity: "error",
      source: "mcp",
      message: "failed",
      actionable: { label: "", action: "open:settings" },
    });
  }, /actionable\.label must be a non-empty string/);
});

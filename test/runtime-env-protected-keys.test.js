"use strict";
// Settings may not set or override the variables that decide who a runtime is,
// what it loads, or what a shell, interpreter or tool runs on its own. Each
// class is held at both gates: refused when saved, dropped when built. The
// names below are the specification, spelled out here and not read back from
// lib/runtime-env-keys.js, so a name quietly removed from the list fails.

var test = require("node:test");
var assert = require("node:assert/strict");
var runtimeEnv = require("../lib/runtime-env");
var keys = require("../lib/runtime-env-keys");

var SPEC = {
  identity: ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR"],
  loader: ["LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH"],
  node: ["NODE_OPTIONS", "NODE_PATH"],
  console: ["CLAGENTIC_CONSOLE_HOME", "CLAGENTIC_CONSOLE_DEBUG", "CLAGENTIC_HOME", "CLAGENTIC_LITE_HOME", "CLAY_HOME", "CLAY_PORT", "CLAY_AUTH_TOKEN"],
  "shell-startup": ["BASH_ENV", "ENV", "PROMPT_COMMAND", "PS4", "SHELLOPTS", "BASHOPTS"],
  interpreter: ["PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME", "PERL5OPT", "PERL5LIB", "PERLLIB", "RUBYOPT", "RUBYLIB"],
  git: [
    "GIT_SSH", "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_EDITOR", "GIT_ASKPASS", "GIT_EXEC_PATH",
    "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
  ],
  "tool-launcher": ["PAGER", "EDITOR", "VISUAL", "SSH_ASKPASS", "SUDO_ASKPASS"],
  "process-wrapper": ["CLAUDE_CODE_PROCESS_WRAPPER", "CLAUDE_CODE_PATH"],
  reserved: ["__proto__"],
};

// Names that merely look like a protected one, which Settings exist to set.
var ALLOWED = [
  "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
  "AWS_REGION", "HOME_ASSISTANT_URL", "PATH_EXTRA", "MYPATH", "USERNAME_HINT", "ENVIRONMENT", "LDAP_URL", "DYLDX",
  "GIT_AUTHOR_NAME", "GIT_COMMITTER_EMAIL", "NODE_ENV", "NODE_TLS_REJECT_UNAUTHORIZED", "PYTHONUNBUFFERED",
  "CLAYTON", "CLAGENTICS", "EDITOR_THEME", "SHELLY",
];

function capture() {
  var lines = [];
  return { warn: function (line) { lines.push(line); }, lines: lines, warned: new Set() };
}

Object.keys(SPEC).forEach(function (cls) {
  SPEC[cls].forEach(function (name) {
    test("protected (" + cls + "): " + name + " is classified", function () {
      var found = keys.protectedClassOf(name);
      assert.ok(found, name + " must be protected");
      assert.equal(found.name, cls);
      assert.equal(keys.isProtectedKey(name), true);
    });
  });

  test("protected (" + cls + "): saving a text that sets any of them is refused with a message naming the variable", function () {
    SPEC[cls].forEach(function (name) {
      var message = runtimeEnv.validateEnvText("OK_ONE=1\nexport " + name + "=x\nOK_TWO=2");
      assert.ok(message, name + " must be refused");
      assert.ok(message.indexOf(name) !== -1, "the message names " + name + ": " + message);
      assert.match(message, /cannot be set here/);
      assert.match(message, /line 2/i);
    });
  });

  test("protected (" + cls + "): a text saved earlier that sets any of them is dropped at build time, once, without its value", function () {
    var sink = capture();
    var text = SPEC[cls].map(function (name) { return name + "=secret-" + name; }).join("\n") + "\nKEEP_ME=kept";
    var overlay = runtimeEnv.buildRuntimeEnvOverlay([{ label: "shared", text: text }], sink);
    assert.deepEqual(overlay, { KEEP_ME: "kept" });

    // Built a second time (the next session): no second warning.
    runtimeEnv.buildRuntimeEnvOverlay([{ label: "shared", text: text }], sink);
    assert.equal(sink.lines.length, SPEC[cls].length, "one warning per variable");
    sink.lines.forEach(function (line) {
      assert.ok(line.indexOf("secret-") === -1, "a warning never carries a value: " + line);
    });
  });

  test("protected (" + cls + "): an overlay handed to a runtime cannot override them either", function () {
    var sink = capture();
    var base = { PATH: "/usr/bin", HOME: "/home/alice" };
    var overlay = {};
    // defineProperty makes an OWN key of every name, "__proto__" included:
    // plain assignment of it would run the prototype setter and leave the
    // overlay with no such key, so the gate would never be exercised.
    SPEC[cls].forEach(function (name) {
      Object.defineProperty(overlay, name, { value: "attacker", enumerable: true, configurable: true, writable: true });
    });
    SPEC[cls].forEach(function (name) {
      assert.ok(Object.prototype.hasOwnProperty.call(overlay, name) && Object.keys(overlay).indexOf(name) !== -1,
        name + " is an own key of the overlay");
    });
    var env = runtimeEnv.composeRuntimeEnv(base, overlay, sink);
    SPEC[cls].forEach(function (name) {
      assert.notEqual(env[name], "attacker", name + " must not take the overlay's value");
      // The gate is what dropped it, not a no-op assignment: it reported the name.
      assert.ok(sink.lines.some(function (line) { return line.indexOf(name) !== -1; }), name + " was dropped by the gate");
    });
    assert.equal(Object.getPrototypeOf(env), Object.prototype, "the environment object itself is untouched");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/home/alice");
  });
});

test("names are compared without regard to case", function () {
  ["path", "Home", "bash_env", "ld_preload", "Git_Config_Count", "clagentic_console_home", "clay_port", "__PROTO__"].forEach(function (name) {
    assert.ok(runtimeEnv.validateEnvText(name + "=x"), name + " must be refused");
  });
});

test("names that only look like a protected one can be set", function () {
  ALLOWED.forEach(function (name) {
    assert.equal(runtimeEnv.validateEnvText("export " + name + "=value"), null, name + " must be accepted");
    assert.equal(keys.isProtectedKey(name), false);
  });
});

test("a protected name is refused in the form the Settings pages write, and in a quoted value's neighbour lines", function () {
  assert.match(runtimeEnv.validateEnvText("export PATH=/tmp/evil"), /PATH cannot be set here/);
  assert.match(runtimeEnv.validateEnvText("# note\n\nexport A=\"x y\"\nexport NODE_OPTIONS=--require=/tmp/x.js"), /line 4/i);
});

test("a protected name never reaches the environment, whatever the layer order", function () {
  var sink = capture();
  var overlay = runtimeEnv.buildRuntimeEnvOverlay([
    { label: "shared", text: "BASH_ENV=/tmp/shared.sh\nA=1" },
    { label: "project alpha", text: "BASH_ENV=/tmp/project.sh\nB=2" },
  ], sink);
  assert.deepEqual(overlay, { A: "1", B: "2" });
  assert.equal(sink.lines.length, 2, "reported once per layer");
  assert.ok(sink.lines[0].indexOf("shared") !== -1);
  assert.ok(sink.lines[1].indexOf("project alpha") !== -1);
});

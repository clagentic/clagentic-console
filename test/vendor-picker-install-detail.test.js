"use strict";
// What the agent picker shows for an agent whose probe reports more than
// installed or not: the binary and version that will run, or why the agent is
// disabled (not installed, too old, an override that points nowhere).

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var { pathToFileURL } = require("url");
var fakeDom = require("./fake-dom-prompt-cards");

var PUBLIC = path.join(__dirname, "..", "lib", "public");

async function load() {
  fakeDom.setupGlobals();
  var VR = await import(pathToFileURL(path.join(PUBLIC, "modules", "vendor-registry.js")).href);
  var picker = await import(pathToFileURL(path.join(PUBLIC, "modules", "vendor-picker.js")).href);
  return { VR: VR, picker: picker };
}

var HINT = "Install the Codex CLI (npm install -g @openai/codex), then sign in.";

test("a usable Codex shows its version beside the name and its path and version in the title", async function () {
  var { VR, picker } = await load();
  var rows = VR.pickerRows([
    { id: "codex", displayName: "Codex", installed: true, installHint: HINT, installDetail: { path: "/usr/local/bin/codex", version: "0.162.1", source: "path", reason: null } },
  ], "codex");
  assert.equal(rows[0].version, "0.162.1");
  assert.equal(rows[0].title, "Codex 0.162.1 (/usr/local/bin/codex)");

  var container = new fakeDom.FakeElement("div");
  picker.renderVendorPicker(container, rows, { onSelect: function () {}, onRecheck: function () {} });
  var button = container.querySelector('[data-vendor="codex"]');
  assert.equal(button.querySelector(".vendor-toggle-note").textContent, "0.162.1");
});

test("a Codex that is too old is disabled with the stated reason, not the install hint", async function () {
  var { VR } = await load();
  var rows = VR.pickerRows([
    { id: "codex", displayName: "Codex", installed: false, probeFailure: null, installHint: HINT,
      installDetail: { path: "/usr/bin/codex", version: "0.147.9", source: "path", reason: "Codex 0.147.9 is too old; Clagentic: Console needs 0.148.0 or newer" } },
  ], "claude");
  assert.equal(rows[0].installed, false);
  assert.equal(rows[0].version, "");
  assert.equal(rows[0].title, "Codex. Codex 0.147.9 is too old; Clagentic: Console needs 0.148.0 or newer");
});

test("an override that points nowhere is named in the title; a missing Codex gets the install reason", async function () {
  var { VR } = await load();
  var rows = VR.pickerRows([
    { id: "codex", displayName: "Codex", installed: false, installHint: HINT,
      installDetail: { path: "/opt/none", version: null, source: "override", reason: "CLAGENTIC_CONSOLE_CODEX_PATH is set to /opt/none, but no executable file is there" } },
    { id: "codex", displayName: "Codex", installed: false, installHint: HINT,
      installDetail: { path: null, version: null, source: null, reason: "Codex is not installed. Install it with: npm install -g @openai/codex, then use Re-check." } },
  ], "claude");
  assert.match(rows[0].title, /CLAGENTIC_CONSOLE_CODEX_PATH is set to \/opt\/none/);
  assert.match(rows[1].title, /Codex is not installed\. Install it with: npm install -g @openai\/codex/);
});

test("a disabled control shows the agent's own reason when it has one, else the ledger's", async function () {
  var { VR } = await load();
  var { store } = await import(pathToFileURL(path.join(PUBLIC, "modules", "store.js")).href);
  var rewindOff = { rewind: false, fork: true };
  VR.applyVendorRegistry({
    vendors: [
      { id: "codex", displayName: "Codex", installed: true, capabilities: rewindOff, capabilityReasons: { rewind: "Rewind is not available for Codex sessions yet" } },
      { id: "other", displayName: "Other", installed: true, capabilities: rewindOff, capabilityReasons: {} },
    ],
    reasons: { rewind: "This agent cannot rewind file changes to an earlier message." },
  });
  store.set({ currentVendor: "codex" });
  var own = VR.capabilityGate("rewind");
  assert.equal(own.enabled, false);
  assert.equal(own.reason, "Rewind is not available for Codex sessions yet");
  assert.match(VR.gatedButtonAttrs("rewind", "Rewind"), /Rewind is not available for Codex sessions yet/);
  assert.equal(VR.capabilityGate("fork").enabled, true);

  store.set({ currentVendor: "other" });
  assert.equal(VR.capabilityGate("rewind").reason, "This agent cannot rewind file changes to an earlier message.");
});

test("an agent with no install detail is shown exactly as before", async function () {
  var { VR } = await load();
  var rows = VR.pickerRows([
    { id: "claude", displayName: "Claude Code", installed: true, installHint: "x" },
    { id: "other", displayName: "Other", installed: false, installHint: "Install other." },
  ], "claude");
  assert.equal(rows[0].title, "Claude Code");
  assert.equal(rows[0].version, "");
  assert.equal(rows[1].title, "Other is not installed. Install other.");
});

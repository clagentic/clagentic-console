"use strict";
// The mode picker offers Don't ask and Auto only for a session whose vendor
// declares them (capabilities.permissionModes), and the server refuses the
// two for a session that does not: a Codex session must never be handed a
// Claude Code mode.

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var { pathToFileURL } = require("url");
var world = require("./prompt-harness-world");
var { claudeCapabilities } = require("../lib/yoke/adapters/claude-capabilities");

function modeOptionsModule() {
  return import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "mode-options.js")).href);
}

function values(options) { return options.map(function (o) { return o.value; }); }

test("the picker offers the three base modes always, and Don't ask and Auto only when the vendor declares them", async function () {
  var { modeOptions } = await modeOptionsModule();
  var BASE = ["default", "plan", "acceptEdits"];

  assert.deepEqual(values(modeOptions(undefined, false)), BASE, "no capabilities known");
  assert.deepEqual(values(modeOptions({}, false)), BASE, "a vendor that declares none (Codex)");
  assert.deepEqual(values(modeOptions({ rewind: false, permissionModes: "auto" }, false)), BASE, "a malformed declaration offers nothing extra");
  assert.deepEqual(values(modeOptions({ permissionModes: ["default", "auto"] }, false)), BASE.concat("auto"), "only what is declared");
  assert.deepEqual(values(modeOptions(claudeCapabilities(), false)), BASE.concat(["dontAsk", "auto"]));
  assert.deepEqual(values(modeOptions(claudeCapabilities(), true)), BASE.concat(["dontAsk", "auto", "bypassPermissions"]), "Full auto stays last, when the daemon allows it");
  assert.deepEqual(values(modeOptions({}, true)), BASE.concat("bypassPermissions"));

  var labels = {};
  modeOptions(claudeCapabilities(), true).forEach(function (o) { labels[o.value] = o.label; });
  assert.equal(labels.dontAsk, "Don’t ask (deny)");
  assert.equal(labels.auto, "Auto (model decides)");
  assert.equal(labels.bypassPermissions, "Full auto");
});

test("each mode value has one pinned label and hint", async function () {
  var { modeOptions } = await modeOptionsModule();
  var pinned = {
    default: ["Default", "Asks before each action that needs permission."],
    plan: ["Plan", "Plans only and makes no changes until you approve the plan."],
    acceptEdits: ["Accept edits", "Approves file edits automatically and asks for everything else."],
    dontAsk: ["Don’t ask (deny)", "Never asks. Denies any action that is not already approved."],
    auto: ["Auto (model decides)", "A model approves or denies each action and asks you only when it cannot decide."],
    bypassPermissions: ["Full auto", "Skips permission checks and approves every action."],
  };
  var options = modeOptions(claudeCapabilities(), true);
  assert.deepEqual(values(options), Object.keys(pinned));
  options.forEach(function (o) {
    assert.deepEqual([o.label, o.hint], pinned[o.value], o.value);
  });
  var labels = options.map(function (o) { return o.label; });
  assert.equal(new Set(labels).size, labels.length, "no two modes share a label");
});

test("a Claude session declares every mode the picker can offer", function () {
  var caps = claudeCapabilities();
  assert.deepEqual(caps.permissionModes, ["default", "plan", "acceptEdits", "dontAsk", "auto"]);
  caps.permissionModes.push("mutated");
  assert.equal(claudeCapabilities().permissionModes.length, 5, "each call gets its own list");
});

var client = world.client;
var withServer = world.withServer;

test("set_permission_mode: auto and dontAsk reach a session whose vendor declares them, and only that session", async function () {
  await withServer(async function (server) {
    var c = client();
    server.connect(c.ws);
    var applied = [];
    server.session.queryInstance.setPermissionMode = function (mode) { applied.push(mode); return Promise.resolve(); };

    // Capabilities are recorded per vendor; Claude's are known, Codex's are not.
    server.sm.capabilitiesByVendor = { claude: claudeCapabilities() };

    ["auto", "dontAsk"].forEach(function (mode) {
      server.session.vendor = "claude";
      server.handlers.handleSessionsMessage(c.ws, { type: "set_permission_mode", mode: mode });
    });
    await world.flush();
    assert.deepEqual(applied, ["auto", "dontAsk"]);
    assert.equal(server.session.permissionMode, "dontAsk");

    applied.length = 0;
    c.inbox.length = 0;
    server.session.vendor = "codex";
    server.session.permissionMode = "default";
    ["auto", "dontAsk"].forEach(function (mode) {
      server.handlers.handleSessionsMessage(c.ws, { type: "set_permission_mode", mode: mode });
    });
    await world.flush();
    assert.deepEqual(applied, [], "a Codex session is never handed a Claude Code mode");
    assert.equal(server.session.permissionMode, "default");
    assert.equal(c.inbox.filter(function (m) { return m.type === "error"; }).length, 2, "and the requester is told");
    var states = c.inbox.filter(function (m) { return m.type === "config_state"; });
    assert.equal(states[states.length - 1].mode, "default", "its picker is put back");

    // The modes every vendor has are not gated.
    ["plan", "acceptEdits", "default"].forEach(function (mode) {
      server.handlers.handleSessionsMessage(c.ws, { type: "set_permission_mode", mode: mode });
    });
    await world.flush();
    assert.deepEqual(applied, ["plan", "acceptEdits", "default"]);
  });
});

test("set_permission_mode: with no capabilities known, auto and dontAsk are refused rather than guessed", async function () {
  await withServer(async function (server) {
    var c = client();
    server.connect(c.ws);
    var applied = [];
    server.session.queryInstance.setPermissionMode = function (mode) { applied.push(mode); return Promise.resolve(); };
    server.sm.capabilitiesByVendor = null;
    ["auto", "dontAsk"].forEach(function (mode) {
      server.handlers.handleSessionsMessage(c.ws, { type: "set_permission_mode", mode: mode });
    });
    await world.flush();
    assert.deepEqual(applied, []);
  });
});

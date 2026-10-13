"use strict";
// Reading Codex versions and deciding, from the version that is running, which
// protocol fields and config keys the console may send. Every case here is a
// caller shape from the support matrix: 0.148.x-0.150.x (no turn trigger), a
// release with turn triggers, one with the plan tool, and the current one.

var test = require("node:test");
var assert = require("node:assert/strict");

var versions = require("../lib/yoke/codex-version");
var protocol = require("../lib/yoke/codex-protocol");
var { INITIATORS } = require("../lib/turn-initiator");
var { serializeConfig } = require("../lib/yoke/codex-app-server");
var { getCodexConfig, CODEX_DEFAULTS } = require("../lib/codex-defaults");

test("a version is read from a binary's version line, defensively", function () {
  assert.equal(versions.parseVersion("codex-cli 0.162.1\n").text, "0.162.1");
  assert.equal(versions.parseVersion("0.148.0").text, "0.148.0");
  assert.equal(versions.parseVersion("codex 0.163.0-alpha.2 (abc123)").text, "0.163.0-alpha.2");
  assert.equal(versions.parseVersion(""), null);
  assert.equal(versions.parseVersion("no digits here"), null);
  assert.equal(versions.parseVersion(null), null);
  assert.equal(versions.parseVersion({ text: "0.1.2" }), null);
  assert.equal(versions.parseVersion("9".repeat(5000) + " 0.1.2"), null, "an absurd line is not read");
});

test("a token with junk before or after the numbers is not a version, and an unreadable version is not compatible", function () {
  assert.equal(versions.parseVersion("abc0.150.0"), null);
  assert.equal(versions.parseVersion("0.150.0abc"), null);
  assert.equal(versions.parseVersion("x1.2.3.4y"), null);
  assert.equal(versions.parseVersion("junk0.162.1 and more"), null);
  assert.equal(versions.parseVersion("codex-cli v0.162.1").text, "0.162.1");
  assert.equal(versions.atLeast(versions.parseVersion("abc0.162.1"), versions.MIN_CODEX_VERSION), false, "fails closed");
  assert.equal(versions.atLeast("0.162.1abc", versions.MIN_CODEX_VERSION), false);
});

test("a version is read from the app-server userAgent without taking a digit of the originator for it", function () {
  assert.equal(versions.versionFromUserAgent("clagentic-console/0.162.1 (Ubuntu 24.4.0; x86_64) xterm").text, "0.162.1");
  assert.equal(versions.versionFromUserAgent("tool-2.3.4/0.150.0 (Linux)").text, "0.150.0");
  assert.equal(versions.versionFromUserAgent("no-slash 0.1.2"), null);
  assert.equal(versions.versionFromUserAgent(undefined), null);
  assert.equal(versions.versionFromUserAgent(42), null);
});

test("versions compare as semver, a prerelease below its release", function () {
  assert.equal(versions.compareVersions("0.148.0", "0.148.0"), 0);
  assert.equal(versions.compareVersions("0.147.9", "0.148.0"), -1);
  assert.equal(versions.compareVersions("0.162.1", "0.148.0"), 1);
  assert.equal(versions.compareVersions("0.10.0", "0.9.9"), 1, "numeric, not textual");
  assert.equal(versions.compareVersions("0.148.0-alpha.3", "0.148.0"), -1);
  assert.equal(versions.compareVersions("0.148.0-alpha.10", "0.148.0-alpha.9"), 1);
  assert.throws(function () { versions.compareVersions("garbage", "0.148.0"); }, /unreadable/);
  assert.equal(versions.atLeast("garbage", "0.148.0"), false);
  assert.equal(versions.atLeast("0.148.0", versions.MIN_CODEX_VERSION), true);
  assert.equal(versions.MIN_CODEX_VERSION, "0.148.0");
});

test("protocol features follow the running version, one threshold each", function () {
  var f = protocol.protocolFeatures;
  assert.deepEqual(f("0.148.0"), { projectTrustGate: false, turnTrigger: false, updatePlanTool: false });
  assert.deepEqual(f("0.150.2"), { projectTrustGate: true, turnTrigger: false, updatePlanTool: false });
  assert.deepEqual(f("0.151.0"), { projectTrustGate: true, turnTrigger: true, updatePlanTool: false });
  assert.deepEqual(f("0.152.0"), { projectTrustGate: true, turnTrigger: true, updatePlanTool: true });
  assert.deepEqual(f("0.162.1"), { projectTrustGate: true, turnTrigger: true, updatePlanTool: true });
  assert.equal(f("0.151.0-alpha.1").turnTrigger, false, "a prerelease of 0.151.0 is not yet 0.151.0");
  assert.deepEqual(f(null), f("0.148.0"), "an unknown version is taken to be the oldest supported one");
  assert.deepEqual(f("not a version"), f("0.148.0"));
  assert.deepEqual(f(versions.parseVersion("0.162.1")), f("0.162.1"), "a parsed version works as well");
});

test("a turn trigger is set for every turn a person did not type, and for none that they did", function () {
  assert.equal(protocol.turnTriggerFor(INITIATORS.HUMAN), null);
  assert.equal(protocol.turnTriggerFor(undefined), null, "a turn that names no initiator carries none");
  assert.equal(protocol.turnTriggerFor("nonsense"), null);
  [INITIATORS.SCHEDULED, INITIATORS.SCHEDULED_NOW, INITIATORS.LOOP, INITIATORS.TRIGGER].forEach(function (initiator) {
    assert.equal(protocol.turnTriggerFor(initiator), "automation_heartbeat_scheduled", initiator);
  });
});

test("an approval policy is sent as a value the running app-server accepts", function () {
  assert.equal(protocol.normalizeApprovalPolicy("on-failure"), "on-request", "an alias is sent as what it means");
  assert.equal(protocol.normalizeApprovalPolicy("on-request"), "on-request");
  assert.equal(protocol.normalizeApprovalPolicy("never"), "never");
  assert.equal(protocol.normalizeApprovalPolicy("untrusted"), "untrusted");
  assert.equal(protocol.normalizeApprovalPolicy(undefined), "on-request");
  assert.equal(protocol.normalizeApprovalPolicy("run-everything"), "on-request", "an unknown value asks rather than running unattended");
});

test("the console's approval default and the saved setting go through the same normalization", function () {
  assert.equal(CODEX_DEFAULTS.approval, "on-request");
  assert.equal(getCodexConfig(null).approval, "on-request");
  assert.equal(getCodexConfig({ codexApproval: "on-failure" }).approval, "on-request", "a saved on-failure is read as on-request");
  assert.equal(getCodexConfig({ codexApproval: "never" }).approval, "never");
});

test("session config carries the plan tool and the project trust only where the version has them", function () {
  var opts = { projectDir: "/work/proj.one", trustProject: true };
  assert.deepEqual(protocol.sessionConfig(protocol.protocolFeatures("0.148.0"), opts), {});
  assert.deepEqual(protocol.sessionConfig(protocol.protocolFeatures("0.150.0"), opts), { projects: { "/work/proj.one": { trust_level: "trusted" } } });
  assert.deepEqual(protocol.sessionConfig(protocol.protocolFeatures("0.151.0"), opts), { projects: { "/work/proj.one": { trust_level: "trusted" } } });
  assert.deepEqual(protocol.sessionConfig(protocol.protocolFeatures("0.152.0"), opts), {
    tools: { update_plan: { enabled: true } },
    projects: { "/work/proj.one": { trust_level: "trusted" } },
  });
  assert.deepEqual(protocol.sessionConfig(protocol.protocolFeatures("0.162.1"), { projectDir: "/p", trustProject: false }), {
    tools: { update_plan: { enabled: true } },
  }, "trusting the project can be turned off");
  assert.deepEqual(protocol.sessionConfig(protocol.protocolFeatures("0.162.1"), { projectDir: null, trustProject: true }), {
    tools: { update_plan: { enabled: true } },
  }, "no project, nothing to trust");
});

test("a project path in the config is one quoted key, not a dotted path", function () {
  var flags = serializeConfig({
    tools: { update_plan: { enabled: true } },
    projects: { "/work/proj.one/my dir": { trust_level: "trusted" } },
    mcp_servers: { "clay-tools": { command: "node", args: ["a.js"] } },
  }, "");
  assert.deepEqual(flags, [
    "tools.update_plan.enabled=true",
    "projects.\"/work/proj.one/my dir\".trust_level=\"trusted\"",
    "mcp_servers.clay-tools.command=\"node\"",
    "mcp_servers.clay-tools.args=[\"a.js\"]",
  ]);
});

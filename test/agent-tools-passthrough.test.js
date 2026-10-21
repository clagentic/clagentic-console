"use strict";
// A session for a named agent hands the SDK `tools` option (the CLI's --tools)
// the agent definition's own tools list; a session with no list, and a plain
// session, leave the option unset. The Claude Agent SDK is a stand-in that
// records the options it was called with.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var nodeModule = require("node:module");
var { pathToFileURL } = require("url");

nodeModule.register(pathToFileURL(path.join(__dirname, "fixtures", "fake-agent-sdk", "resolve-hook.mjs")).href);

var claudeModule = require("../lib/yoke/adapters/claude");
var agents = require("../lib/agents");

var ROOT = path.join(__dirname, "..");

function lastFakeQuery() {
  var queries = globalThis.__fakeAgentSdkQueries || [];
  return queries[queries.length - 1];
}

function withAgentsDir(files, run) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-console-agent-tools-"));
  try {
    Object.keys(files).forEach(function (slug) {
      fs.writeFileSync(path.join(dir, slug + ".md"), files[slug]);
    });
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function definition(toolsLine) {
  return ["---", "name: lane", "description: a lane", toolsLine, "---", "body", ""].filter(function (l) { return l !== null; }).join("\n");
}

// What the bridge does for a session that carries an agent name.
function launchToolsFor(agentsDir, agentName) {
  return agents.toLaunchToolList(agents.readAgentToolsFromFile(agentName, agentsDir));
}

// --- the helper ---

test("toLaunchToolList keeps names and MCP names in definition order and drops duplicates", function () {
  assert.deepEqual(
    agents.toLaunchToolList(["Read", "Grep", "Glob", "mcp__srv__lookup", "Read"]),
    ["Read", "Grep", "Glob", "mcp__srv__lookup"]);
});

test("toLaunchToolList reduces a permission pattern to its tool name", function () {
  assert.deepEqual(
    agents.toLaunchToolList(["Agent(helper)", "Bash(cmd:*)", "Bash(other *)", "Read"]),
    ["Agent", "Bash", "Read"]);
});

test("toLaunchToolList returns null when there is nothing to pass", function () {
  assert.equal(agents.toLaunchToolList(null), null);
  assert.equal(agents.toLaunchToolList(undefined), null);
  assert.equal(agents.toLaunchToolList("Read"), null);
  assert.equal(agents.toLaunchToolList([]), null);
  assert.equal(agents.toLaunchToolList(["", "(x)", 7, null]), null);
});

// --- definition to SDK options, in process ---

test("a definition listing Read, Grep, Glob and an MCP tool reaches the SDK as its tools option", async function () {
  var tools = withAgentsDir({
    lane: definition('tools: ["Read", "Grep", "Glob", "mcp__srv__lookup"]'),
  }, function (dir) { return launchToolsFor(dir, "lane"); });

  var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var handle = await adapter.createQuery({ cwd: os.tmpdir(), adapterOptions: { CLAUDE: { agent: "lane", tools: tools } } });
  assert.deepEqual(lastFakeQuery().options.tools, ["Read", "Grep", "Glob", "mcp__srv__lookup"]);
  assert.equal(lastFakeQuery().options.agent, "lane");
  handle.close();
});

test("a definition with permission patterns reaches the SDK with the tool names, none dropped", async function () {
  var tools = withAgentsDir({
    lane: definition('tools: ["Read", "Agent(helper)", "Bash(cmd:*)", "mcp__srv__lookup"]'),
  }, function (dir) { return launchToolsFor(dir, "lane"); });

  var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var handle = await adapter.createQuery({ cwd: os.tmpdir(), adapterOptions: { CLAUDE: { agent: "lane", tools: tools } } });
  assert.deepEqual(lastFakeQuery().options.tools, ["Read", "Agent", "Bash", "mcp__srv__lookup"]);
  handle.close();
});

test("a definition with no tools field leaves the tools option unset", async function () {
  var tools = withAgentsDir({ lane: definition(null) }, function (dir) { return launchToolsFor(dir, "lane"); });
  assert.equal(tools, null);

  var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var handle = await adapter.createQuery({ cwd: os.tmpdir(), adapterOptions: { CLAUDE: { agent: "lane" } } });
  assert.equal("tools" in lastFakeQuery().options, false);
  handle.close();
});

test("a plain session leaves the tools option unset", async function () {
  var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var handle = await adapter.createQuery({ cwd: os.tmpdir() });
  assert.equal("tools" in lastFakeQuery().options, false);
  handle.close();
  var withOptions = await adapter.createQuery({ cwd: os.tmpdir(), adapterOptions: { CLAUDE: { settingSources: ["user"] } } });
  assert.equal("tools" in lastFakeQuery().options, false);
  withOptions.close();
});

test("an empty or malformed tools value is never passed on", async function () {
  var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var values = [[], [""], "Read", null, { type: "preset", preset: "claude_code" }];
  for (var i = 0; i < values.length; i++) {
    var handle = await adapter.createQuery({ cwd: os.tmpdir(), adapterOptions: { CLAUDE: { tools: values[i] } } });
    assert.equal("tools" in lastFakeQuery().options, false, "value " + JSON.stringify(values[i]));
    handle.close();
  }
});

// --- definition to the worker message (OS-user sessions) ---

function fakeWorker() {
  var sent = [];
  return {
    sent: sent,
    ready: true,
    process: { killed: false, pid: 4242 },
    messageHandlers: [],
    exitPromise: Promise.resolve(),
    send: function (msg) { sent.push(msg); },
    onMessage: function (handler) { this.messageHandlers.push(handler); },
  };
}

test("an OS-user session sends the agent's tools list to the worker", async function () {
  var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var worker = fakeWorker();
  await adapter.createQuery({
    cwd: os.tmpdir(),
    adapterOptions: { CLAUDE: { linuxUser: "alice", _workerState: { worker: worker }, tools: ["Read", "Grep", "Glob"] } },
  });
  var start = worker.sent.find(function (m) { return m.type === "query_start"; });
  assert.deepEqual(start.options.tools, ["Read", "Grep", "Glob"]);
});

test("an OS-user session with no tools list sends none", async function () {
  var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var worker = fakeWorker();
  await adapter.createQuery({
    cwd: os.tmpdir(),
    adapterOptions: { CLAUDE: { linuxUser: "alice", _workerState: { worker: worker } } },
  });
  var start = worker.sent.find(function (m) { return m.type === "query_start"; });
  assert.equal("tools" in start.options, false);
});

// --- the launch code names no tool ---

test("the launch code carries no hard-coded tool-name list", function () {
  var files = ["lib/sdk-bridge.js", "lib/agents.js", "lib/yoke/adapters/claude.js", "lib/yoke/adapters/claude-worker.js"];
  var listOfNames = /\[\s*["'](Read|Write|Edit|Bash|Grep|Glob|Agent|WebFetch|WebSearch)["']\s*[,\]]/;
  files.forEach(function (file) {
    var source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.equal(listOfNames.test(source), false, file + " must not hold a literal list of tool names");
  });
});

test("the bridge takes the tools list from the agent definition and the Codex adapter never sees it", function () {
  var bridge = fs.readFileSync(path.join(ROOT, "lib/sdk-bridge.js"), "utf8");
  assert.match(bridge, /claudeOpts\.tools = agentTools/);
  assert.match(bridge, /toLaunchToolList\(readAgentToolsFromFile\(/);
  var codex = fs.readFileSync(path.join(ROOT, "lib/yoke/adapters/codex.js"), "utf8");
  assert.equal(/CLAUDE/.test(codex.replace(/\/\/.*$/gm, "")), false, "the Codex adapter reads no Claude adapter options");
});

/**
 * The claude CLI names the sub-agent dispatch tool "Agent"; older builds named
 * it "Task". Background-agent tracking keyed on "Task" alone never fired on the
 * live CLI, which left the reap and shed notices, the restart marker, prompt
 * ownership and the build-update interrupt list inert.
 *
 * The records below are copied verbatim from a live capture (console session
 * history, tool_start / tool_executing / task_started / prompt_request),
 * recorded in the task thread. Only the sub-agent Write call is rebuilt from
 * the captured prompt_request fields.
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var { pathToFileURL } = require("node:url");

var { attachMessageProcessor } = require("../lib/sdk-message-processor");
var { promptsFor } = require("../lib/prompt-registry");
var sessionReclaim = require("../lib/session-reclaim");
var backend = require("../lib/agent-dispatch-tool");

var CAPTURED_TOOL_START = {"type":"tool_start","id":"toolu_01Bs8dtwZsfL53nTWLNYrxuS","name":"Agent","_ts":1791980481515};
var CAPTURED_TOOL_EXECUTING = {"type":"tool_executing","id":"toolu_01Bs8dtwZsfL53nTWLNYrxuS","name":"Agent","input":{"description":"lr-8f12ca R1 probe","subagent_type":"general-purpose","run_in_background":true,"prompt":"Step 1: run the Bash command: timeout 90 tail -f /dev/null (exit code 124 is expected). Step 2: then use the Write tool (not Bash) to create the file /var/tmp/lr-8f12ca-r1-probe-20261014a with the content r1-probe. If the write is denied, report that and stop. Do nothing else."},"_ts":1791980482829};
var CAPTURED_TASK_STARTED = {"type":"task_started","parentToolId":"toolu_01Bs8dtwZsfL53nTWLNYrxuS","taskId":"a06e38de689e9b83d","description":"lr-8f12ca R1 probe","_ts":1791980483116};
var CAPTURED_PROMPT_REQUEST = {"type":"prompt_request","requestId":"af5ddffd-a4c1-413d-bc97-ae9cb5e1a564","kind":"permission","toolUseId":"toolu_01JYujTsyFaip1usJauviNrV","toolName":"Write","toolInput":{"file_path":"/var/tmp/lr-8f12ca-r1-probe-20261014a","content":"r1-probe"},"decisionReason":"Requested by background agent \"background agent\". Path is outside allowed working directories","vendor":"claude","_ts":1791980579258};

var DESCRIPTION = CAPTURED_TOOL_EXECUTING.input.description;
var AGENT_ID = CAPTURED_TOOL_START.id;

function makeSm() {
  return {
    skillMeta: [], workflowMeta: [], skillNames: [], slashCommands: null,
    currentModel: null, _savedDefaultModel: null,
    sendAndRecord: function (session, obj) { (session.history = session.history || []).push(obj); },
    sendToSession: function () {},
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    modelsByVendor: {}, availableModels: [], availableVendors: [], installedVendors: [],
  };
}

function makeProcessor(sm) {
  return attachMessageProcessor({
    sm: sm, send: function () {}, slug: "test-slug", cwd: "/tmp", pushModule: null,
    getNotificationsModule: function () { return null; },
    adapter: { vendor: "claude" },
    onProcessingChanged: function () {}, onTurnDone: null, onAutoTitle: null, opts: {},
    discoverSkillDirs: function () { return []; }, mergeSkills: function () { return []; },
    discoverWorkflows: function () { return []; },
    discoverSkillsWithMeta: function () { return []; }, mergeSkillsWithMeta: function () { return []; },
    getSDK: null,
  });
}

function makeSession() {
  return {
    localId: "s1", cliSessionId: null, vendor: "claude", history: [], messageUUIDs: [],
    blocks: {}, sentToolResults: {}, pendingPermissions: {}, pendingElicitations: {},
    pendingAskUser: {}, activeTaskToolIds: {}, taskIdMap: {}, streamedText: false,
    responsePreview: "", isProcessing: true, loop: null,
  };
}

// Replays the captured tool_start + tool_executing the way the stream delivers
// them: a tool_start, the input as a delta, then block_stop.
function dispatch(processor, session, startRec, executingRec, blockId) {
  processor.processSDKMessage(session, {
    yokeType: "tool_start", blockId: blockId, toolId: startRec.id, toolName: startRec.name,
  });
  processor.processSDKMessage(session, {
    yokeType: "tool_input_delta", blockId: blockId, partialJson: JSON.stringify(executingRec.input),
  });
  processor.processSDKMessage(session, { yokeType: "block_stop", blockId: blockId });
}

test("captured Agent dispatch is tracked and labelled with its description", function () {
  var session = makeSession();
  var processor = makeProcessor(makeSm());
  dispatch(processor, session, CAPTURED_TOOL_START, CAPTURED_TOOL_EXECUTING, 0);

  assert.ok(session.activeTaskToolIds[AGENT_ID], "Agent tool_use must be tracked as a live background agent");
  assert.deepEqual(sessionReclaim.liveAgentLabels(session), [DESCRIPTION]);
});

test("the subagent permission prompt carries the description and survives the parent turn end", function () {
  var sm = makeSm();
  var session = makeSession();
  var processor = makeProcessor(sm);
  dispatch(processor, session, CAPTURED_TOOL_START, CAPTURED_TOOL_EXECUTING, 0);

  processor.processSDKMessage(session, {
    yokeType: "subagent_message", parentToolUseId: AGENT_ID, messageRole: "assistant",
    content: [{ type: "tool_use", id: CAPTURED_PROMPT_REQUEST.toolUseId, name: CAPTURED_PROMPT_REQUEST.toolName, input: CAPTURED_PROMPT_REQUEST.toolInput }],
  });

  var label = sessionReclaim.ownerLabelOfTool(session, promptsFor(sm), CAPTURED_PROMPT_REQUEST.toolUseId);
  assert.equal(label, DESCRIPTION, "the capture showed the generic label here");
  assert.notEqual(label, "background agent");

  var resolved = null;
  session.pendingPermissions[CAPTURED_PROMPT_REQUEST.requestId] = {
    resolve: function (r) { resolved = r; },
    requestId: CAPTURED_PROMPT_REQUEST.requestId,
    toolName: CAPTURED_PROMPT_REQUEST.toolName,
    toolInput: CAPTURED_PROMPT_REQUEST.toolInput,
    toolUseId: CAPTURED_PROMPT_REQUEST.toolUseId,
    decisionReason: "",
  };
  processor.processSDKMessage(session, { yokeType: "result", cost: 0, duration: 1, sessionId: "cli-1" });

  assert.ok(session.pendingPermissions[CAPTURED_PROMPT_REQUEST.requestId], "prompt must not be cancelled at turn end");
  assert.equal(resolved, null);
  assert.equal(
    session.history.filter(function (e) { return e.type === "prompt_cancel"; }).length, 0,
    "no turn_ended cancellation is sent for the sub-agent's prompt"
  );
});

test("the interrupt list and the reap notice name the Agent dispatch", function () {
  var sm = makeSm();
  var session = makeSession();
  var processor = makeProcessor(sm);
  dispatch(processor, session, CAPTURED_TOOL_START, CAPTURED_TOOL_EXECUTING, 0);

  assert.deepEqual(sessionReclaim.liveAgentTasks(session), [{ id: AGENT_ID, label: DESCRIPTION }]);

  var sent = [];
  var result = sessionReclaim.announceLiveAgentReclaim({
    session: session, sm: sm, send: function (m) { sent.push(m); },
    slug: "s", reason: "idle_reap", source: "idle-reaper", cause: "Idle.",
  });
  assert.deepEqual(result.labels, [DESCRIPTION]);
  assert.ok(sent[0].message.indexOf('"' + DESCRIPTION + '"') !== -1, "the notice names the agent by its description");
  assert.equal(session.pendingAutoResume, true);
});

test("the Task name still works", function () {
  var session = makeSession();
  var processor = makeProcessor(makeSm());
  var legacyStart = Object.assign({}, CAPTURED_TOOL_START, { name: "Task" });
  var legacyExec = Object.assign({}, CAPTURED_TOOL_EXECUTING, { name: "Task" });
  dispatch(processor, session, legacyStart, legacyExec, 0);

  assert.ok(session.activeTaskToolIds[AGENT_ID]);
  assert.deepEqual(sessionReclaim.liveAgentLabels(session), [DESCRIPTION]);
});

test("a non-dispatch tool is not tracked", function () {
  var session = makeSession();
  var processor = makeProcessor(makeSm());
  var bash = { id: "toolu_bash", name: "Bash" };
  dispatch(processor, session, bash, { input: { command: "true" } }, 0);
  assert.deepEqual(session.activeTaskToolIds, {});
});

test("the backend and frontend helpers accept the same name set", async function () {
  var front = await import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "agent-dispatch-tool.js")).href);
  assert.deepEqual(front.AGENT_DISPATCH_TOOL_NAMES.slice().sort(), ["Agent", "Task"]);
  assert.deepEqual(backend.AGENT_DISPATCH_TOOL_NAMES.slice().sort(), ["Agent", "Task"]);
  ["Task", "Agent", "Bash", "task", "agent", "", null, undefined, 7].forEach(function (n) {
    assert.equal(front.isAgentDispatchTool(n), backend.isAgentDispatchTool(n), "disagree on " + String(n));
  });
});

test("no lib file compares a tool name to the bare Task or Agent literal outside the helpers", function () {
  var fs = require("node:fs");
  var root = path.join(__dirname, "..", "lib");
  var offenders = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      var p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      if (!/\.js$/.test(e.name) || e.name === "agent-dispatch-tool.js") return;
      fs.readFileSync(p, "utf8").split("\n").forEach(function (line, i) {
        if (/(?:[Nn]ame|toolName)\s*===?\s*["'](Task|Agent)["']/.test(line)) offenders.push(path.relative(root, p) + ":" + (i + 1));
      });
    });
  })(root);
  assert.deepEqual(offenders, []);
});

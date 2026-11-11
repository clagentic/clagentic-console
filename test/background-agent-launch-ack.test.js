/**
 * A run_in_background Agent call is answered at once with an "Async agent
 * launched" tool_result. That result is the launch, not the end: the agent
 * keeps running, and its tracking, its activity token and any prompt it opens
 * must outlive the parent's turn until its own terminal task_notification (or
 * the query ending).
 *
 * The records below are copied verbatim from the console history of a live
 * session (lines 9, 12 and 40: task_started, the launch tool_result and the
 * sub-agent's prompt_request). The SDK user message that carried the launch is
 * rebuilt from the persisted transcript line, whose toolUseResult is the
 * structured output the SDK attaches as tool_use_result.
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var { attachMessageProcessor } = require("../lib/sdk-message-processor");
var { promptsFor } = require("../lib/prompt-registry");
var sessionReclaim = require("../lib/session-reclaim");
var sessionActivity = require("../lib/session-activity");
var { _test_flattenEvent: flatten } = require("../lib/yoke/adapters/claude");

var CAPTURED_TASK_STARTED = {"type":"task_started","parentToolId":"toolu_01QB6TW5akhBjoiH2V4dwEEm","taskId":"a6514d6aa9c32754d","description":"Write probe file","_ts":1793831322955};
var CAPTURED_LAUNCH_RESULT = {"type":"tool_result","id":"toolu_01QB6TW5akhBjoiH2V4dwEEm","content":"Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: a6514d6aa9c32754d (internal ID - do not mention to user. Use SendMessage with to: 'a6514d6aa9c32754d', summary: '<5-10 word recap>' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.\nDo not duplicate this agent's work — avoid working with the same files or topics it is using.\noutput_file: /tmp/claude-0/-workspace-clagentic-console/bc74390e-6d85-424d-a30c-29d05ba0800b/tasks/a6514d6aa9c32754d.output\nDo NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you'll get a completion notification.","is_error":false,"_ts":1793831323757};
var CAPTURED_PROMPT_REQUEST = {"type":"prompt_request","requestId":"2eb72df9-1551-43ac-8b84-8fc078e15b21","kind":"permission","toolUseId":"toolu_01QGg5bUhLGKk5YaH9GNdwzX","label":{"project":"Clagentic: Console","session":"Probe lr-8f12ca R1 retry","agent":"background agent"},"toolName":"Write","toolInput":{"file_path":"/var/tmp/probe-8f12ca-r1b.txt","content":"probe"},"decisionReason":"Requested by background agent \"background agent\". Path is outside allowed working directories","vendor":"claude","_ts":1793831329094};
var CAPTURED_TOOL_USE_RESULT = {"isAsync":true,"status":"async_launched","agentId":"a6514d6aa9c32754d","description":"Write probe file","resolvedModel":"claude-sonnet-5-5","prompt":"Use the Write tool once to create /var/tmp/probe-8f12ca-r1b.txt containing the word probe, then stop.","outputFile":"/tmp/claude-0/-workspace-clagentic-console/bc74390e-6d85-424d-a30c-29d05ba0800b/tasks/a6514d6aa9c32754d.output","canReadOutputFile":true,"canContinueAgent":true};

var AGENT_ID = CAPTURED_TASK_STARTED.parentToolId;
var DESCRIPTION = CAPTURED_TASK_STARTED.description;
var DISPATCH_INPUT = { description: DESCRIPTION, subagent_type: "general-purpose", run_in_background: true, prompt: CAPTURED_TOOL_USE_RESULT.prompt };

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

function rig() {
  var sm = makeSm();
  return { sm: sm, session: makeSession(), processor: makeProcessor(sm) };
}

function dispatch(r, toolId, input, blockId) {
  r.processor.processSDKMessage(r.session, { yokeType: "tool_start", blockId: blockId, toolId: toolId, toolName: "Agent" });
  r.processor.processSDKMessage(r.session, { yokeType: "tool_input_delta", blockId: blockId, partialJson: JSON.stringify(input) });
  r.processor.processSDKMessage(r.session, { yokeType: "block_stop", blockId: blockId });
}

function started(r, toolId, taskId, description) {
  r.processor.processSDKMessage(r.session, { yokeType: "task_started", parentToolId: toolId, taskId: taskId, description: description });
}

// The user message the SDK delivers for a tool result, run through the same
// flattening the adapter applies to every live message.
function toolResultMessage(toolId, content, toolUseResult) {
  var raw = {
    type: "user", uuid: "49e6a889-f88d-4850-bbbf-dba27c522672", parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: content, is_error: false }] },
  };
  if (toolUseResult) raw.tool_use_result = toolUseResult;
  return flatten(raw);
}

function launchAck(r, toolId) {
  r.processor.processSDKMessage(r.session, toolResultMessage(toolId, CAPTURED_LAUNCH_RESULT.content, CAPTURED_TOOL_USE_RESULT));
}

function result(r) {
  r.processor.processSDKMessage(r.session, { yokeType: "result", cost: 0, duration: 1, sessionId: "cli-1" });
}

function notify(r, toolId, taskId, status) {
  r.processor.processSDKMessage(r.session, { yokeType: "task_notification", parentToolId: toolId, taskId: taskId, status: status, summary: "" });
}

function subagentTool(r, ownerId, toolId, name, input) {
  r.processor.processSDKMessage(r.session, {
    yokeType: "subagent_message", parentToolUseId: ownerId, messageRole: "assistant",
    content: [{ type: "tool_use", id: toolId, name: name, input: input }],
  });
}

function openPrompt(r, toolId) {
  var settled = { value: null };
  r.session.pendingPermissions[CAPTURED_PROMPT_REQUEST.requestId] = {
    resolve: function (v) { settled.value = v; },
    requestId: CAPTURED_PROMPT_REQUEST.requestId,
    toolName: CAPTURED_PROMPT_REQUEST.toolName,
    toolInput: CAPTURED_PROMPT_REQUEST.toolInput,
    toolUseId: toolId,
    decisionReason: "",
  };
  return settled;
}

function count(r, type) {
  return r.session.history.filter(function (e) { return e.type === type; }).length;
}

function tokenLive(r, id) {
  return sessionActivity.listActiveSources(r.session).some(function (s) { return s.token === id; });
}

function launched() {
  var r = rig();
  dispatch(r, AGENT_ID, DISPATCH_INPUT, 0);
  started(r, AGENT_ID, CAPTURED_TASK_STARTED.taskId, DESCRIPTION);
  launchAck(r, AGENT_ID);
  return r;
}

test("the adapter marks the launch acknowledgement from the structured tool output, not from text", function () {
  var ack = toolResultMessage(AGENT_ID, CAPTURED_LAUNCH_RESULT.content, CAPTURED_TOOL_USE_RESULT);
  assert.deepEqual(ack.asyncLaunch, { agentId: "a6514d6aa9c32754d" });

  var textOnly = toolResultMessage(AGENT_ID, CAPTURED_LAUNCH_RESULT.content, null);
  assert.equal(textOnly.asyncLaunch, undefined, "the result text alone is never a launch");

  var completed = toolResultMessage(AGENT_ID, "done", { status: "completed", agentId: "a6514d6aa9c32754d" });
  assert.equal(completed.asyncLaunch, undefined);
});

test("the launch acknowledgement keeps the agent tracked and its token held", function () {
  var r = launched();
  assert.ok(r.session.activeTaskToolIds[AGENT_ID], "still tracked after the ack");
  assert.ok(tokenLive(r, AGENT_ID), "activity token still held");
  assert.equal(count(r, "subagent_done"), 0, "the agent is not reported done at launch");
  assert.equal(count(r, "tool_result"), 1, "the tool result itself still reaches the chat");
  assert.deepEqual(sessionReclaim.liveAgentLabels(r.session), [DESCRIPTION]);
});

test("captured sequence: a prompt the background agent opens survives the parent's turn end", function () {
  var r = launched();
  subagentTool(r, AGENT_ID, CAPTURED_PROMPT_REQUEST.toolUseId, CAPTURED_PROMPT_REQUEST.toolName, CAPTURED_PROMPT_REQUEST.toolInput);
  var settled = openPrompt(r, CAPTURED_PROMPT_REQUEST.toolUseId);
  result(r);

  assert.ok(r.session.pendingPermissions[CAPTURED_PROMPT_REQUEST.requestId], "prompt not cancelled at turn end");
  assert.equal(settled.value, null);
  assert.equal(count(r, "prompt_cancel"), 0);
});

test("a prompt opened after the parent's turn ended survives the next turn end too", function () {
  var r = launched();
  result(r);
  assert.ok(r.session.activeTaskToolIds[AGENT_ID], "tracked across the parent's result");

  subagentTool(r, AGENT_ID, CAPTURED_PROMPT_REQUEST.toolUseId, CAPTURED_PROMPT_REQUEST.toolName, CAPTURED_PROMPT_REQUEST.toolInput);
  openPrompt(r, CAPTURED_PROMPT_REQUEST.toolUseId);
  result(r);

  assert.ok(r.session.pendingPermissions[CAPTURED_PROMPT_REQUEST.requestId]);
  assert.equal(count(r, "prompt_cancel"), 0);
});

test("a reap announcement names the background agent after its launch", function () {
  var r = launched();
  result(r);
  var announced = [];
  var out = sessionReclaim.announceLiveAgentReclaim({
    session: r.session, sm: { saveSessionFile: function () {}, sendAndRecord: function (s, m) { announced.push(m); } },
    send: null, slug: "test-slug", reason: "idle_reap", source: "idle-reap", cause: "Clagentic: Console ended this session.",
  });
  assert.deepEqual(out.labels, [DESCRIPTION]);
  assert.match(announced[0].text, new RegExp(DESCRIPTION));
});

test("a terminal notification ends tracking, releases the token and lets the session go idle", function () {
  var r = launched();
  result(r);
  assert.equal(r.session.isProcessing, true, "busy only through the agent");

  notify(r, AGENT_ID, CAPTURED_TASK_STARTED.taskId, "completed");
  assert.equal(r.session.activeTaskToolIds[AGENT_ID], undefined);
  assert.equal(tokenLive(r, AGENT_ID), false);
  assert.equal(count(r, "subagent_done"), 1);
  assert.equal(promptsFor(r.sm).pendingCount(r.session), 0);
  assert.deepEqual(sessionReclaim.liveAgentLabels(r.session), []);

  result(r);
  assert.equal(r.session.isProcessing, false, "nothing holds the session after the notification");
});

test("a failed or stopped background agent ends tracking the same way", function () {
  ["failed", "stopped"].forEach(function (status) {
    var r = launched();
    result(r);
    notify(r, AGENT_ID, CAPTURED_TASK_STARTED.taskId, status);
    assert.equal(r.session.activeTaskToolIds[AGENT_ID], undefined, status);
    assert.equal(tokenLive(r, AGENT_ID), false, status);
    assert.equal(count(r, "subagent_done"), 1, status);
    assert.equal(r.session.backgroundTaskIds[AGENT_ID], undefined, status);
  });
});

test("a terminal notification while the agent's prompt is open keeps the prompt answerable", function () {
  var r = launched();
  subagentTool(r, AGENT_ID, CAPTURED_PROMPT_REQUEST.toolUseId, CAPTURED_PROMPT_REQUEST.toolName, CAPTURED_PROMPT_REQUEST.toolInput);
  openPrompt(r, CAPTURED_PROMPT_REQUEST.toolUseId);
  notify(r, AGENT_ID, CAPTURED_TASK_STARTED.taskId, "completed");
  result(r);
  assert.ok(r.session.pendingPermissions[CAPTURED_PROMPT_REQUEST.requestId]);
});

test("several background agents are tracked independently", function () {
  var r = rig();
  var second = "toolu_second_agent";
  dispatch(r, AGENT_ID, DISPATCH_INPUT, 0);
  started(r, AGENT_ID, CAPTURED_TASK_STARTED.taskId, DESCRIPTION);
  launchAck(r, AGENT_ID);
  dispatch(r, second, { description: "Second probe", run_in_background: true }, 1);
  started(r, second, "task-two", "Second probe");
  r.processor.processSDKMessage(r.session, toolResultMessage(second, "launched", { status: "async_launched", agentId: "task-two" }));
  result(r);

  assert.deepEqual(sessionReclaim.liveAgentLabels(r.session).sort(), [DESCRIPTION, "Second probe"].sort());

  notify(r, AGENT_ID, CAPTURED_TASK_STARTED.taskId, "completed");
  assert.ok(r.session.activeTaskToolIds[second], "the other agent is still tracked");
  assert.ok(tokenLive(r, second));
  assert.equal(tokenLive(r, AGENT_ID), false);
  assert.equal(r.session.isProcessing, true, "the remaining agent still holds the session");
});

test("a foreground Agent's synchronous result still ends it", function () {
  var r = rig();
  dispatch(r, AGENT_ID, { description: DESCRIPTION, subagent_type: "general-purpose" }, 0);
  started(r, AGENT_ID, CAPTURED_TASK_STARTED.taskId, DESCRIPTION);
  r.processor.processSDKMessage(r.session, toolResultMessage(AGENT_ID, "final report", { status: "completed", agentId: CAPTURED_TASK_STARTED.taskId }));

  assert.equal(r.session.activeTaskToolIds[AGENT_ID], undefined);
  assert.equal(tokenLive(r, AGENT_ID), false);
  assert.equal(count(r, "subagent_done"), 1);
});

test("a launch acknowledgement naming another agent is not taken for this one's", function () {
  var r = rig();
  dispatch(r, AGENT_ID, DISPATCH_INPUT, 0);
  started(r, AGENT_ID, CAPTURED_TASK_STARTED.taskId, DESCRIPTION);
  r.processor.processSDKMessage(r.session, toolResultMessage(AGENT_ID, "x", { status: "async_launched", agentId: "someone-else" }));
  assert.equal(r.session.activeTaskToolIds[AGENT_ID], undefined);
});

test("the query ending releases a launched agent's token, and keeps one that owns an open prompt", function () {
  var r = launched();
  result(r);
  var query = {};
  promptsFor(r.sm).endQuery(r.session, query, true);
  r.processor.releaseTurnActivity(r.session);
  assert.equal(r.session.activeTaskToolIds[AGENT_ID], undefined, "tracking ends with the query");
  assert.equal(tokenLive(r, AGENT_ID), false, "no token is held for ever");
  assert.equal(sessionActivity.isSessionActive(r.session), false);

  var kept = launched();
  subagentTool(kept, AGENT_ID, CAPTURED_PROMPT_REQUEST.toolUseId, CAPTURED_PROMPT_REQUEST.toolName, CAPTURED_PROMPT_REQUEST.toolInput);
  openPrompt(kept, CAPTURED_PROMPT_REQUEST.toolUseId);
  promptsFor(kept.sm).endQuery(kept.session, query, true);
  kept.processor.releaseTurnActivity(kept.session);
  assert.ok(kept.session.activeTaskToolIds[AGENT_ID], "the agent whose prompt is open stays tracked");
  assert.ok(tokenLive(kept, AGENT_ID));
});

test("an interrupted turn drops a launched agent's token with the generation", function () {
  var r = launched();
  sessionActivity.bumpGeneration(r.session);
  assert.equal(sessionActivity.isSessionActive(r.session), false);
  promptsFor(r.sm).endQuery(r.session, {}, true);
  assert.equal(r.session.activeTaskToolIds[AGENT_ID], undefined);
});

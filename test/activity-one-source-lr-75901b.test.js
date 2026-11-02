"use strict";

// The confirm card for a build-update restart named idle sessions as "running
// a turn". Every surface reads the same session.isProcessing flag (the card
// directly, the pickers/sidebar/home hub through the session_list wire field),
// so they agree with each other; the flag itself was wrong. At a turn's
// 'result' event it was re-derived from the activity registry, and a tool call
// that never got its tool_result (a denied or interrupted call in a query that
// stays open across turns) held a current-generation token that nothing
// released, so the flag stayed true on an idle session until the next query.

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var { pathToFileURL } = require("url");

var { attachMessageProcessor } = require("../lib/sdk-message-processor");
var offer = require("../lib/build-update-offer");
var sessionActivity = require("../lib/session-activity");

function makeSm() {
  return {
    skillMeta: [], workflowMeta: [], skillNames: [], slashCommands: null,
    currentModel: null, _savedDefaultModel: null,
    sendAndRecord: function (session, obj) { session.history.push(obj); },
    sendToSession: function () {},
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    modelsByVendor: {}, availableModels: [], availableVendors: [], installedVendors: [],
  };
}

function makeProcessor(sm) {
  return attachMessageProcessor({
    sm: sm, send: function () {}, slug: "proj", cwd: "/tmp", pushModule: null,
    getNotificationsModule: function () { return null; },
    adapter: { vendor: "claude" }, onProcessingChanged: function () {},
    onTurnDone: null, onAutoTitle: null, opts: {},
    discoverSkillDirs: function () { return []; }, mergeSkills: function () { return []; },
    discoverWorkflows: function () { return []; }, discoverSkillsWithMeta: function () { return []; },
    mergeSkillsWithMeta: function () { return []; }, getSDK: null,
  });
}

function makeSession(localId) {
  return {
    localId: localId, cliSessionId: null, vendor: "claude", title: "Session " + localId,
    history: [], messageUUIDs: [], blocks: {}, sentToolResults: {},
    pendingPermissions: {}, pendingElicitations: {}, pendingAskUser: {},
    activeTaskToolIds: {}, taskIdMap: {}, streamedText: false, responsePreview: "",
    isProcessing: true, queryInstance: {}, loop: null, ownerId: null, unread: 0,
  };
}

function toolUse(processor, session, blockId, toolId, name) {
  processor.processSDKMessage(session, { yokeType: "tool_start", blockId: blockId, toolId: toolId, toolName: name });
  processor.processSDKMessage(session, { yokeType: "block_stop", blockId: blockId });
}

function result(processor, session) {
  processor.processSDKMessage(session, { yokeType: "result", cost: 0.1, duration: 10, sessionId: "cli-1" });
}

// What every client receives for the session: the session_list item shape.
function wireItem(session) {
  return { id: session.localId, isProcessing: session.isProcessing, unread: 0, ownerId: session.ownerId };
}

async function clientState(session) {
  var mod = await import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "activity-state.js")).href);
  return mod.sessionActivity(wireItem(session), null);
}

function cardState(session) {
  var found = offer.collectInterruptions([{ slug: "proj", sm: { sessions: new Map([[session.localId, session]]) } }]);
  return found.sessions[0].processing;
}

test("idle after its turn ended: card, picker and sidebar all show idle even with an unreleased tool token", async function () {
  var sm = makeSm();
  var processor = makeProcessor(sm);
  var session = makeSession("idle1");

  toolUse(processor, session, 0, "toolu_never_answered", "Bash");
  // No tool_result for it; the turn ends.
  result(processor, session);

  assert.equal(session.isProcessing, false, "the flag must be false once the turn ended");
  assert.equal(sessionActivity.isSessionActive(session), false, "the registry holds nothing for an idle session");
  assert.equal(cardState(session), false, "confirm card must call it idle");
  assert.equal((await clientState(session)).active, false, "pickers and sidebar must show it idle");
  assert.match(offer.describeInterruptions(offer.collectInterruptions([{ slug: "proj", sm: { sessions: new Map([[1, session]]) } }])), /\(idle\)/);
});

test("mid-turn: card, picker and sidebar all show running", async function () {
  var sm = makeSm();
  var processor = makeProcessor(sm);
  var session = makeSession("busy1");

  toolUse(processor, session, 0, "toolu_in_flight", "Bash");

  assert.equal(session.isProcessing, true);
  assert.equal(cardState(session), true, "confirm card must call it running a turn");
  assert.equal((await clientState(session)).active, true, "pickers and sidebar must show it running");
});

test("a tracked background agent still holds the session active across the turn's result", async function () {
  var sm = makeSm();
  var processor = makeProcessor(sm);
  var session = makeSession("agent1");

  toolUse(processor, session, 0, "toolu_agent", "Task");
  toolUse(processor, session, 1, "toolu_stray", "Bash");
  result(processor, session);

  assert.ok(session.activeTaskToolIds.toolu_agent, "the agent is still tracked");
  assert.equal(session.isProcessing, true, "a live agent keeps the session running");
  assert.equal(cardState(session), true);
  assert.equal((await clientState(session)).active, true);
  var held = sessionActivity.listActiveSources(session).map(function (s) { return s.token; });
  assert.deepEqual(held, ["toolu_agent"], "only the agent's token survives; the stray tool's does not");
});

test("a result with an error still leaves an idle session idle", function () {
  var sm = makeSm();
  var processor = makeProcessor(sm);
  var session = makeSession("err1");

  toolUse(processor, session, 0, "toolu_err", "Read");
  processor.processSDKMessage(session, { yokeType: "result", subtype: "error_during_execution", errors: ["x"], cost: 0 });

  assert.equal(session.isProcessing, false);
});

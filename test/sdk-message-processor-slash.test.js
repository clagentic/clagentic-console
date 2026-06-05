/**
 * Regression tests for lr-1c7f: enriched slash_commands WS message schema.
 *
 * The init handler in sdk-message-processor.js must produce {name,desc,type}[]
 * from three sources: skillMeta (highest priority), workflowMeta, and CLI-emitted
 * names (lowest priority, typed as 'builtin'). Covers:
 *
 *   (1) skillMeta entry wins — desc and type:'skill' forwarded
 *   (2) workflowMeta entry wins over CLI name-only — desc and type:'workflow' forwarded
 *   (3) CLI-emitted name not in skillMeta or workflowMeta → type:'builtin', desc:''
 *   (4) Deduplication: skillMeta entry blocks same name from workflowMeta and CLI
 *   (5) workflowMeta entry blocks same name from CLI-emitted
 *   (6) Empty inputs produce empty combined array
 *   (7) CLI string[] input (legacy format) still handled without throwing
 *   (8) sm.slashCommands is updated to the enriched array on init
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var { attachMessageProcessor } = require("../lib/sdk-message-processor");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock context for attachMessageProcessor.
 *
 * opts.skillMeta    — {name,description,type}[] returned by mergeSkillsWithMeta
 * opts.workflowMeta — {name,description,type}[] returned by discoverWorkflows
 *
 * Both are injected as ctx functions so the init handler's own discovery calls
 * use the test data instead of the real filesystem.
 *
 * Returns { processor, sm, sent }.
 */
function makeCtx(opts) {
  opts = opts || {};
  var skillMeta = opts.skillMeta || [];
  var workflowMeta = opts.workflowMeta || [];
  var sent = [];
  var sm = {
    skillMeta: [],
    workflowMeta: [],
    skillNames: [],
    slashCommands: null,
    currentModel: null,
    _savedDefaultModel: null,
    sendAndRecord: function () {},
    sendToSession: function () {},
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    modelsByVendor: {},
    availableModels: [],
    availableVendors: [],
    installedVendors: [],
  };

  var processor = attachMessageProcessor({
    sm: sm,
    send: function (obj) { sent.push(obj); },
    slug: "test-slug",
    cwd: "/tmp",
    pushModule: null,
    getNotificationsModule: function () { return null; },
    adapter: { vendor: "claude" },
    onProcessingChanged: function () {},
    onTurnDone: null,
    onAutoTitle: null,
    opts: {},
    discoverSkillDirs: function () { return []; },
    mergeSkills: function () { return []; },
    // Inject test skill/workflow data via ctx functions so init handler uses them.
    discoverWorkflows: function () { return workflowMeta; },
    discoverSkillsWithMeta: function () { return []; },
    mergeSkillsWithMeta: function () { return skillMeta; },
    getSDK: null,
  });

  return { processor: processor, sm: sm, sent: sent };
}

/** Build a minimal session object. */
function makeSession() {
  return {
    localId: "s1",
    cliSessionId: null,
    vendor: "claude",
    history: [],
    messageUUIDs: [],
    blocks: {},
    sentToolResults: {},
    pendingPermissions: {},
    pendingElicitations: {},
    pendingAskUser: {},
    activeTaskToolIds: {},
    taskIdMap: {},
    streamedText: false,
    responsePreview: "",
    isProcessing: false,
    loop: null,
  };
}

/** Extract the slash_commands message from a sent array. */
function getSlashMsg(sent) {
  return sent.find(function (m) { return m.type === "slash_commands"; }) || null;
}

/** Fire a parsed init event through the processor. */
function fireInit(processor, session, parsed) {
  processor.processSDKMessage(session, Object.assign({
    yokeType: "init",
    skills: [],
    slashCommands: [],
    model: null,
    fastModeState: null,
    sessionId: null,
    uuid: null,
  }, parsed));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("(1) skillMeta entry: desc and type:skill are forwarded", function () {
  var ctx = makeCtx({
    skillMeta: [{ name: "my-skill", description: "Does magic", type: "skill" }],
    workflowMeta: [],
  });
  var session = makeSession();
  fireInit(ctx.processor, session, { slashCommands: ["my-skill"] });

  var msg = getSlashMsg(ctx.sent);
  assert.ok(msg, "slash_commands message must be sent");
  assert.equal(msg.commands.length, 1);
  assert.equal(msg.commands[0].name, "my-skill");
  assert.equal(msg.commands[0].desc, "Does magic");
  assert.equal(msg.commands[0].type, "skill");
});

test("(2) workflowMeta entry: desc and type:workflow forwarded for CLI-emitted name", function () {
  var ctx = makeCtx({
    skillMeta: [],
    workflowMeta: [{ name: "my-workflow", description: "Runs phases", type: "workflow" }],
  });
  var session = makeSession();
  fireInit(ctx.processor, session, { slashCommands: ["my-workflow"] });

  var msg = getSlashMsg(ctx.sent);
  assert.ok(msg, "slash_commands message must be sent");
  assert.equal(msg.commands.length, 1);
  assert.equal(msg.commands[0].name, "my-workflow");
  assert.equal(msg.commands[0].desc, "Runs phases");
  assert.equal(msg.commands[0].type, "workflow");
});

test("(3) CLI-emitted name not in skillMeta or workflowMeta → type:builtin, desc:''", function () {
  var ctx = makeCtx({ skillMeta: [], workflowMeta: [] });
  var session = makeSession();
  fireInit(ctx.processor, session, { slashCommands: ["some-builtin"] });

  var msg = getSlashMsg(ctx.sent);
  assert.ok(msg);
  assert.equal(msg.commands.length, 1);
  assert.equal(msg.commands[0].name, "some-builtin");
  assert.equal(msg.commands[0].desc, "");
  assert.equal(msg.commands[0].type, "builtin");
});

test("(4) Deduplication: skillMeta entry blocks same name from workflowMeta and CLI", function () {
  var ctx = makeCtx({
    skillMeta: [{ name: "shared", description: "From skill", type: "skill" }],
    workflowMeta: [{ name: "shared", description: "From workflow", type: "workflow" }],
  });
  var session = makeSession();
  fireInit(ctx.processor, session, { slashCommands: ["shared"] });

  var msg = getSlashMsg(ctx.sent);
  assert.ok(msg);
  // Must appear exactly once, with skill priority
  assert.equal(msg.commands.length, 1);
  assert.equal(msg.commands[0].name, "shared");
  assert.equal(msg.commands[0].type, "skill");
  assert.equal(msg.commands[0].desc, "From skill");
});

test("(5) workflowMeta entry blocks same name from CLI-emitted", function () {
  var ctx = makeCtx({
    skillMeta: [],
    workflowMeta: [{ name: "shared", description: "Workflow desc", type: "workflow" }],
  });
  var session = makeSession();
  fireInit(ctx.processor, session, { slashCommands: ["shared", "other"] });

  var msg = getSlashMsg(ctx.sent);
  assert.ok(msg);
  // shared appears once (from workflowMeta), other appears as builtin
  assert.equal(msg.commands.length, 2);
  var byName = {};
  msg.commands.forEach(function (c) { byName[c.name] = c; });
  assert.equal(byName.shared.type, "workflow");
  assert.equal(byName.shared.desc, "Workflow desc");
  assert.equal(byName.other.type, "builtin");
  assert.equal(byName.other.desc, "");
});

test("(6) Empty inputs produce empty combined array", function () {
  var ctx = makeCtx({ skillMeta: [], workflowMeta: [] });
  var session = makeSession();
  fireInit(ctx.processor, session, { slashCommands: [] });

  var msg = getSlashMsg(ctx.sent);
  assert.ok(msg);
  assert.deepEqual(msg.commands, []);
});

test("(7) CLI string[] input (legacy) is handled without throwing", function () {
  var ctx = makeCtx({ skillMeta: [], workflowMeta: [] });
  var session = makeSession();
  // slashCommands as plain strings — the legacy server format
  assert.doesNotThrow(function () {
    fireInit(ctx.processor, session, { slashCommands: ["a", "b"] });
  });
  var msg = getSlashMsg(ctx.sent);
  assert.ok(msg);
  assert.equal(msg.commands.length, 2);
  msg.commands.forEach(function (c) {
    assert.ok(typeof c.name === "string");
    assert.ok(typeof c.desc === "string");
    assert.ok(typeof c.type === "string");
  });
});

test("(8) sm.slashCommands is updated to the enriched array after init", function () {
  var ctx = makeCtx({
    skillMeta: [{ name: "sk", description: "A skill", type: "skill" }],
    workflowMeta: [],
  });
  var session = makeSession();
  fireInit(ctx.processor, session, { slashCommands: ["sk", "cli-only"] });

  // sm.slashCommands should now hold enriched objects, not strings
  var cmds = ctx.sm.slashCommands;
  assert.ok(Array.isArray(cmds));
  assert.equal(cmds.length, 2);
  cmds.forEach(function (c) {
    assert.ok(typeof c.name === "string", "name must be string");
    assert.ok(typeof c.desc === "string", "desc must be string");
    assert.ok(typeof c.type === "string", "type must be string");
  });
  var byName = {};
  cmds.forEach(function (c) { byName[c.name] = c; });
  assert.equal(byName.sk.type, "skill");
  assert.equal(byName["cli-only"].type, "builtin");
});

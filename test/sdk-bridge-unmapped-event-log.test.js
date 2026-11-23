// The processQueryStream received-event log line names the raw discriminator of
// every Claude event the adapter passes through unmapped, never a body value.
// Events are produced by the real claude adapter flattenEvent from raw
// SDK-shaped messages and flow through the real processQueryStream.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var flattenEvent = require("../lib/yoke/adapters/claude")._test_flattenEvent;

var PREFIX = "[sdk-bridge] processQueryStream: received event yokeType=";

function makeHandle(events) {
  var i = 0;
  return {
    _adapterState: null,
    [Symbol.asyncIterator]: function () {
      return {
        next: function () {
          if (i < events.length) return Promise.resolve({ value: events[i++], done: false });
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
    pushMessage: function () {},
    close: function () {},
    endInput: function () {},
    abort: function () {},
  };
}

function makeSessionManager() {
  return {
    sessions: new Map(),
    currentModel: null,
    currentPermissionMode: null,
    currentEffort: null,
    currentBetas: [],
    modelsByVendor: {},
    availableVendors: [],
    installedVendors: [],
    defaultVendor: "claude",
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    getActiveSession: function () { return null; },
    setSlashCommandsForVendor: function () {},
    sendAndRecord: function (session, obj) { if (!session.history) session.history = []; session.history.push(obj); },
    sendToSession: function () {},
  };
}

var _seq = 9000;
function makeSession() {
  return {
    localId: _seq++,
    queryInstance: null,
    messageQueue: null,
    abortController: null,
    isProcessing: true,
    cliSessionId: null,
    history: [],
    blocks: {},
    sentToolResults: {},
    pendingPermissions: {},
    pendingAskUser: {},
    pendingElicitations: {},
    activeTaskToolIds: {},
    singleTurn: false,
    lastActivityAt: Date.now(),
    _isCountedLive: false,
    _adapterWorkerState: null,
    _workerExitPromise: null,
  };
}

// Runs one raw message through flattenEvent and processQueryStream; returns the
// received-event log lines.
async function receivedLines(raw) {
  var modPath = require.resolve("../lib/sdk-bridge");
  delete require.cache[modPath];
  var { createSDKBridge } = require("../lib/sdk-bridge");
  var handle = makeHandle([flattenEvent(raw)]);
  var adapter = {
    vendor: "claude",
    createQuery: function () { return Promise.resolve(handle); },
    init: function () { return Promise.resolve({ models: [], skills: [] }); },
    supportedModels: function () { return Promise.resolve([]); },
    generateTitle: null,
    renameSession: null,
    forkSession: null,
  };
  var sm = makeSessionManager();
  var bridge = createSDKBridge({
    cwd: "/tmp/test-project",
    slug: "test-project",
    sessionManager: sm,
    send: function () {},
    adapter: adapter,
    adapters: { claude: adapter },
    onProcessingChanged: function () {},
    getConfig: null,
  });
  var session = makeSession();
  sm.sessions.set(session.localId, session);

  var lines = [];
  var realLog = console.log;
  console.log = function () {
    var line = Array.prototype.join.call(arguments, " ");
    if (line.indexOf(PREFIX) === 0) lines.push(line);
  };
  try {
    await bridge.startQuery(session, "msg", null, null);
    if (session.streamPromise) { try { await session.streamPromise; } catch (e) {} }
    await new Promise(function (r) { setImmediate(r); });
  } finally {
    console.log = realLog;
  }
  return lines;
}

var ROWS = [
  {
    name: "AC1 unknown type with subtype names both, not the body",
    raw: { type: "some_new_type", subtype: "x", secret: "BODY" },
    line: PREFIX + "unknown rawType=some_new_type subtype=x",
  },
  {
    name: "AC2 unknown type without subtype prints no subtype token",
    raw: { type: "some_new_type", secret: "BODY" },
    line: PREFIX + "unknown rawType=some_new_type",
  },
  {
    name: "AC2 non-string subtype is omitted",
    raw: { type: "some_new_type", subtype: { a: "BODY" } },
    line: PREFIX + "unknown rawType=some_new_type",
  },
  {
    name: "AC3 system catch-all names its subtype",
    raw: { type: "system", subtype: "novel_sub", message: "BODY" },
    line: PREFIX + "system subtype=novel_sub",
  },
  {
    name: "AC3 stream_event names event.type",
    raw: { type: "stream_event", event: { type: "novel_event", payload: "BODY" } },
    line: PREFIX + "stream_event eventType=novel_event",
  },
  {
    name: "AC3 block_start names the block type",
    raw: { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "novel_block", data: "BODY" } } },
    line: PREFIX + "block_start blockType=novel_block",
  },
  {
    name: "AC3 block_delta names the delta type",
    raw: { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "novel_delta", data: "BODY" } } },
    line: PREFIX + "block_delta deltaType=novel_delta",
  },
  {
    name: "AC4 worker diagnostic logs as diagnostic, no rawType, no message",
    raw: { type: "diagnostic", severity: "warning", source: "hook", message: "BODY" },
    line: PREFIX + "diagnostic",
  },
  {
    name: "AC5 mapped event is unchanged",
    raw: { type: "result", subtype: "success", result: "BODY" },
    line: PREFIX + "result",
  },
];

test("received-event log line names the raw discriminator, never a body value", async function () {
  for (var i = 0; i < ROWS.length; i++) {
    var row = ROWS[i];
    var lines = await receivedLines(row.raw);
    assert.deepEqual(lines, [row.line], row.name);
    assert.ok(lines[0].indexOf("BODY") === -1, row.name + ": no body value");
    assert.ok(lines[0].indexOf("undefined") === -1, row.name + ": no undefined token");
  }
});

test("the three delta types stay unlogged", async function () {
  var rows = [
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "BODY" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "BODY" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "BODY" } } },
  ];
  for (var i = 0; i < rows.length; i++) {
    assert.deepEqual(await receivedLines(rows[i]), []);
  }
});

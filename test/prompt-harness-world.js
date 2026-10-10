"use strict";
// The server side of the prompt invariant harness: the real session manager,
// SDK bridge, message processor, WS session handlers, HTTP handler and
// notifications module of one project, wired to in-memory clients through the
// same send/sendTo/sendEach transport the daemon gives them. Shared helper,
// not a test file: the runner only collects test/*.test.js.
//
// Every operation goes through an entry point that has existed across the
// prompt work's history (handleCanUseTool, handleElicitation,
// processSDKMessage, handleSessionsMessage, handleHTTP,
// replayHistory/switchSession), so the same harness can be pointed at an
// older lib/ via CLAGENTIC_CONSOLE_PROMPT_HARNESS_LIB to show it catches defects that
// were fixed there.

var fs = require("fs");
var os = require("os");
var path = require("path");
var { EventEmitter } = require("events");

var LIB_ROOT = process.env.CLAGENTIC_CONSOLE_PROMPT_HARNESS_LIB
  ? path.resolve(process.env.CLAGENTIC_CONSOLE_PROMPT_HARNESS_LIB)
  : path.join(__dirname, "..", "lib");

// Session fields that hold pending prompts, across every lib version.
var PROMPT_STORES = ["pendingPermissions", "pendingAskUser", "pendingElicitations"];

function libPath(name) { return path.join(LIB_ROOT, name); }

// A fresh daemon process: every lib module is re-evaluated against the
// current CLAGENTIC_HOME.
function purgeLib() {
  Object.keys(require.cache).forEach(function (k) {
    if (k.indexOf(LIB_ROOT + path.sep) === 0) delete require.cache[k];
  });
}

function flush() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

// An SDK query handle whose stream stays open until ended, like a live query
// waiting for the next user message. Like the real SDK's Query, closing it
// aborts the signal of every canUseTool callback it handed out and has not
// settled, a backgrounded sub-agent's included: the callbacks cannot outlive
// the query that issued them.
function makeQueryHandle() {
  var finish = null;
  var ended = false;
  var controllers = [];
  function abortIssuedSignals() {
    controllers.splice(0).forEach(function (c) { c.abort(); });
  }
  return {
    issueSignal: function () {
      var c = new AbortController();
      controllers.push(c);
      return c;
    },
    _adapterState: null,
    [Symbol.asyncIterator]: function () {
      return {
        next: function () {
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise(function (resolve) {
            finish = function () { resolve({ value: undefined, done: true }); };
          });
        },
      };
    },
    pushMessage: function () {},
    endInput: function () {},
    setPermissionMode: function () { return Promise.resolve(); },
    close: function () { abortIssuedSignals(); ended = true; if (finish) finish(); },
    abort: function () { abortIssuedSignals(); ended = true; if (finish) finish(); },
  };
}

/** requestIds of every prompt the session currently holds. */
function heldPromptIds(session) {
  var ids = [];
  PROMPT_STORES.forEach(function (store) {
    Object.keys(session[store] || {}).forEach(function (id) { ids.push(id); });
  });
  return ids;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.home] - reuse a CLAGENTIC_HOME (daemon restart).
 * @param {string} [opts.cliSessionId] - session to adopt from disk.
 * @param {object} [opts.pushModule] - receives the bridge's push sends.
 */
async function createServer(opts) {
  opts = opts || {};
  var home = opts.home || fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-prompt-harness-"));
  // Older lib/ checkouts (CLAGENTIC_CONSOLE_PROMPT_HARNESS_LIB) read the un-scoped name.
  process.env.CLAGENTIC_HOME = home;
  process.env.CLAGENTIC_CONSOLE_HOME = home;
  purgeLib();

  // The project's connected sockets, one collection for the transport and
  // every handler, as lib/project.js keeps them (a Set).
  var clients = new Set();
  function deliver(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
  var transport = {
    send: function (msg) { clients.forEach(function (ws) { deliver(ws, msg); }); },
    sendTo: function (ws, msg) { deliver(ws, msg); },
    sendEach: function (fn) { Array.from(clients).forEach(function (ws) { fn(ws, null); }); },
  };

  var notifications = require(libPath("project-notifications")).attachNotifications({
    broadcastAll: transport.send,
    pushModule: null,
  });
  function getNotificationsModule() { return notifications; }

  var sm = require(libPath("sessions")).createSessionManager({
    cwd: home,
    send: transport.send,
    sendTo: transport.sendTo,
    sendEach: transport.sendEach,
    getNotificationsModule: getNotificationsModule,
    onProcessingChanged: function () {},
  });

  var handles = [];
  var adapter = {
    vendor: "claude",
    createQuery: function () {
      var h = makeQueryHandle();
      handles.push(h);
      return Promise.resolve(h);
    },
    init: function () { return Promise.resolve({ models: [], skills: [] }); },
    supportedModels: function () { return Promise.resolve([]); },
  };
  var bridge = require(libPath("sdk-bridge")).createSDKBridge({
    cwd: home,
    slug: "harness",
    sessionManager: sm,
    send: transport.send,
    adapter: adapter,
    adapters: { claude: adapter },
    getNotificationsModule: getNotificationsModule,
    onProcessingChanged: function () {},
    pushModule: opts.pushModule || null,
  });

  var handlerContext = {
    cwd: home, slug: "harness", osUsers: false, currentVersion: "0.0.0",
    sm: sm, sdk: bridge, tm: null, clients: clients, opts: {},
    getNotificationsModule: getNotificationsModule,
    send: transport.send, sendTo: transport.sendTo, sendToAdmins: function () {},
    sendToSession: function () {}, sendToSessionOthers: function () {},
    usersModule: { isMultiUser: function () { return false; } },
    userPresence: null, pushModule: null,
    getSessionForWs: function (ws) { return sm.sessions.get(ws._clagenticActiveSession) || null; },
    getLinuxUserForSession: function () { return null; },
    // Production returns the session's Linux user, which is null without OS
    // users (lib/project.js ensureProjectAccessForSession); it is the user a
    // query runs as, not an access verdict, so null rejects nothing.
    ensureProjectAccessForSession: function () { return null; },
    getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function (o) { return o; },
    onProcessingChanged: function () {}, broadcastPresence: function () {},
    adapter: adapter, getProjectList: function () { return []; },
    getProjectCount: function () { return 0; }, getScheduleCount: function () { return 0; },
  };
  var handlers = require(libPath("project-sessions")).attachSessions(handlerContext);

  var http = require(libPath("project-http")).attachHTTP({
    cwd: home, slug: "harness", sm: sm, send: transport.send,
    getNotificationsModule: getNotificationsModule,
  });

  var session = null;
  if (opts.cliSessionId) {
    sm.sessions.forEach(function (s) { if (s.cliSessionId === opts.cliSessionId) session = s; });
    if (!session) throw new Error("restart lost session " + opts.cliSessionId);
  } else {
    session = sm.createSessionRaw({});
    session.cliSessionId = "harness-" + path.basename(home);
    sm.saveSessionFile(session);
  }

  var server = {
    home: home,
    sm: sm,
    bridge: bridge,
    handlers: handlers,
    // What the session handlers were given, so a test can hold the harness
    // to the shape production gives them.
    handlerContext: handlerContext,
    notifications: notifications,
    session: session,
    clients: clients,
    canElicit: typeof bridge.handleElicitation === "function",

    startQuery: async function () {
      await bridge.startQuery(session, "go", null, null);
      await flush();
    },

    /** An abort controller whose signal the live query cancels when it closes. */
    issueSignal: function () {
      if (!session.queryInstance) throw new Error("no live query to issue a canUseTool signal");
      return session.queryInstance.issueSignal();
    },

    // Closes the live query; its processQueryStream finally runs. A stream
    // that rejects fails the step that ended it.
    endQuery: async function () {
      var h = session.queryInstance;
      if (h) h.close();
      if (session.streamPromise) await session.streamPromise;
      await flush();
    },

    sdk: function (msg) { bridge.processSDKMessage(session, msg); },

    record: function (msg) { sm.sendAndRecord(session, msg); },

    heldPromptIds: function () { return heldPromptIds(session); },

    httpRespond: function (requestId, decision) {
      var req = new EventEmitter();
      req.method = "POST";
      return new Promise(function (resolve) {
        var res = {
          statusCode: 0,
          writeHead: function (code) { res.statusCode = code; },
          end: function () { resolve(res.statusCode); },
        };
        http.handleHTTP(req, res, "/api/permission-response");
        req.emit("data", JSON.stringify({ requestId: requestId, decision: decision }));
        req.emit("end");
      });
    },

    /** requestIds the server re-presents to a freshly connecting client. */
    pendingSnapshot: function () {
      var seen = [];
      var probe = { readyState: 1, _clagenticUser: null, send: function (data) { seen.push(JSON.parse(data)); } };
      sm.switchSession(session.localId, probe, function (o) { return o; });
      return seen.filter(function (m) { return m.type === "prompt_pending" || m.type === "permission_request_pending"; })
        .map(function (m) { return m.requestId; });
    },

    /** requestIds that still have a prompt notification. */
    notifiedRequestIds: function () {
      var state = null;
      notifications.sendConnectionState({}, function (ws, msg) { state = msg; });
      return (state.notifications || [])
        .filter(function (n) { return n.type === "permission_request" && n.meta; })
        .map(function (n) { return n.meta.requestId; });
    },

    connect: function (ws) {
      ws.readyState = 1;
      ws._clagenticActiveSession = session.localId;
      clients.add(ws);
      sm.switchSession(session.localId, ws, function (o) { return o; });
    },

    disconnect: function (ws) {
      ws.readyState = 3;
      clients.delete(ws);
    },

    // What a daemon going away does: tear the session manager down (which
    // ends every prompt nothing can answer any more, in a lib that does),
    // flush, then drop every client.
    shutdown: function () {
      sm.destroy();
      sm.saveSessionFile(session);
      Array.from(clients).forEach(function (ws) { server.disconnect(ws); });
    },
  };
  return server;
}

function removeHome(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

module.exports = {
  LIB_ROOT: LIB_ROOT,
  overridesLib: !!process.env.CLAGENTIC_CONSOLE_PROMPT_HARNESS_LIB,
  createServer: createServer,
  removeHome: removeHome,
  flush: flush,
};

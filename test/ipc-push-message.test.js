// ipc-push-message.test.js — unit tests for the push_message IPC handler contract.
//
// Rather than importing lib/daemon.js (which pulls in the live relay object),
// we build a standalone handler that mirrors the push_message logic from
// lib/daemon.js lines 1421-1456, inject a relay mock, and exercise the full
// IPC transport via createIPCServer + sendIPCCommand.
//
// Each test creates a unique socket in os.tmpdir() and cleans up after itself.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { createIPCServer, sendIPCCommand } = require("../lib/ipc");

// ---------------------------------------------------------------------------
// Standalone push_message handler — mirrors daemon.js lines 1421-1456 exactly.
// ---------------------------------------------------------------------------

function makePushMessageHandler(relay) {
  return function handlePushMessage(msg) {
    if (msg.cmd !== "push_message") return { ok: false, error: "wrong cmd" };
    if (!msg.sessionId || typeof msg.sessionId !== "string") {
      return { ok: false, error: "missing or invalid sessionId" };
    }
    if (!msg.text || typeof msg.text !== "string") {
      return { ok: false, error: "missing or invalid text" };
    }
    try {
      var found = null;
      relay.forEachProject(function (ctx) {
        if (found) return;
        ctx.sm.sessions.forEach(function (s) {
          if (!found && s.cliSessionId === msg.sessionId) {
            found = { ctx: ctx, session: s };
          }
        });
      });
      if (!found) {
        return { ok: false, error: "session not found: " + msg.sessionId };
      }
      found.ctx.sdk.pushMessage(found.session, msg.text, null);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };
}

// ---------------------------------------------------------------------------
// Helper: unique sock path per test.
// ---------------------------------------------------------------------------

var _sockCounter = 0;
function tempSockPath() {
  _sockCounter += 1;
  return path.join(os.tmpdir(), "ipc-pm-test-" + process.pid + "-" + _sockCounter + ".sock");
}

// ---------------------------------------------------------------------------
// Helper: build an IPC server with the given relay mock, run a callback that
// returns a Promise (receives sockPath), then close and unlink.
// ---------------------------------------------------------------------------

function withServer(relayMock, runFn) {
  return new Promise(function (resolve, reject) {
    var sockPath = tempSockPath();
    var handler = makePushMessageHandler(relayMock);
    var server = createIPCServer(sockPath, handler);

    // Give the server a moment to start listening before connecting.
    setTimeout(function () {
      runFn(sockPath).then(function (result) {
        server.close();
        try { fs.unlinkSync(sockPath); } catch (e) {}
        resolve(result);
      }).catch(function (err) {
        server.close();
        try { fs.unlinkSync(sockPath); } catch (e) {}
        reject(err);
      });
    }, 20);
  });
}

// ---------------------------------------------------------------------------
// Relay mocks
// ---------------------------------------------------------------------------

// A relay with no sessions in any project.
function makeEmptyRelay() {
  return {
    forEachProject: function (cb) {
      // one project, no sessions
      var ctx = { sm: { sessions: new Map() }, sdk: {} };
      cb(ctx);
    },
  };
}

// A relay with one session matching the given cliSessionId.
function makeRelayWithSession(cliSessionId, pushLog) {
  return {
    forEachProject: function (cb) {
      var sessions = new Map();
      var sess = { cliSessionId: cliSessionId };
      sessions.set(1, sess);
      var ctx = {
        sm: { sessions: sessions },
        sdk: {
          pushMessage: function (session, text, images) {
            pushLog.push({ session: session, text: text, images: images });
          },
        },
      };
      cb(ctx);
    },
  };
}

// A relay whose forEachProject throws.
function makeThrowingRelay() {
  return {
    forEachProject: function () {
      throw new Error("relay exploded");
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("push_message: missing sessionId returns error", function (t, done) {
  withServer(makeEmptyRelay(), function (sockPath) {
    return sendIPCCommand(sockPath, { cmd: "push_message", text: "hello" }).then(function (resp) {
      assert.strictEqual(resp.ok, false);
      assert.strictEqual(resp.error, "missing or invalid sessionId");
    });
  }).then(function () { done(); }).catch(done);
});

test("push_message: sessionId is not a string returns error", function (t, done) {
  withServer(makeEmptyRelay(), function (sockPath) {
    return sendIPCCommand(sockPath, { cmd: "push_message", sessionId: 42, text: "hello" }).then(function (resp) {
      assert.strictEqual(resp.ok, false);
      assert.strictEqual(resp.error, "missing or invalid sessionId");
    });
  }).then(function () { done(); }).catch(done);
});

test("push_message: missing text returns error", function (t, done) {
  withServer(makeEmptyRelay(), function (sockPath) {
    return sendIPCCommand(sockPath, { cmd: "push_message", sessionId: "sess-abc" }).then(function (resp) {
      assert.strictEqual(resp.ok, false);
      assert.strictEqual(resp.error, "missing or invalid text");
    });
  }).then(function () { done(); }).catch(done);
});

test("push_message: text is not a string returns error", function (t, done) {
  withServer(makeEmptyRelay(), function (sockPath) {
    return sendIPCCommand(sockPath, { cmd: "push_message", sessionId: "sess-abc", text: 99 }).then(function (resp) {
      assert.strictEqual(resp.ok, false);
      assert.strictEqual(resp.error, "missing or invalid text");
    });
  }).then(function () { done(); }).catch(done);
});

test("push_message: session not found returns descriptive error", function (t, done) {
  withServer(makeEmptyRelay(), function (sockPath) {
    return sendIPCCommand(sockPath, { cmd: "push_message", sessionId: "sess-unknown", text: "hi" }).then(function (resp) {
      assert.strictEqual(resp.ok, false);
      assert.strictEqual(resp.error, "session not found: sess-unknown");
    });
  }).then(function () { done(); }).catch(done);
});

test("push_message: session found returns ok and calls sdk.pushMessage", function (t, done) {
  var pushLog = [];
  var relay = makeRelayWithSession("sess-known-123", pushLog);

  withServer(relay, function (sockPath) {
    return sendIPCCommand(sockPath, { cmd: "push_message", sessionId: "sess-known-123", text: "deliver this" }).then(function (resp) {
      assert.strictEqual(resp.ok, true);
      assert.strictEqual(pushLog.length, 1, "pushMessage called exactly once");
      assert.strictEqual(pushLog[0].text, "deliver this");
      assert.strictEqual(pushLog[0].images, null, "images arg is null");
      assert.ok(pushLog[0].session && pushLog[0].session.cliSessionId === "sess-known-123", "correct session passed");
    });
  }).then(function () { done(); }).catch(done);
});

test("push_message: handler throws returns error and does not crash", function (t, done) {
  withServer(makeThrowingRelay(), function (sockPath) {
    return sendIPCCommand(sockPath, { cmd: "push_message", sessionId: "sess-xyz", text: "boom" }).then(function (resp) {
      assert.strictEqual(resp.ok, false);
      assert.strictEqual(resp.error, "relay exploded");
    });
  }).then(function () { done(); }).catch(done);
});

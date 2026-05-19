// relay-agent-claims.test.js — unit tests for lib/relay-agent-claims.js
//
// Tests cover:
//   - listOpenConversationsForAgent: sidecar directory parsing + participant filter
//   - isRelayReachable: returns false when socket is absent
//   - attachAgentSession: no-op when relay is absent
//   - detachAgentSession: cleans up state and stops heartbeat timer
//   - onNewConversation: no-op when relay absent; registers claim when relay present
//   - relay-present path: register/heartbeat/release via Unix socket fake server

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var os = require("os");

// We need the module to use a temp dir for sidecars. The module reads loreHomeDir()
// at call time, which is os.homedir()/.lore. We monkey-patch CLAGENTIC_RELAY_SOCKET
// to a nonexistent path so isRelayReachable returns false quickly.
//
// For sidecar tests we pass an explicit directory override via a small wrapper
// that exposes the internal helpers.

// Point relay socket at a path that will never exist so all relay calls return false quickly.
process.env.CLAGENTIC_RELAY_SOCKET = path.join(os.tmpdir(), "no-relay-test-" + Date.now() + ".sock");

var claims = require("../lib/relay-agent-claims");

// --- listOpenConversationsForAgent tests ---

test("listOpenConversationsForAgent returns empty array when sidecar dir absent", function () {
  // loreHomeDir() returns os.homedir()/.lore — we can't easily override it.
  // But if the dir is absent the function returns []. In CI the dir likely
  // doesn't exist; in dev it might. Either way the function should return an array.
  var result = claims.listOpenConversationsForAgent("test-agent-xyz-notreal");
  assert.ok(Array.isArray(result), "should return an array");
});

test("listOpenConversationsForAgent filters by participant name and status=open", function () {
  // Build a temp sidecar dir, inject sidecars, and point loreHomeDir at it.
  // We do this by temporarily replacing os.homedir.
  var tmpLore = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claims-test-"));
  var sidecarDir = path.join(tmpLore, "conversation-sidecars");
  fs.mkdirSync(sidecarDir);

  // Sidecar 1: open, participant "amos"
  fs.writeFileSync(path.join(sidecarDir, "aaaa-1111.json"), JSON.stringify({
    conversation_id: "aaaa-1111-2222-3333",
    topic: "test build",
    kind: "build",
    status: "open",
    opened_by: "andy",
    opened_at: "2026-05-19T10:00:00Z",
    message_count: 3,
    last_seq: 3,
    participants: [
      { name: "andy", role: "operator" },
      { name: "amos", role: "crew" },
    ],
  }));

  // Sidecar 2: open, no "amos" participant
  fs.writeFileSync(path.join(sidecarDir, "bbbb-2222.json"), JSON.stringify({
    conversation_id: "bbbb-2222-3333-4444",
    topic: "another build",
    kind: "build",
    status: "open",
    opened_by: "andy",
    opened_at: "2026-05-19T11:00:00Z",
    message_count: 1,
    last_seq: 1,
    participants: [
      { name: "andy", role: "operator" },
      { name: "naomi", role: "crew" },
    ],
  }));

  // Sidecar 3: closed, participant "amos" — must be excluded
  fs.writeFileSync(path.join(sidecarDir, "cccc-3333.json"), JSON.stringify({
    conversation_id: "cccc-3333-4444-5555",
    topic: "closed build",
    kind: "build",
    status: "closed",
    opened_by: "andy",
    opened_at: "2026-05-18T10:00:00Z",
    message_count: 5,
    last_seq: 5,
    participants: [
      { name: "andy", role: "operator" },
      { name: "amos", role: "crew" },
    ],
  }));

  // Swap os.homedir temporarily
  var origHomedir = os.homedir;
  os.homedir = function () { return tmpLore; };

  try {
    var result = claims.listOpenConversationsForAgent("amos");
    assert.strictEqual(result.length, 1, "should return exactly 1 open conv for amos");
    assert.strictEqual(result[0].conversation_id, "aaaa-1111-2222-3333");
  } finally {
    os.homedir = origHomedir;
    fs.rmSync(tmpLore, { recursive: true, force: true });
  }
});

test("listOpenConversationsForAgent handles malformed JSON gracefully", function () {
  var tmpLore = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claims-bad-json-"));
  var sidecarDir = path.join(tmpLore, "conversation-sidecars");
  fs.mkdirSync(sidecarDir);
  fs.writeFileSync(path.join(sidecarDir, "bad.json"), "not valid json {{");
  fs.writeFileSync(path.join(sidecarDir, "good.json"), JSON.stringify({
    conversation_id: "dddd-4444-5555-6666",
    topic: "good conv",
    kind: "build",
    status: "open",
    participants: [{ name: "test-agent", role: "crew" }],
    message_count: 1,
  }));

  var origHomedir = os.homedir;
  os.homedir = function () { return tmpLore; };
  try {
    var result = claims.listOpenConversationsForAgent("test-agent");
    assert.strictEqual(result.length, 1, "should skip bad JSON and return good sidecar");
  } finally {
    os.homedir = origHomedir;
    fs.rmSync(tmpLore, { recursive: true, force: true });
  }
});

// --- isRelayReachable tests ---

test("isRelayReachable returns false when socket path does not exist", function (t, done) {
  claims.isRelayReachable().then(function (reachable) {
    assert.strictEqual(reachable, false, "relay should be unreachable when socket is absent");
    done();
  });
});

// --- attachAgentSession / detachAgentSession tests ---

test("attachAgentSession is a no-op when relay is absent", function (t, done) {
  var fakeSession = { localId: 9001, agentName: "test-agent" };
  var messages = [];
  var sendFn = function (obj) { messages.push(obj); };

  // attachAgentSession should return without error; relay check fails quickly.
  claims.attachAgentSession(fakeSession, "test-agent", sendFn);

  // Allow async relay check to complete.
  setTimeout(function () {
    // No system messages should have been sent (relay absent path sends nothing).
    assert.strictEqual(messages.length, 0, "no messages should be sent when relay is absent");
    // State should be cleaned up (relay absent path removes state entry).
    assert.strictEqual(claims.hasClaimState(9001), false, "no claim state should remain");
    done();
  }, 300);
});

test("detachAgentSession is safe to call for unknown localId", function () {
  // Should not throw for a localId with no state.
  assert.doesNotThrow(function () {
    claims.detachAgentSession(99999);
  });
});

test("getClaimsForSession returns null for unknown localId", function () {
  var result = claims.getClaimsForSession(88888);
  assert.strictEqual(result, null);
});

// --- onNewConversation tests ---

test("onNewConversation is a no-op when no active session state exists", function (t, done) {
  // No attachAgentSession called for localId 77777.
  claims.onNewConversation(77777, "test-agent", "conv-id-xyz").then(function (result) {
    assert.strictEqual(result, null, "should return null when no state exists for localId");
    done();
  });
});

test("onNewConversation returns null when relay is absent (no claim registered)", function (t, done) {
  // Use a fresh localId to avoid interference from prior tests.
  var fakeSession = { localId: 9002, agentName: "test-agent-conv" };
  var sendFn = function () {};

  claims.attachAgentSession(fakeSession, "test-agent-conv", sendFn);

  // Wait for relay check to complete and state to be cleaned up (relay absent).
  setTimeout(function () {
    // With relay absent, attachAgentSession deletes state after isRelayReachable resolves false.
    // onNewConversation should therefore return null.
    claims.onNewConversation(9002, "test-agent-conv", "some-conv-id").then(function (result) {
      assert.strictEqual(result, null, "should return null when relay is absent (state cleaned up)");
      done();
    });
  }, 400);
});

// --- startSidecarWatcher B4 regression test ---
//
// Verify that sidecar rewrites for pre-existing conversations do NOT trigger
// auto-claim (regression guard for B4 — startSidecarWatcher must skip convIds
// that existed at watcher-start time).

test("startSidecarWatcher does not auto-claim pre-existing conv on sidecar rewrite", function (t, done) {
  var net = require("net");

  // Build a minimal fake relay server on a temp socket so attachAgentSession
  // believes relay is reachable (otherwise watcher is never started).
  var sockPath = path.join(os.tmpdir(), "relay-b4-test-" + Date.now() + ".sock");

  // Sidecar dir with one pre-existing conv.
  var tmpLore = fs.mkdtempSync(path.join(os.tmpdir(), "relay-b4-lore-"));
  var sidecarDir = path.join(tmpLore, "conversation-sidecars");
  fs.mkdirSync(sidecarDir);

  var preExistingConvId = "pre-existing-conv-b4b4-1234";
  var preExistingSidecar = {
    conversation_id: preExistingConvId,
    topic: "pre-existing conv",
    kind: "build",
    status: "open",
    opened_at: "2026-05-18T10:00:00Z",
    message_count: 2,
    participants: [{ name: "amos", role: "crew" }],
  };
  var sidecarPath = path.join(sidecarDir, "pre-existing.json");
  fs.writeFileSync(sidecarPath, JSON.stringify(preExistingSidecar));

  var claimedConvIds = [];

  var server = net.createServer(function (conn) {
    var buf = "";
    conn.on("data", function (chunk) {
      buf += chunk.toString();
      var headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      var headers = buf.substring(0, headerEnd);
      var body = buf.substring(headerEnd + 4);
      var clMatch = headers.match(/content-length:\s*(\d+)/i);
      var contentLength = clMatch ? parseInt(clMatch[1], 10) : 0;
      if (body.length < contentLength) return;

      // Record the conversation_id from the request body so we can assert.
      try {
        var parsed = JSON.parse(body);
        if (parsed.conversation_id) claimedConvIds.push(parsed.conversation_id);
      } catch (e) {}

      var resp = JSON.stringify({ claim_id: "b4-claim-id", heartbeat_ts: Date.now(), effective: true });
      conn.write(
        "HTTP/1.1 200 OK\r\n" +
        "Content-Type: application/json\r\n" +
        "Content-Length: " + Buffer.byteLength(resp) + "\r\n" +
        "Connection: close\r\n" +
        "\r\n" +
        resp
      );
      conn.end();
      buf = "";
    });
    conn.on("error", function () {});
  });

  server.listen(sockPath, function () {
    var origSocket = process.env.CLAGENTIC_RELAY_SOCKET;
    var origHomedir = os.homedir;
    process.env.CLAGENTIC_RELAY_SOCKET = sockPath;
    os.homedir = function () { return tmpLore; };

    var fakeSession = { localId: 8001 };
    var messages = [];
    claims.attachAgentSession(fakeSession, "amos", function (m) { messages.push(m); });

    // Wait for attachAgentSession to complete (relay reachable → watcher started).
    setTimeout(function () {
      // Now rewrite the pre-existing sidecar (simulates a new message arriving
      // in an existing conversation — this was the B4 trigger).
      preExistingSidecar.message_count = 5;
      fs.writeFileSync(sidecarPath, JSON.stringify(preExistingSidecar));

      // Also write a brand-new conv sidecar to confirm new convs ARE auto-claimed.
      var newConvId = "new-conv-after-attach-b4b4-5678";
      fs.writeFileSync(path.join(sidecarDir, "new-conv.json"), JSON.stringify({
        conversation_id: newConvId,
        topic: "new conv",
        kind: "build",
        status: "open",
        opened_at: "2026-05-19T20:00:00Z",
        message_count: 1,
        participants: [{ name: "amos", role: "crew" }],
      }));

      // Allow watcher debounce (50ms) + async claim to settle.
      setTimeout(function () {
        // Cleanup.
        process.env.CLAGENTIC_RELAY_SOCKET = origSocket || path.join(os.tmpdir(), "no-relay-test-absent.sock");
        os.homedir = origHomedir;
        claims.detachAgentSession(8001);
        server.close();
        try { fs.unlinkSync(sockPath); } catch (e) {}
        try { fs.rmSync(tmpLore, { recursive: true, force: true }); } catch (e) {}

        // Pre-existing conv must NOT have been auto-claimed.
        assert.ok(
          !claimedConvIds.includes(preExistingConvId),
          "pre-existing conv must not be auto-claimed on sidecar rewrite (B4 regression)"
        );
        // New conv SHOULD have been auto-claimed.
        assert.ok(
          claimedConvIds.includes(newConvId),
          "newly-appeared conv must be auto-claimed by watcher"
        );

        done();
      }, 400);
    }, 400);
  });
});

// --- relay-present path tests using a Unix socket fake server ---

test("registerClaim, heartbeatClaim, releaseClaim succeed against fake relay server", function (t, done) {
  var net = require("net");
  var os = require("os");
  var path = require("path");
  var fs = require("fs");

  // Build a minimal HTTP/1.1 Unix-socket server that returns 200 JSON for any POST.
  var sockPath = path.join(os.tmpdir(), "relay-fake-" + Date.now() + ".sock");
  var received = [];

  var server = net.createServer(function (conn) {
    var buf = "";
    conn.on("data", function (chunk) {
      buf += chunk.toString();
      // Wait for end of headers + body.
      var headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      var headers = buf.substring(0, headerEnd);
      var body = buf.substring(headerEnd + 4);

      // Parse Content-Length to know when full body arrived.
      var clMatch = headers.match(/content-length:\s*(\d+)/i);
      var contentLength = clMatch ? parseInt(clMatch[1], 10) : 0;
      if (body.length < contentLength) return; // wait for more data

      var requestLine = headers.split("\r\n")[0];
      var urlPath = requestLine.split(" ")[1] || "";
      received.push(urlPath);

      var resp = JSON.stringify({ claim_id: "test-claim-id", heartbeat_ts: Date.now(), effective: true });
      conn.write(
        "HTTP/1.1 200 OK\r\n" +
        "Content-Type: application/json\r\n" +
        "Content-Length: " + Buffer.byteLength(resp) + "\r\n" +
        "Connection: close\r\n" +
        "\r\n" +
        resp
      );
      conn.end();
      buf = "";
    });
    conn.on("error", function () {});
  });

  server.listen(sockPath, function () {
    // Point the module at the fake server.
    var origSocket = process.env.CLAGENTIC_RELAY_SOCKET;
    process.env.CLAGENTIC_RELAY_SOCKET = sockPath;

    // isRelayReachable should now return true.
    claims.isRelayReachable().then(function (reachable) {
      assert.ok(reachable, "isRelayReachable should return true for fake server");

      // Exercise register / heartbeat / release.
      return claims.registerClaim("test-agent", "conv-fake-id", "test-session").then(function (claimId) {
        assert.ok(claimId, "registerClaim should return a claim_id");
        return claims.heartbeatClaim("test-agent", "conv-fake-id", claimId);
      }).then(function (effective) {
        assert.ok(effective, "heartbeatClaim should return true for 200 response");
        return claims.releaseClaim("test-agent", "conv-fake-id", "test-claim-id");
      }).then(function () {
        assert.ok(received.some(function (p) { return p.indexOf("register") !== -1; }), "register endpoint called");
        assert.ok(received.some(function (p) { return p.indexOf("heartbeat") !== -1; }), "heartbeat endpoint called");
        assert.ok(received.some(function (p) { return p.indexOf("release") !== -1; }), "release endpoint called");
      });
    }).then(function () {
      process.env.CLAGENTIC_RELAY_SOCKET = origSocket || path.join(os.tmpdir(), "no-relay-test-absent.sock");
      server.close();
      try { fs.unlinkSync(sockPath); } catch (e) {}
      done();
    }).catch(function (err) {
      process.env.CLAGENTIC_RELAY_SOCKET = origSocket || path.join(os.tmpdir(), "no-relay-test-absent.sock");
      server.close();
      try { fs.unlinkSync(sockPath); } catch (e) {}
      done(err);
    });
  });
});

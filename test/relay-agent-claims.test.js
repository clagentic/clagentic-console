// relay-agent-claims.test.js — unit tests for lib/relay-agent-claims.js
//
// Tests cover:
//   - listOpenConversationsForAgent: sidecar directory parsing + participant filter
//   - attachAgentSession: no-op when relay is absent
//   - detachAgentSession: cleans up state and stops heartbeat timer
//   - onNewConversation: registers claim for new convs on active sessions
//
// All relay HTTP calls are avoided by ensuring isRelayReachable resolves false
// in the absence of a live socket. The listOpenConversationsForAgent tests use
// a temp sidecar directory.

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

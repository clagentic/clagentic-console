"use strict";
// A permission card is a pure function of the server's state for its
// requestId, never of message order: paged history replay delivers a
// resolution (newer page) before the request it closes (older page), and a
// reconnect re-presents still-pending requests after replay.

var test = require("node:test");
var assert = require("node:assert/strict");
var { setupToolsEnv, cardFor, enabledButtons, decisionLabel, moduleUrl } = require("./fake-dom-permission-cards");

function request(id, extra) {
  return Object.assign({ type: "permission_request", requestId: id, toolName: "Write", toolInput: { file_path: "/tmp/x" }, decisionReason: "" }, extra || {});
}

test("permission-state: terminal states are final and the first terminal wins", async function () {
  var { createPermissionStates } = await import(moduleUrl("permission-state.js"));
  var states = createPermissionStates();

  assert.deepEqual(states.apply("a", { state: "pending" }), { state: "pending", decision: null, reason: null });
  states.apply("a", { state: "resolved", decision: "deny" });
  states.apply("a", { state: "pending" });
  states.apply("a", { state: "cancelled", reason: "stale" });

  assert.deepEqual(states.get("a"), { state: "resolved", decision: "deny", reason: null });
  states.clear();
  assert.equal(states.get("a"), null);
});

test("a resolution seen before its request draws the request already resolved", async function (t) {
  var env = await setupToolsEnv(t);

  env.tools.applyPermissionMessage({ type: "permission_resolved", requestId: "r-split", decision: "allow" });
  // Loading an older page resets tool state before drawing the request.
  env.tools.resetToolState();
  env.tools.applyPermissionMessage(request("r-split"));

  var c = cardFor(env, "r-split");
  assert.ok(c.classList.contains("resolved-allowed"));
  assert.equal(decisionLabel(c), "Allowed");
  assert.equal(enabledButtons(c).length, 0);
});

test("a replayed request carrying the server's state renders that state", async function (t) {
  var env = await setupToolsEnv(t);

  env.tools.applyPermissionMessage(request("r-allow", { permissionState: { state: "resolved", decision: "allow_always" } }));
  env.tools.applyPermissionMessage(request("r-gone", { permissionState: { state: "cancelled", reason: "stale" } }));
  env.tools.applyPermissionMessage(request("r-turn", { permissionState: { state: "cancelled", reason: "turn_ended" } }));
  env.tools.applyPermissionMessage(request("r-expired", { permissionState: { state: "cancelled", reason: "expired" } }));
  var live = env.tools.applyPermissionMessage(request("r-live", { permissionState: { state: "pending" } }));

  assert.equal(decisionLabel(cardFor(env, "r-allow")), "Allowed for session");
  assert.match(decisionLabel(cardFor(env, "r-gone")), /No longer active/);
  assert.equal(decisionLabel(cardFor(env, "r-turn")), "Cancelled");
  assert.equal(decisionLabel(cardFor(env, "r-expired")), "Expired");
  ["r-allow", "r-gone", "r-turn", "r-expired"].forEach(function (id) {
    assert.equal(enabledButtons(cardFor(env, id)).length, 0, id);
  });
  assert.equal(live.state, "pending");
  assert.ok(enabledButtons(cardFor(env, "r-live")).length >= 2);
});

test("a live request with no recorded outcome stays clickable", async function (t) {
  var env = await setupToolsEnv(t);

  var st = env.tools.applyPermissionMessage(request("r-live"));

  assert.equal(st.state, "pending");
  assert.ok(enabledButtons(cardFor(env, "r-live")).length >= 2);
});

test("a pending snapshot cannot reopen a request the server already settled", async function (t) {
  var env = await setupToolsEnv(t);

  env.tools.applyPermissionMessage(request("r-done"));
  env.tools.applyPermissionMessage({ type: "permission_cancel", requestId: "r-done", reason: "turn_ended" });
  env.tools.applyPermissionMessage({ type: "permission_request_pending", requestId: "r-done", toolName: "Write", toolInput: {} });

  var c = cardFor(env, "r-done");
  assert.equal(decisionLabel(c), "Cancelled");
  assert.equal(enabledButtons(c).length, 0);
  assert.equal(env.messagesEl.querySelectorAll('[data-request-id="r-done"]').length, 1);
});

test("clearPermissionStates forgets outcomes when the transcript is rebuilt", async function (t) {
  var env = await setupToolsEnv(t);

  env.tools.markPermissionResolved("r-forget", "deny");
  env.tools.clearPermissionStates();
  env.tools.applyPermissionMessage(request("r-forget"));

  assert.ok(!cardFor(env, "r-forget").classList.contains("resolved"));
});

test("applyPermissionMessage ignores unrelated messages", async function (t) {
  var env = await setupToolsEnv(t);
  assert.equal(env.tools.applyPermissionMessage({ type: "delta", text: "x" }), null);
});

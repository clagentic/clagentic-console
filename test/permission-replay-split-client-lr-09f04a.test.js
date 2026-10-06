"use strict";
// Paged history replay can deliver a permission_resolved (newer page) before
// the permission_request it closes (older page). The request must not come back
// as a live card.

var test = require("node:test");
var assert = require("node:assert/strict");
var { setupToolsEnv, cardFor, enabledButtons } = require("./fake-dom-permission-cards");

function label(c) {
  var m = /permission-decision-label">([^<]*)</.exec(c.textContent);
  return m ? m[1] : "";
}

test("an older page's request is drawn resolved when its resolution arrived on the first page", async function (t) {
  var env = await setupToolsEnv(t);

  // First page: only the resolution, no card to mark.
  env.tools.markPermissionResolved("r-split", "allow");
  // Auto-load of the older page resets tool state before drawing the request.
  env.tools.resetToolState();
  env.tools.renderPermissionRequest("r-split", "Write", { file_path: "/tmp/x" }, "");

  var c = cardFor(env, "r-split");
  assert.ok(c, "the request must still be drawn");
  assert.ok(c.classList.contains("resolved-allowed"));
  assert.equal(label(c), "Allowed");
  assert.equal(enabledButtons(c).length, 0, "no enabled buttons on a settled card");
});

test("a request flagged settled by the server renders resolved, or as no longer active when the decision is unknown", async function (t) {
  var env = await setupToolsEnv(t);

  env.tools.rememberSettledPermission("r-allow", "allow");
  env.tools.renderPermissionRequest("r-allow", "Write", { file_path: "/tmp/x" }, "");
  env.tools.rememberSettledPermission("r-unknown", undefined);
  env.tools.renderPermissionRequest("r-unknown", "Write", { file_path: "/tmp/x" }, "");

  var allowed = cardFor(env, "r-allow");
  assert.equal(label(allowed), "Allowed");
  assert.equal(enabledButtons(allowed).length, 0);
  var unknown = cardFor(env, "r-unknown");
  assert.match(label(unknown), /No longer active/);
  assert.equal(enabledButtons(unknown).length, 0);
});

test("guard: a request with no recorded resolution stays clickable", async function (t) {
  var env = await setupToolsEnv(t);

  env.tools.resetToolState();
  env.tools.renderPermissionRequest("r-live", "Write", { file_path: "/tmp/x" }, "");

  var c = cardFor(env, "r-live");
  assert.ok(!c.classList.contains("resolved"));
  assert.ok(enabledButtons(c).length >= 2, "approve and deny remain available");
});

test("guard: the server's pending flag overrides a remembered resolution", async function (t) {
  var env = await setupToolsEnv(t);

  env.tools.rememberSettledPermission("r-pending", "allow");
  env.tools.renderPermissionRequest("r-pending", "Write", { file_path: "/tmp/x" }, "", undefined, undefined, true);

  var c = cardFor(env, "r-pending");
  assert.ok(!c.classList.contains("resolved"));
  assert.ok(enabledButtons(c).length >= 2);
});

test("clearSettledPermissions forgets remembered resolutions", async function (t) {
  var env = await setupToolsEnv(t);

  env.tools.markPermissionResolved("r-forget", "deny");
  env.tools.clearSettledPermissions();
  env.tools.renderPermissionRequest("r-forget", "Write", { file_path: "/tmp/x" }, "");

  assert.ok(!cardFor(env, "r-forget").classList.contains("resolved"));
});

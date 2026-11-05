"use strict";

// The top-level /api/push-subscribe route in lib/server.js (the one the setup
// page uses) must carry the logged-in user into the subscription, and refuse a
// subscribe that proves no user in multi-user mode. Driven through a real
// server with real login cookies.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var harness = require("./access-harness");

var H = null;
var subsFile = null;

test.before(async function () {
  H = await harness.start({ users: [{ key: "alice", username: "alice" }] });
  subsFile = path.join(H.home, "console", "push-subs.json");
});

test.after(async function () {
  if (H) await H.stop();
});

function readSubs() {
  try {
    var saved = JSON.parse(fs.readFileSync(subsFile, "utf8"));
    return Array.isArray(saved.subs) ? saved.subs : null;
  } catch (e) {
    return null;
  }
}

// The route stores through a queued async write: poll the file until it holds
// the expected state, bounded.
async function until(pred, ms) {
  var deadline = Date.now() + (ms || 4000);
  for (;;) {
    var subs = readSubs();
    if (subs && pred(subs)) return subs;
    if (Date.now() > deadline) throw new Error("push-subs.json never reached the expected state");
    await new Promise(function (resolve) { setTimeout(resolve, 10); });
  }
}

test("an unauthenticated subscribe is refused with 401 and nothing is stored", async function () {
  var res = await H.request("POST", "/api/push-subscribe", null, { subscription: { endpoint: "https://push.invalid/anon" } });
  assert.equal(res.status, 401);
  // The server's own startup write has landed once the file exists; a refused
  // subscribe never enqueues a write, so the file cannot hold the endpoint.
  var subs = await until(function () { return true; });
  assert.equal(subs.some(function (s) { return s.endpoint === "https://push.invalid/anon"; }), false);
});

test("an authenticated subscribe is stored with the user", async function () {
  var res = await H.request("POST", "/api/push-subscribe", "alice", { subscription: { endpoint: "https://push.invalid/alice-phone" } });
  assert.equal(res.status, 200);
  var subs = await until(function (list) {
    return list.some(function (s) { return s.endpoint === "https://push.invalid/alice-phone"; });
  });
  var stored = subs.filter(function (s) { return s.endpoint === "https://push.invalid/alice-phone"; })[0];
  assert.equal(stored._userId, H.people.alice.id);
});

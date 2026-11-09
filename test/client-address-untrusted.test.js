// trustedProxy off: X-Forwarded-For is ignored, so the login bucket and the
// audit record key on the peer address, as before.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var harness = require("./access-harness");

var H = null;

test.before(async function () {
  H = await harness.start({ users: [{ key: "a", username: "alice" }] });
});

test.after(async function () {
  if (H) await H.stop();
});

function login(username, forwarded) {
  return H.request("POST", "/auth/login", null, { username: username, pin: "0000" }, { "X-Forwarded-For": forwarded });
}

test("trustedProxy off: the bucket and audit key on the peer", async function () {
  // A different user each time so the per-user backoff never answers first.
  for (var i = 0; i < 5; i++) await login("nobody" + i, "203.0.113.7");
  assert.equal((await login("fresh", "198.51.100.9")).status, 429);
  var file = path.join(H.home, "console", "audit.log");
  var hits = [];
  for (var t = 0; t < 50 && !hits.length; t++) {
    await new Promise(function (r) { setTimeout(r, 20); });
    if (!fs.existsSync(file)) continue;
    hits = fs.readFileSync(file, "utf8").trim().split("\n").map(function (l) { return JSON.parse(l); })
      .filter(function (e) { return e.action === "auth.lockout"; });
  }
  assert.equal(hits.length, 1);
  assert.equal(hits[0].metadata.ip, "127.0.0.1");
});

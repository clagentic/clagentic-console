// Client address and locality of a request behind a same-host proxy: the
// helper's table, then the rate-limit/audit and websocket sites through a real
// server.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var harness = require("./access-harness");
var { resolveClientAddress } = require("../lib/client-address");

function req(peer, headers) {
  return { headers: headers || {}, socket: { remoteAddress: peer } };
}

test("helper: address by trustedProxy and X-Forwarded-For shape", function () {
  var table = [
    [true, { "x-forwarded-for": "203.0.113.7" }, "203.0.113.7"],
    [true, { "x-forwarded-for": " 2001:db8::1 " }, "2001:db8::1"],
    [true, { "x-forwarded-for": "203.0.113.7, 198.51.100.2" }, "127.0.0.1"],
    [true, { "x-forwarded-for": "not-an-ip" }, "127.0.0.1"],
    [true, { "x-forwarded-for": "" }, "127.0.0.1"],
    [true, {}, "127.0.0.1"],
    [false, { "x-forwarded-for": "203.0.113.7" }, "127.0.0.1"],
  ];
  table.forEach(function (row) {
    assert.equal(resolveClientAddress(req("127.0.0.1", row[1]), row[0]).address, row[2], JSON.stringify(row));
  });
});

test("helper: local needs a loopback peer and no forwarding header", function () {
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].forEach(function (peer) {
    assert.equal(resolveClientAddress(req(peer), false).local, true);
    assert.equal(resolveClientAddress(req(peer), true).local, true);
  });
  assert.equal(resolveClientAddress(req("192.0.2.9"), true).local, false);
  ["x-forwarded-for", "forwarded", "x-real-ip"].forEach(function (h) {
    var headers = {};
    headers[h] = "203.0.113.7";
    assert.equal(resolveClientAddress(req("127.0.0.1", headers), false).local, false, h);
    assert.equal(resolveClientAddress(req("127.0.0.1", headers), true).local, false, h);
  });
});

// Each attempt names a different user so the per-user backoff never answers
// before the per-address counter reaches its limit.
async function lockOut(H, forwarded) {
  var last;
  for (var i = 0; i < 5; i++) {
    last = await H.request("POST", "/auth/login", null, { username: "nobody" + i, pin: "0000" }, forwarded ? { "X-Forwarded-For": forwarded } : {});
  }
  return last;
}

function auditEntries(home) {
  var file = path.join(home, "console", "audit.log");
  return fs.readFileSync(file, "utf8").trim().split("\n").map(function (l) { return JSON.parse(l); });
}

async function waitForLockout(home, ip) {
  for (var i = 0; i < 50; i++) {
    try {
      var hit = auditEntries(home).filter(function (e) { return e.action === "auth.lockout" && e.metadata.ip === ip; });
      if (hit.length) return hit;
    } catch (e) { /* log not written yet */ }
    await new Promise(function (r) { setTimeout(r, 20); });
  }
  return [];
}

// One server per file: lib/ reads its data directory once, at first require.
var H = null;

test.before(async function () {
  H = await harness.start({
    users: [{ key: "a", username: "alice" }],
    projects: [{ slug: "p", ownerKey: "a" }],
    serverOpts: { trustedProxy: true },
  });
});

test.after(async function () {
  if (H) await H.stop();
});

test("trustedProxy on: forwarded clients get separate buckets and the audit names them", async function () {
  await lockOut(H, "203.0.113.7");
  var locked = await H.request("POST", "/auth/login", null, { username: "nobody-x", pin: "0000" }, { "X-Forwarded-For": "203.0.113.7" });
  assert.equal(locked.status, 429);
  var other = await H.request("POST", "/auth/login", null, { username: "fresh", pin: "0000" }, { "X-Forwarded-For": "198.51.100.9" });
  assert.equal(other.status, 401);
  assert.equal((await waitForLockout(H.home, "203.0.113.7")).length, 1);
});

test("a proxied websocket is not local; a direct one is", async function () {
  var seen = [];
  H.relay.forEachProject(function (ctx) {
    var original = ctx.handleConnection;
    ctx.handleConnection = function (ws) {
      seen.push(ws._clagenticLocal);
      return original.apply(ctx, arguments);
    };
  });
  var direct = await H.connect("p", "a");
  var proxied = await H.connect("p", "a", { headers: { "X-Forwarded-For": "203.0.113.7" } });
  assert.equal(direct.ok && proxied.ok, true);
  assert.deepEqual(seen, [true, false]);
});

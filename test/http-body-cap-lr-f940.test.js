/**
 * Regression test for lr-f940 (N2, top-3): unauthenticated HTTP body
 * accumulation with no size cap.
 *
 * lib/server-auth.js (6 sites: /recover/:urlPath, /auth/setup, /auth/login,
 * /auth/request-otp, /auth/verify-otp, /auth/register) and lib/server.js's
 * /api/push-subscribe all used a bare `body += chunk` accumulator with no
 * limit — every one of these routes is reachable before any auth check
 * succeeds, so a single client could stream an arbitrarily large body into a
 * growing string, and N parallel requests multiply the cost.
 * lib/project-http.js already had the correct hardCap + req.destroy()
 * pattern for uploads; this test covers the shared generalization of that
 * pattern, lib/utils.js's readCappedBody(), which server-auth.js and
 * server.js now both call instead of hand-rolling the unbounded version.
 *
 * Drives the real production readCappedBody() against a minimal req stub
 * (EventEmitter + a destroy() spy) — no reimplementation of the cap logic.
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var { EventEmitter } = require("events");

var { readCappedBody, DEFAULT_BODY_CAP_BYTES } = require("../lib/utils");

function makeReq() {
  var req = new EventEmitter();
  req.destroyed = false;
  req.destroy = function () { req.destroyed = true; };
  return req;
}

test("lr-f940: readCappedBody resolves with the full body when under the cap", function () {
  var req = makeReq();
  var promise = readCappedBody(req, 1000);
  req.emit("data", Buffer.from('{"a":1}'));
  req.emit("end");
  return promise.then(function (body) {
    assert.equal(body, '{"a":1}');
    assert.equal(req.destroyed, false, "destroy() must not be called for an in-cap body");
  });
});

test("lr-f940: readCappedBody rejects and destroys the connection once the cap is exceeded", function () {
  var req = makeReq();
  var cap = 16; // small cap for a fast, deterministic test
  var promise = readCappedBody(req, cap);
  var caught = null;
  var settled = promise.catch(function (err) { caught = err; });

  // First chunk fits; second chunk pushes bodyBytes past the cap.
  req.emit("data", Buffer.from("0123456789")); // 10 bytes, under cap
  req.emit("data", Buffer.from("0123456789")); // +10 = 20 bytes, over cap
  // A well-behaved caller must not still fire "end" after destroy(), but even
  // if it did, the accumulator must ignore further chunks/end once rejected.
  req.emit("data", Buffer.from("more data that must be ignored"));
  req.emit("end");

  return settled.then(function () {
    assert.ok(caught instanceof Error, "promise must reject once the hard cap is exceeded");
    assert.match(caught.message, /too large/i);
    assert.equal(req.destroyed, true, "req.destroy() must be called so the client connection is dropped, not just internally ignored");
  });
});

test("lr-f940: readCappedBody falls back to the exported default cap when no maxBytes is passed", function () {
  var req = makeReq();
  var promise = readCappedBody(req);
  // Body well under the 1 MB default — must resolve normally.
  req.emit("data", Buffer.from("small login payload"));
  req.emit("end");
  return promise.then(function (body) {
    assert.equal(body, "small login payload");
  });
});

test("lr-f940: exported DEFAULT_BODY_CAP_BYTES is a sane small-JSON-payload limit (not upload-sized)", function () {
  // Sanity bound: this is a cap for login/PIN/OTP/push-subscribe JSON bodies,
  // not file uploads (project-http.js's parseJsonBody already handles the
  // 50 MB upload case separately with its own hardCap) — assert it is well
  // below that upload cap so a regression can't silently widen this to
  // upload-scale and defeat the point of a separate, tighter default.
  assert.ok(DEFAULT_BODY_CAP_BYTES > 0);
  assert.ok(DEFAULT_BODY_CAP_BYTES <= 5 * 1024 * 1024, "default pre-auth JSON body cap should stay well under upload-sized limits");
});

test("lr-f940: readCappedBody rejects on a request 'error' event without hanging", function () {
  var req = makeReq();
  var promise = readCappedBody(req, 1000);
  var caught = null;
  var settled = promise.catch(function (err) { caught = err; });
  req.emit("error", new Error("socket reset"));
  return settled.then(function () {
    assert.ok(caught instanceof Error);
    assert.equal(caught.message, "socket reset");
  });
});

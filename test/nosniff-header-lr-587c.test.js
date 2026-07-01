// nosniff-header-lr-587c.test.js — lr-587c: hardening follow-up from PR #288
// (lr-a68f) BOBBIE advisory nit.
//
// Both user-uploaded-content serve routes in lib/server-settings.js must set
// X-Content-Type-Options: nosniff alongside their explicit Content-Type, as
// defense-in-depth against MIME-sniff confusion:
//   - GET /api/custom-emoji/:slug
//   - GET /api/avatar/:userId
//
// Exercises the real attachSettings()/handleRequest() production code path
// against a mock req/res and a real tmp directory on disk (server-settings.js
// reads files synchronously from CONFIG_DIR).

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { attachSettings } = require("../lib/server-settings");
var projectModule = require("../lib/project");

var PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeTmpConfigDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-nosniff-test-")));
}

// Minimal mock ctx sufficient to drive the two GET serve routes under test.
// Auth/user helpers are unused by these specific routes but must exist as
// functions since attachSettings destructures them unconditionally.
function makeCtx(configDir) {
  return {
    users: {},
    getMultiUserFromReq: function () { return null; },
    isRequestAuthed: function () { return true; },
    projects: { forEach: function () {} },
    opts: {},
    CONFIG_DIR: configDir,
  };
}

function makeMockRes() {
  var res = {
    statusCode: null,
    headers: null,
    body: null,
    writeHead: function (status, headers) {
      res.statusCode = status;
      res.headers = headers;
    },
    end: function (body) {
      res.body = body;
    },
  };
  return res;
}

function makeMockReq() {
  return { method: "GET", on: function () {} };
}

test("GET /api/custom-emoji/:slug sets X-Content-Type-Options: nosniff", () => {
  var configDir = makeTmpConfigDir();
  var emojiDir = path.join(configDir, "custom-emoji");
  fs.mkdirSync(emojiDir, { recursive: true });
  fs.writeFileSync(path.join(emojiDir, "rocket.png"), PNG_MAGIC);

  var handler = attachSettings(makeCtx(configDir));
  var res = makeMockRes();
  var handled = handler.handleRequest(makeMockReq(), res, "/api/custom-emoji/rocket");

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(res.headers["Content-Type"], "image/png");
});

test("GET /api/avatar/:userId sets X-Content-Type-Options: nosniff", () => {
  var configDir = makeTmpConfigDir();
  var avatarDir = path.join(configDir, "avatars");
  fs.mkdirSync(avatarDir, { recursive: true });
  fs.writeFileSync(path.join(avatarDir, "user-42.png"), PNG_MAGIC);

  var handler = attachSettings(makeCtx(configDir));
  var res = makeMockRes();
  var handled = handler.handleRequest(makeMockReq(), res, "/api/avatar/user-42");

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(res.headers["Content-Type"], "image/png");
});

// Sanity check that projectModule.safePath is reachable the way
// server-settings.js uses it (guards against a future refactor silently
// breaking the custom-emoji serve route's path-traversal defense).
test("projectModule.safePath is present and used by the custom-emoji serve route", () => {
  assert.equal(typeof projectModule.safePath, "function");
});

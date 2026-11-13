// Admin routes read their JSON body through the shared capped reader and answer a
// bad body 400, an oversized body 413 and a persistence failure 500.
var test = require("node:test");
var assert = require("node:assert/strict");

var { attachAdmin } = require("../lib/server-admin");
var requestBody = require("../lib/request-body");
var { attachSettings } = require("../lib/server-settings");
var fs = require("fs");
var path = require("path");

function res() {
  var r = { status: null, body: "", heads: [] };
  r.writeHead = function (s) { r.status = s; r.heads.push(s); };
  r.end = function (b, done) { r.body = b || ""; if (done) done(); };
  return r;
}

// Each stub does the harmless thing unless it is the one a row makes throw.
function ctxFor(failing) {
  function stub(name, value) {
    return function () {
      if (failing === name) throw new Error("disk full");
      return typeof value === "function" ? value.apply(null, arguments) : value;
    };
  }
  var admin = { id: "a1", username: "admin", role: "admin" };
  var projectCtx = {
    setProjectOwner: stub("project.setProjectOwner", undefined),
    send: function () {},
  };
  return {
    users: {
      createUserByAdmin: stub("users.createUserByAdmin", { user: { id: "u2", username: "new", displayName: "new", role: "user", linuxUser: "x" }, tempPin: "123456" }),
      updateLinuxUser: stub("users.updateLinuxUser", { ok: true }),
      updateUserPermissions: stub("users.updateUserPermissions", { ok: true, permissions: {} }),
      createInvite: stub("users.createInvite", { code: "c1" }),
      findUserById: stub("users.findUserById", null),
    },
    smtp: {
      isSmtpConfigured: function () { return true; },
      getSmtpConfig: stub("smtp.getSmtpConfig", null),
      saveSmtpConfig: stub("smtp.saveSmtpConfig", undefined),
      sendInviteEmail: function () { return Promise.resolve(); },
      sendTestEmail: function () { return Promise.resolve(); },
    },
    getMultiUserFromReq: function () { return admin; },
    projects: { get: function () { return projectCtx; } },
    onSetProjectVisibility: stub("onSetProjectVisibility", { ok: true }),
    onSetProjectAllowedUsers: stub("onSetProjectAllowedUsers", { ok: true }),
    onGetProjectAccess: function () { return null; },
    onProjectOwnerChanged: function () {},
    osUsers: false,
    portNum: 1,
  };
}

var ADMIN_BODY_ROWS = [
  // [method, url, valid body, the stub that fails to persist]
  ["POST", "/api/admin/users", { username: "new" }, "users.createUserByAdmin"],
  ["PUT", "/api/admin/users/u2/linux-user", { linuxUser: "x" }, "users.updateLinuxUser"],
  ["PUT", "/api/admin/users/u2/permissions", { permissions: {} }, "users.updateUserPermissions"],
  ["POST", "/api/admin/invites/email", { email: "a@example.test" }, "users.createInvite"],
  ["POST", "/api/admin/smtp", { host: "h", user: "u", pass: "p", from: "f" }, "smtp.saveSmtpConfig"],
  ["POST", "/api/admin/smtp/test", { host: "h", user: "u", pass: "p", from: "f" }, "smtp.getSmtpConfig"],
  ["PUT", "/api/admin/projects/p1/visibility", { visibility: "public" }, "onSetProjectVisibility"],
  ["PUT", "/api/admin/projects/p1/owner", { userId: "u2" }, "project.setProjectOwner"],
  ["PUT", "/api/admin/projects/p1/users", { allowedUsers: [] }, "onSetProjectAllowedUsers"],
];

function fakeReq(method, url) {
  var listeners = {};
  var req = {
    method: method,
    url: url,
    headers: {},
    paused: 0,
    destroyed: 0,
    listeners: listeners,
    on: function (evt, fn) { listeners[evt] = fn; },
    pause: function () { req.paused++; },
    destroy: function () { req.destroyed++; },
  };
  return req;
}

function send(handler, row, body) {
  var req = fakeReq(row[0], row[1]);
  var response = res();
  handler(req, response, row[1]);
  req.listeners.data(typeof body === "string" ? body : JSON.stringify(body));
  req.listeners.end();
  return response;
}

test("admin routes: a valid body succeeds, a bad body is a 400, a persistence failure is a logged 500, an oversized body is a 413 and read no further", async function () {
  var realError = console.error;
  for (var i = 0; i < ADMIN_BODY_ROWS.length; i++) {
    var row = ADMIN_BODY_ROWS[i];
    var name = row[0] + " " + row[1];
    var ok = send(attachAdmin(ctxFor(null)).handleRequest, row, row[2]);
    await new Promise(function (r) { setImmediate(r); });
    assert.equal(ok.status, 200, name + ": valid body");

    var handler = attachAdmin(ctxFor(row[3])).handleRequest;
    var logged = [];
    console.error = function () { logged.push(Array.prototype.join.call(arguments, " ")); };
    var failed;
    try {
      failed = send(handler, row, row[2]);
    } finally {
      console.error = realError;
    }
    assert.equal(failed.status, 500, name + ": persistence failure");
    assert.equal(logged.length, 1, name + ": logged once");
    assert.match(logged[0], /disk full/, name);

    assert.equal(send(handler, row, "{not json").status, 400, name + ": unparseable body");
    assert.equal(send(handler, row, []).status, 400, name + ": an array body");

    // Two 40 KiB pieces cross the cap: answered 413 once, the request is paused
    // and closed after the answer, and a later piece or the end does nothing more.
    var req = fakeReq(row[0], row[1]);
    var big = res();
    handler(req, big, row[1]);
    var piece = Buffer.alloc(40 * 1024, 97);
    req.listeners.data(piece);
    assert.deepEqual(big.heads, [], name + ": under the cap nothing is answered yet");
    req.listeners.data(piece);
    assert.deepEqual(big.heads, [413], name + ": over the cap");
    assert.equal(req.paused, 1, name + ": reading stops");
    assert.equal(req.destroyed, 1, name + ": connection closed after the answer");
    req.listeners.data(piece);
    req.listeners.end();
    assert.deepEqual(big.heads, [413], name + ": answered once");
  }
});

test("the SMTP test route keeps its answer for a failed test send", async function () {
  var ctx = ctxFor(null);
  ctx.smtp.sendTestEmail = function () { return Promise.reject(new Error("refused")); };
  var row = ADMIN_BODY_ROWS[5];
  var response = send(attachAdmin(ctx).handleRequest, row, row[2]);
  await new Promise(function (r) { setImmediate(r); });
  assert.equal(response.status, 500);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: "refused" });
});

test("a non-admin caller is refused before the body is read", function () {
  ADMIN_BODY_ROWS.forEach(function (row) {
    var ctx = ctxFor(null);
    ctx.getMultiUserFromReq = function () { return { id: "u9", username: "user", role: "user" }; };
    var req = fakeReq(row[0], row[1]);
    var response = res();
    attachAdmin(ctx).handleRequest(req, response, row[1]);
    assert.equal(response.status, 403, row[0] + " " + row[1]);
    assert.equal(req.listeners.data, undefined, row[1] + ": body not read");
  });
});

test("the body helpers have one definition, shared by the settings and admin modules", function () {
  assert.equal(typeof requestBody.readJsonObjectBody, "function");
  assert.equal(typeof attachSettings, "function");
  ["server-settings.js", "server-admin.js"].forEach(function (file) {
    var src = fs.readFileSync(path.join(__dirname, "..", "lib", file), "utf8");
    assert.doesNotMatch(src, /function (readJsonObjectBody|parseJsonObjectBody|respondPersistFailure)\b/, file);
    assert.doesNotMatch(src, /body \+= chunk/, file);
  });
});

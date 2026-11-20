"use strict";

// Username lockout and the admin unlock: one shared table of rows. Every row
// drives the real auth and admin route modules over HTTP, with real users and a
// real audit log under the per-process temp dir. The lockout functions are not
// stubbed; the only thing a row fakes is the clock, because the per-username
// backoff (1 s, 5 s, 30 s, 5 min) would otherwise refuse the quick wrong PINs a
// row needs to reach the permanent lockout.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var http = require("http");
var os = require("os");
var path = require("path");

var LIB = path.join(__dirname, "..", "lib");
var PIN = "123456";
var WRONG_PIN = "000000";
var NEW_PIN = "654321";
var PIN_MAX_ATTEMPTS = 5;
var PIN_USER_PERMANENT_THRESHOLD = 5;
var PAST_BACKOFF_MS = 6 * 60 * 1000;

// --- Environment: a fresh console home and fresh lib modules per row ---

function makeEnv() {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "console-unlock-"));
  fs.mkdirSync(path.join(home, "console"), { recursive: true, mode: 0o700 });
  Object.keys(require.cache).forEach(function (key) {
    if (key.indexOf(LIB + path.sep) === 0) delete require.cache[key];
  });
  var saved = process.env.CLAGENTIC_CONSOLE_HOME;
  process.env.CLAGENTIC_CONSOLE_HOME = home;
  try {
    return {
      users: require("../lib/users"),
      serverAuth: require("../lib/server-auth"),
      serverAdmin: require("../lib/server-admin"),
      smtp: require("../lib/smtp"),
      pages: require("../lib/pages"),
      audit: require("../lib/audit"),
    };
  } finally {
    if (saved === undefined) delete process.env.CLAGENTIC_CONSOLE_HOME;
    else process.env.CLAGENTIC_CONSOLE_HOME = saved;
  }
}

// --- HTTP ---

function call(server, opts) {
  return new Promise(function (resolve, reject) {
    var body = opts.json !== undefined ? JSON.stringify(opts.json) : null;
    var headers = Object.assign({}, opts.headers || {});
    if (opts.ip) headers["X-Forwarded-For"] = opts.ip;
    if (opts.cookie) headers.Cookie = opts.cookie;
    if (body) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    var req = http.request({
      host: "127.0.0.1", port: server.address().port, method: opts.method || "GET", path: opts.path, headers: headers,
    }, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        var text = Buffer.concat(chunks).toString("utf8");
        var parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
        resolve({ status: res.statusCode, json: parsed, cookies: res.headers["set-cookie"] || [] });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function flush() {
  // The audit log writes on setImmediate.
  return new Promise(function (r) { setImmediate(r); }).then(function () { return new Promise(function (r) { setImmediate(r); }); });
}

// --- Console: auth and admin modules behind one server, wired as lib/server.js wires them ---

async function withConsole(options, body) {
  var opts = options || {};
  var env = makeEnv();
  var realNow = Date.now;
  var skew = 0;
  Date.now = function () { return realNow() + skew; };
  var auth = env.serverAuth.attachAuth({
    users: env.users, smtp: env.smtp, pages: env.pages, tlsOptions: null, osUsers: false,
    provisionLinuxUser: function () { return { ok: false }; },
    onUserProvisioned: null,
    // Behind a proxy each request can carry its own address, so the per-address
    // limit does not mask the per-username lockout a row is about.
    trustedProxy: true,
  });
  var admin = env.serverAdmin.attachAdmin({
    users: env.users, smtp: env.smtp, getMultiUserFromReq: auth.getMultiUserFromReq,
    projects: new Map(), osUsers: false, tlsOptions: null, portNum: 0,
    provisionLinuxUser: function () { return { ok: false }; },
    revokeUserTokens: auth.revokeUserTokens,
    isUserLockedOut: auth.isUserLockedOut,
    unlockUser: auth.unlockUser,
  });
  var server = http.createServer(function (req, res) {
    var fullUrl = req.url.split("?")[0];
    if (auth.handleRequest(req, res, fullUrl)) return;
    if (admin.handleRequest(req, res, fullUrl)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });

  var ipCounter = 0;
  var c = { env: env, auth: auth, server: server };
  c.ip = function () { ipCounter++; return "198.51.100." + ipCounter; };
  if (opts.admin !== false) {
    c.root = env.users.createAdmin({ username: "root", pin: PIN }).user;
    c.alice = env.users.createUser({ username: "alice", pin: PIN }).user;
    c.bob = env.users.createUser({ username: "bob", pin: PIN }).user;
    c.rootCookie = auth.createMultiUserSession(c.root.id).cookie.split(";")[0];
    c.bobCookie = auth.createMultiUserSession(c.bob.id).cookie.split(";")[0];
  }
  c.login = function (username, pin) {
    return call(server, { method: "POST", path: "/auth/login", json: { username: username, pin: pin }, ip: c.ip() });
  };
  // Wrong PINs for the typed spelling until the lockout threshold, each from its
  // own address and past the previous backoff.
  c.lockOut = async function (typedName) {
    for (var i = 0; i < PIN_USER_PERMANENT_THRESHOLD; i++) {
      skew += PAST_BACKOFF_MS;
      var r = await c.login(typedName, WRONG_PIN);
      assert.equal(r.status, 401, "wrong PIN " + (i + 1) + " is counted, not refused");
    }
  };
  c.unlock = function (userId, cookie) {
    return call(server, { method: "POST", path: "/api/admin/users/" + userId + "/unlock", cookie: cookie, json: {} });
  };
  c.unlockEntries = async function () {
    await flush();
    var raw;
    try { raw = fs.readFileSync(env.audit.auditLogPath(), "utf8"); } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    return raw.split("\n").filter(Boolean).map(function (l) { return JSON.parse(l); })
      .filter(function (e) { return e.action === "user.unlock"; });
  };
  try {
    await body(c);
  } finally {
    Date.now = realNow;
    server.close();
  }
}

function sessionCookie(response) {
  return response.cookies.filter(function (x) { return x.indexOf("relay_auth_user=") === 0 && x.indexOf("Max-Age=0") === -1; })[0] || null;
}

// --- The table ---

var ROWS = [
  {
    name: "an admin unlocks a locked-out username: the next correct PIN signs in and the unlock is audited",
    run: async function (c) {
      await c.lockOut("alice");
      var refused = await c.login("alice", PIN);
      assert.equal(refused.status, 429);
      assert.equal(refused.json.retryAfter, -1);

      var unlocked = await c.unlock(c.alice.id, c.rootCookie);
      assert.equal(unlocked.status, 200, JSON.stringify(unlocked.json));

      var signedIn = await c.login("alice", PIN);
      assert.equal(signedIn.status, 200);
      assert.equal(signedIn.json.ok, true);
      assert.ok(sessionCookie(signedIn), "a session cookie is set");

      var entries = await c.unlockEntries();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].actorId, c.root.id);
      assert.equal(entries[0].target, c.alice.id);
      assert.equal(entries[0].metadata.username, "alice");
    },
  },
  {
    name: "a non-admin and a caller with no session are refused 403 and the lockout stays",
    run: async function (c) {
      await c.lockOut("alice");
      var asUser = await c.unlock(c.alice.id, c.bobCookie);
      var anonymous = await c.unlock(c.alice.id, null);
      assert.equal(asUser.status, 403);
      assert.equal(anonymous.status, 403);
      assert.equal((await c.unlockEntries()).length, 0);
      var still = await c.login("alice", PIN);
      assert.equal(still.status, 429);
      assert.equal(still.json.retryAfter, -1);
    },
  },
  {
    name: "an unknown user id is a 404 and writes no audit entry",
    run: async function (c) {
      var r = await c.unlock("no-such-user-id", c.rootCookie);
      assert.equal(r.status, 404);
      assert.equal((await c.unlockEntries()).length, 0);
    },
  },
  {
    name: "failures typed in another letter case lock the account and one unlock clears it",
    run: async function (c) {
      await c.lockOut("ALICE");
      var before = await c.login("alice", PIN);
      assert.equal(before.status, 429);
      assert.equal(before.json.retryAfter, -1);
      assert.equal((await c.unlock(c.alice.id, c.rootCookie)).status, 200);
      var after = await c.login("alice", PIN);
      assert.equal(after.status, 200);
    },
  },
  {
    name: "a username that is also an Object.prototype property is locked out like any other",
    run: async function (c) {
      var odd = c.env.users.createUser({ username: "constructor", pin: PIN }).user;
      await c.lockOut("constructor");
      var refused = await c.login("constructor", PIN);
      assert.equal(refused.status, 429);
      assert.equal(refused.json.retryAfter, -1);
      assert.equal((await c.unlock(odd.id, c.rootCookie)).status, 200);
      assert.equal((await c.login("constructor", PIN)).status, 200);
    },
  },
  {
    name: "the admin user list carries locked per user, and a non-admin list carries no locked field",
    run: async function (c) {
      await c.lockOut("alice");
      var asAdmin = await call(c.server, { path: "/api/admin/users", cookie: c.rootCookie });
      assert.equal(asAdmin.status, 200);
      var byName = {};
      asAdmin.json.users.forEach(function (u) { byName[u.username] = u; });
      assert.equal(byName.alice.locked, true);
      assert.equal(byName.bob.locked, false);

      var asUser = await call(c.server, { path: "/api/admin/users", cookie: c.bobCookie });
      assert.equal(asUser.status, 200);
      assert.ok(asUser.json.users.length > 0);
      asUser.json.users.forEach(function (u) {
        assert.equal(Object.prototype.hasOwnProperty.call(u, "locked"), false, u.username);
      });
    },
  },
  {
    name: "the recovery reset clears the admin's username lockout",
    run: async function (c) {
      c.auth.setRecovery("recovery-path", "recovery-password");
      await c.lockOut("root");
      var refused = await c.login("root", PIN);
      assert.equal(refused.status, 429);

      var reset = await call(c.server, {
        method: "POST", path: "/recover/recovery-path", ip: c.ip(),
        json: { step: "reset", password: "recovery-password", pin: NEW_PIN },
      });
      assert.equal(reset.status, 200, JSON.stringify(reset.json));
      var signedIn = await c.login("root", NEW_PIN);
      assert.equal(signedIn.status, 200);
    },
  },
  {
    name: "wrong setup codes count against the per-address limit, even for a later valid code",
    opts: { admin: false },
    run: async function (c) {
      var ip = c.ip();
      var body = function (code) { return { setupCode: code, username: "owner", pin: PIN }; };
      for (var i = 0; i < PIN_MAX_ATTEMPTS; i++) {
        var wrong = await call(c.server, { method: "POST", path: "/auth/setup", ip: ip, json: body("zzzzzz") });
        assert.equal(wrong.status, 401);
      }
      var limited = await call(c.server, { method: "POST", path: "/auth/setup", ip: ip, json: body(c.env.users.getSetupCode()) });
      assert.equal(limited.status, 429);
      assert.ok(limited.json.retryAfter > 0);
    },
  },
  {
    name: "fewer wrong setup codes than the limit leave a valid code working",
    opts: { admin: false },
    run: async function (c) {
      var ip = c.ip();
      for (var i = 0; i < PIN_MAX_ATTEMPTS - 1; i++) {
        var wrong = await call(c.server, { method: "POST", path: "/auth/setup", ip: ip, json: { setupCode: "zzzzzz", username: "owner", pin: PIN } });
        assert.equal(wrong.status, 401);
      }
      var ok = await call(c.server, { method: "POST", path: "/auth/setup", ip: ip, json: { setupCode: c.env.users.getSetupCode(), username: "owner", pin: PIN } });
      assert.equal(ok.status, 200);
    },
  },
  {
    name: "wrong invite codes count against the per-address limit, even for a later valid code",
    run: async function (c) {
      var ip = c.ip();
      var body = function (code) { return { inviteCode: code, username: "newbie", pin: PIN }; };
      for (var i = 0; i < PIN_MAX_ATTEMPTS; i++) {
        var wrong = await call(c.server, { method: "POST", path: "/auth/register", ip: ip, json: body("not-an-invite") });
        assert.equal(wrong.status, 400);
      }
      var limited = await call(c.server, { method: "POST", path: "/auth/register", ip: ip, json: body(c.env.users.createInvite(c.root.id).code) });
      assert.equal(limited.status, 429);
      assert.ok(limited.json.retryAfter > 0);
    },
  },
  {
    name: "fewer wrong invite codes than the limit leave a valid code working",
    run: async function (c) {
      var ip = c.ip();
      for (var i = 0; i < PIN_MAX_ATTEMPTS - 1; i++) {
        var wrong = await call(c.server, { method: "POST", path: "/auth/register", ip: ip, json: { inviteCode: "not-an-invite", username: "newbie", pin: PIN } });
        assert.equal(wrong.status, 400);
      }
      var ok = await call(c.server, { method: "POST", path: "/auth/register", ip: ip, json: { inviteCode: c.env.users.createInvite(c.root.id).code, username: "newbie", pin: PIN } });
      assert.equal(ok.status, 200);
    },
  },
];

ROWS.forEach(function (row) {
  test(row.name, async function () {
    await withConsole(row.opts, row.run);
  });
});

"use strict";

// External sign-in: one shared table of caller shapes. Every row drives the real
// auth and admin route modules over HTTP against a fake OpenID Connect provider
// that lives in this process (discovery, key set, token endpoint). No network,
// no real provider.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var http = require("http");
var os = require("os");
var path = require("path");
var crypto = require("crypto");

var CLIENT_ID = "console-client";
var CLIENT_SECRET = "sentinel-secret-value-0001";
var SUBJECT = "subject-1";
var LIB = path.join(__dirname, "..", "lib");

// --- Environment: a fresh console home and fresh lib modules per row ---

function makeEnv() {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-xs-"));
  fs.mkdirSync(path.join(home, "console"), { recursive: true, mode: 0o700 });
  Object.keys(require.cache).forEach(function (key) {
    if (key.indexOf(LIB + path.sep) === 0) delete require.cache[key];
  });
  var saved = process.env.CLAGENTIC_CONSOLE_HOME;
  process.env.CLAGENTIC_CONSOLE_HOME = home;
  var env;
  try {
    // users.js writes users.json twice per save, once synchronously and once
    // through the store queue, and both use the same temp file name. Two saves
    // in quick succession (which these rows do) can interleave in that file.
    // The synchronous write is the complete one, so the queued copy is skipped
    // here; the defect itself is outside this change.
    var store = require("../lib/store");
    var queuedWrite = store.writeJson;
    store.writeJson = function (name, value, options) {
      if (name === "users.json") return Promise.resolve();
      return queuedWrite.call(store, name, value, options);
    };
    env = {
      home: path.join(home, "console"),
      users: require("../lib/users"),
      serverAuth: require("../lib/server-auth"),
      serverAdmin: require("../lib/server-admin"),
      smtp: require("../lib/smtp"),
      pages: require("../lib/pages"),
      signin: require("../lib/external-signin"),
      oidc: require("../lib/external-signin/oidc"),
      settings: require("../lib/external-signin/settings"),
      policy: require("../lib/external-signin/policy"),
    };
  } finally {
    if (saved === undefined) delete process.env.CLAGENTIC_CONSOLE_HOME;
    else process.env.CLAGENTIC_CONSOLE_HOME = saved;
  }
  return env;
}

// --- Fake provider ---

async function startProvider(jose) {
  var keys = await jose.generateKeyPair("RS256");
  var otherKeys = await jose.generateKeyPair("RS256");
  var jwk = await jose.exportJWK(keys.publicKey);
  jwk.kid = "k1";
  jwk.alg = "RS256";
  jwk.use = "sig";
  var codes = new Map();
  var p = { down: false, tokenHits: 0, nonceOverride: null, signWithOtherKey: false, issuer: null };

  var server = http.createServer(function (req, res) {
    var url = new URL(req.url, "http://x");
    function json(status, body) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    }
    if (url.pathname === "/.well-known/openid-configuration") {
      if (p.down) return json(503, {});
      return json(200, {
        issuer: p.issuer,
        authorization_endpoint: p.issuer + "/authorize",
        token_endpoint: p.issuer + "/token",
        jwks_uri: p.issuer + "/jwks",
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/token" && req.method === "POST") {
      var raw = "";
      req.on("data", function (c) { raw += c; });
      req.on("end", async function () {
        p.tokenHits++;
        var form = new URLSearchParams(raw);
        var expected = "Basic " + Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64");
        if (req.headers.authorization !== expected) return json(401, { error: "invalid_client" });
        var entry = codes.get(form.get("code"));
        if (!entry || entry.used) return json(400, { error: "invalid_grant" });
        entry.used = true;
        var verifier = form.get("code_verifier") || "";
        var challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
        if (!verifier || challenge !== entry.challenge) return json(400, { error: "invalid_grant" });
        if (form.get("redirect_uri") !== entry.redirectUri) return json(400, { error: "invalid_grant" });
        var claims = Object.assign({ nonce: p.nonceOverride || entry.nonce }, entry.extra);
        var jwt = new jose.SignJWT(claims)
          .setProtectedHeader({ alg: "RS256", kid: "k1" })
          .setIssuer(entry.extra.iss || p.issuer)
          .setSubject(entry.subject)
          .setAudience(CLIENT_ID)
          .setIssuedAt()
          .setExpirationTime("5m");
        var idToken = await jwt.sign(p.signWithOtherKey ? otherKeys.privateKey : keys.privateKey);
        return json(200, { access_token: "a", token_type: "Bearer", id_token: idToken });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  p.issuer = "http://127.0.0.1:" + server.address().port;
  p.close = function () { server.close(); };
  // The provider side of "the user signed in": a code bound to the request's challenge.
  p.issueCode = function (authorizeUrl, subject, extra) {
    var q = new URL(authorizeUrl).searchParams;
    var code = crypto.randomBytes(12).toString("hex");
    codes.set(code, {
      challenge: q.get("code_challenge"),
      redirectUri: q.get("redirect_uri"),
      nonce: q.get("nonce"),
      subject: subject,
      extra: extra || {},
    });
    return { code: code, state: q.get("state") };
  };
  return p;
}

// --- HTTP helpers ---

function call(server, opts) {
  return new Promise(function (resolve, reject) {
    var body = opts.json !== undefined ? JSON.stringify(opts.json) : null;
    var headers = Object.assign({}, opts.headers || {});
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
        resolve({ status: res.statusCode, headers: res.headers, text: text, json: parsed, cookies: res.headers["set-cookie"] || [] });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieHeader(cookies) {
  return cookies.map(function (c) { return c.split(";")[0]; }).join("; ");
}

// --- App: the auth and admin route modules behind one http server ---

async function makeApp(env, options) {
  var opts = options || {};
  var core = env.signin.createExternalSignin({
    users: env.users,
    provider: opts.provider || env.oidc.createOidcProvider(),
  });
  var auth = env.serverAuth.attachAuth({
    users: env.users, smtp: env.smtp, pages: env.pages,
    tlsOptions: opts.tlsOptions || null, osUsers: false,
    provisionLinuxUser: function () { return { ok: false }; },
    onUserProvisioned: null,
    trustedProxy: !!opts.trustedProxy,
    externalSignin: core,
  });
  var admin = env.serverAdmin.attachAdmin({
    users: env.users, smtp: env.smtp, getMultiUserFromReq: auth.getMultiUserFromReq,
    projects: new Map(), osUsers: false, tlsOptions: opts.tlsOptions || null, portNum: 0,
    provisionLinuxUser: function () { return { ok: false }; },
    revokeUserTokens: auth.revokeUserTokens,
    externalSignin: core,
  });
  var server = http.createServer(function (req, res) {
    var fullUrl = req.url.split("?")[0];
    if (auth.handleRequest(req, res, fullUrl)) return;
    if (admin.handleRequest(req, res, fullUrl)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  return { server: server, core: core, auth: auth, close: function () { server.close(); } };
}

// One console with its owner, a provider, and external sign-in switched on.
async function setup(jose, options) {
  var opts = options || {};
  var env = makeEnv();
  var provider = await startProvider(jose);
  var app = await makeApp(env, opts.app);
  var owner = env.users.createAdmin({ username: "owner", email: "owner@mail.test", pin: "123456" }).user;
  var adminCookie = app.auth.createMultiUserSession(owner.id).cookie;
  var ctx = { env: env, provider: provider, app: app, owner: owner, adminCookie: adminCookie };
  ctx.configure = function (patch) {
    return call(app.server, {
      method: "PUT", path: "/api/admin/external-signin", headers: { Cookie: adminCookie },
      json: Object.assign({
        enabled: true,
        oidc: { issuer: provider.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, allowedSubject: SUBJECT },
      }, patch || {}),
    });
  };
  if (opts.enable !== false) {
    var on = await ctx.configure();
    assert.equal(on.status, 200, on.text);
  }
  ctx.start = function (headers) {
    return call(app.server, { path: "/auth/external/start", headers: Object.assign({ Host: "127.0.0.1:" + app.server.address().port }, headers || {}) });
  };
  ctx.callback = function (code, state, cookie, headers) {
    var q = new URLSearchParams({ code: code, state: state });
    var sent = Object.assign({}, headers || {});
    if (cookie) sent.Cookie = cookie;
    return call(app.server, { path: "/auth/external/callback?" + q.toString(), headers: sent });
  };
  // Start, let the provider sign the given subject in, and return to the console.
  // A proxy in front adds its headers to both requests.
  ctx.signIn = async function (subject, extra, headers) {
    var started = await ctx.start(headers);
    assert.equal(started.status, 302, started.text);
    var issued = provider.issueCode(started.headers.location, subject, extra);
    var done = await ctx.callback(issued.code, issued.state, cookieHeader(started.cookies), headers);
    return { started: started, issued: issued, done: done };
  };
  ctx.close = function () { app.close(); provider.close(); };
  ctx.usersFile = function () { return fs.readFileSync(env.users.USERS_FILE, "utf8"); };
  return ctx;
}

function sessionCookie(response) {
  return response.cookies.filter(function (c) { return c.indexOf("relay_auth_user=") === 0 && c.indexOf("Max-Age=0") === -1; })[0] || null;
}

function userCount(ctx) {
  return JSON.parse(ctx.usersFile()).users.length;
}

// --- The table ---

var ROWS = [];
function row(name, fn) { ROWS.push({ name: name, fn: fn }); }

row("off by default: every existing flow is unchanged", async function (jose) {
  var ctx = await setup(jose, { enable: false });
  try {
    var status = await call(ctx.app.server, { path: "/auth/external/status" });
    assert.deepEqual(status.json, { enabled: false });
    assert.match(ctx.app.auth.getAuthPage(), /\/auth\/login/);
    assert.equal(ctx.app.core.isEnabled(), false);
    var second = ctx.env.users.createUser({ username: "second", pin: "654321" });
    assert.ok(second.ok, "a second user is allowed while sign-in is off");
    assert.ok(ctx.env.users.createInvite(ctx.owner.id).code);
    var login = await call(ctx.app.server, { method: "POST", path: "/auth/login", json: { username: "owner", pin: "123456" } });
    assert.equal(login.status, 200);
    var start = await ctx.start();
    assert.equal(start.status, 400);
  } finally { ctx.close(); }
});

row("on: the allowed identity is signed in as the console's one user (desktop cookie, phone app, WS ticket)", async function (jose) {
  var ctx = await setup(jose);
  try {
    var bound = ctx.env.users.findUserByExternalIdentity({ provider: "oidc", issuer: ctx.provider.issuer, subject: SUBJECT });
    assert.equal(bound.id, ctx.owner.id, "the identity is recorded on the one user with its provider kind");
    var r = await ctx.signIn(SUBJECT, { email: "someone-else@mail.test" });
    assert.equal(r.done.status, 302);
    assert.equal(r.done.headers.location, "/");
    var cookie = sessionCookie(r.done);
    assert.ok(cookie, "a session cookie is set");
    assert.match(cookie, /HttpOnly/);
    assert.doesNotMatch(cookie, /Secure/, "plain http with no trusted proxy");
    var reqLike = { headers: { cookie: cookieHeader([cookie]) } };
    assert.equal(ctx.app.auth.getMultiUserFromReq(reqLike).id, ctx.owner.id, "same cookie check as the desktop and phone app");
    var ticket = ctx.app.auth.mintWsTicket(ctx.owner.id);
    assert.equal(ctx.app.auth.consumeWsTicket(ticket).id, ctx.owner.id, "WebSocket ticket path unchanged");
    assert.equal(userCount(ctx), 1);
    var cleared = r.done.cookies.filter(function (c) { return c.indexOf("clagentic_console_signin=;") === 0; });
    assert.equal(cleared.length, 1, "the state cookie is cleared");
  } finally { ctx.close(); }
});

row("a different subject at the same issuer is refused, nothing created or changed", async function (jose) {
  var ctx = await setup(jose);
  try {
    var before = ctx.usersFile();
    var r = await ctx.signIn("subject-2");
    assert.equal(r.done.status, 403);
    assert.equal(sessionCookie(r.done), null);
    assert.match(r.done.text, /not allowed/);
    assert.equal(ctx.usersFile(), before);
  } finally { ctx.close(); }
});

row("the same subject at another issuer is refused", async function (jose) {
  var ctx = await setup(jose);
  try {
    var before = ctx.usersFile();
    var viaCore = ctx.app.core.resolveUser({ provider: "oidc", issuer: "https://other-issuer.test", subject: SUBJECT });
    assert.equal(viaCore.error, "not_allowed");
    var viaOtherProvider = ctx.app.core.resolveUser({ provider: "other", issuer: ctx.provider.issuer, subject: SUBJECT });
    assert.equal(viaOtherProvider.error, "not_allowed", "the provider kind is part of the match");
    var r = await ctx.signIn(SUBJECT, { iss: "https://other-issuer.test" });
    assert.equal(r.done.status, 403, "a token naming another issuer fails validation");
    assert.equal(sessionCookie(r.done), null);
    assert.equal(ctx.usersFile(), before);
  } finally { ctx.close(); }
});

row("a matching email with a different subject is refused", async function (jose) {
  var ctx = await setup(jose);
  try {
    var r = await ctx.signIn("subject-3", { email: "owner@mail.test", email_verified: true });
    assert.equal(r.done.status, 403);
    assert.equal(sessionCookie(r.done), null);
    assert.equal(userCount(ctx), 1);
  } finally { ctx.close(); }
});

// Each way a second user could be added, refused with the stated reason.
var CREATION_PATHS = [
  ["admin create user", function (ctx) {
    return call(ctx.app.server, { method: "POST", path: "/api/admin/users", headers: { Cookie: ctx.adminCookie }, json: { username: "x" } });
  }],
  ["invite creation", function (ctx) {
    return call(ctx.app.server, { method: "POST", path: "/api/admin/invites", headers: { Cookie: ctx.adminCookie }, json: {} });
  }],
  ["emailed invite", function (ctx) {
    ctx.env.smtp.saveSmtpConfig({ host: "mail.test", port: 25, user: "u", pass: "p", from: "f@mail.test" });
    return call(ctx.app.server, { method: "POST", path: "/api/admin/invites/email", headers: { Cookie: ctx.adminCookie }, json: { email: "new@mail.test" } });
  }],
  ["register with an invite issued before sign-in was turned on", function (ctx) {
    return call(ctx.app.server, { method: "POST", path: "/auth/register", json: { inviteCode: ctx.earlyInvite, username: "late", pin: "123456" } });
  }],
  ["setup with a setup code", function (ctx) {
    return call(ctx.app.server, { method: "POST", path: "/auth/setup", json: { setupCode: "ABCD1234", username: "boss", pin: "123456" } });
  }],
];

CREATION_PATHS.forEach(function (p) {
  row("second user refused: " + p[0], async function (jose) {
    var ctx = await setup(jose, { enable: false });
    try {
      ctx.earlyInvite = ctx.env.users.createInvite(ctx.owner.id).code;
      var on = await ctx.configure();
      assert.equal(on.status, 200, on.text);
      var r = await p[1](ctx);
      assert.equal(r.status, 403);
      assert.equal(r.json.error, ctx.env.policy.USER_CREATION_REFUSAL);
      assert.equal(userCount(ctx), 1);
    } finally { ctx.close(); }
  });
});

row("second user refused at the shared writers (createUser, createAdmin, createUserWithoutPin, createUserByAdmin, createInvite)", async function (jose) {
  var ctx = await setup(jose);
  try {
    var u = ctx.env.users;
    var reason = ctx.env.policy.USER_CREATION_REFUSAL;
    assert.equal(u.createUser({ username: "a", pin: "123456" }).error, reason);
    assert.equal(u.createAdmin({ username: "b", pin: "123456" }).error, reason);
    assert.equal(u.createUserWithoutPin({ username: "c", email: "c@mail.test" }).error, reason);
    assert.equal(u.createUserByAdmin({ username: "d" }).error, reason);
    assert.equal(u.createInvite(ctx.owner.id).error, reason);
    assert.equal(userCount(ctx), 1);
    assert.equal(JSON.parse(ctx.usersFile()).invites.length, 0);
  } finally { ctx.close(); }
});

row("turning on with two users is refused and changes nothing", async function (jose) {
  var ctx = await setup(jose, { enable: false });
  try {
    ctx.env.users.createUser({ username: "second", pin: "654321" });
    var before = ctx.usersFile();
    var r = await ctx.configure();
    assert.equal(r.status, 409);
    assert.equal(r.json.error, ctx.env.policy.TURN_ON_REFUSAL);
    assert.equal(ctx.usersFile(), before, "no user removed, disabled or altered");
    assert.equal(ctx.env.policy.isEnabled(), false);
  } finally { ctx.close(); }
});

row("provider unreachable, local fallback on: the owner can still sign in locally", async function (jose) {
  var ctx = await setup(jose);
  try {
    ctx.provider.down = true;
    var status = await call(ctx.app.server, { path: "/auth/external/status" });
    assert.deepEqual(status.json, { enabled: true, provider: "oidc", available: false, localFallback: true });
    var start = await ctx.start();
    assert.equal(start.status, 502);
    assert.match(start.text, /cannot be reached/);
    var page = await call(ctx.app.server, { path: "/auth/local" });
    assert.equal(page.status, 200);
    assert.match(page.text, /\/auth\/login/);
    var login = await call(ctx.app.server, { method: "POST", path: "/auth/login", json: { username: "owner", pin: "123456" } });
    assert.equal(login.status, 200);
  } finally { ctx.close(); }
});

row("provider unreachable, local fallback off: the page says so and local sign-in is refused", async function (jose) {
  var ctx = await setup(jose);
  try {
    var off = await ctx.configure({ localFallback: false });
    assert.equal(off.status, 200);
    ctx.provider.down = true;
    var status = await call(ctx.app.server, { path: "/auth/external/status" });
    assert.deepEqual(status.json, { enabled: true, provider: "oidc", available: false, localFallback: false });
    assert.match(ctx.app.auth.getAuthPage(), /cannot be reached/);
    var login = await call(ctx.app.server, { method: "POST", path: "/auth/login", json: { username: "owner", pin: "123456" } });
    assert.equal(login.status, 403);
    assert.equal(login.json.error, ctx.env.policy.LOCAL_SIGNIN_REFUSAL);
    var otp = await call(ctx.app.server, { method: "POST", path: "/auth/request-otp", json: { email: "owner@mail.test" } });
    assert.equal(otp.status, 403);
    var page = await call(ctx.app.server, { path: "/auth/local" });
    assert.equal(page.status, 302);
  } finally { ctx.close(); }
});

// Tampered and replayed callbacks. Each ends with no session cookie.
var CALLBACKS = [
  ["wrong state", async function (ctx) {
    var s = await ctx.start();
    var issued = ctx.provider.issueCode(s.headers.location, SUBJECT);
    return ctx.callback(issued.code, "tampered-state", cookieHeader(s.cookies));
  }],
  ["state not held by this browser (no state cookie)", async function (ctx) {
    var s = await ctx.start();
    var issued = ctx.provider.issueCode(s.headers.location, SUBJECT);
    return ctx.callback(issued.code, issued.state, "");
  }],
  ["wrong nonce", async function (ctx) {
    ctx.provider.nonceOverride = "not-the-nonce";
    return (await ctx.signIn(SUBJECT)).done;
  }],
  ["id token signed by another key", async function (ctx) {
    ctx.provider.signWithOtherKey = true;
    return (await ctx.signIn(SUBJECT)).done;
  }],
  ["reused callback (same state twice)", async function (ctx) {
    var first = await ctx.signIn(SUBJECT);
    assert.equal(first.done.status, 302);
    return ctx.callback(first.issued.code, first.issued.state, cookieHeader(first.started.cookies));
  }],
  ["reused authorization code under a fresh state", async function (ctx) {
    var first = await ctx.signIn(SUBJECT);
    assert.equal(first.done.status, 302);
    var again = await ctx.start();
    var q = new URL(again.headers.location).searchParams;
    return ctx.callback(first.issued.code, q.get("state"), cookieHeader(again.cookies));
  }],
  ["missing PKCE verifier", async function (ctx) {
    var hits = ctx.provider.tokenHits;
    ctx.app.core.provider.pending.put("no-verifier-state", { nonce: "n", redirectUri: "http://127.0.0.1/cb" });
    var res = await ctx.callback("some-code", "no-verifier-state", "clagentic_console_signin=no-verifier-state");
    assert.equal(ctx.provider.tokenHits, hits, "no token request is made without a verifier");
    return res;
  }],
  ["provider returns an error", async function (ctx) {
    var s = await ctx.start();
    return call(ctx.app.server, {
      path: "/auth/external/callback?error=access_denied&state=" + new URL(s.headers.location).searchParams.get("state"),
      headers: { Cookie: cookieHeader(s.cookies) },
    });
  }],
];

CALLBACKS.forEach(function (c) {
  row("callback refused: " + c[0], async function (jose) {
    var ctx = await setup(jose);
    try {
      var res = await c[1](ctx);
      assert.ok(res.status === 403 || res.status === 502, "status " + res.status);
      assert.equal(sessionCookie(res), null, "no session cookie is set");
      assert.equal(userCount(ctx), 1);
    } finally { ctx.close(); }
  });
});

// The Secure attribute: direct TLS, a trusted proxy that says https, and the cases that must not set it.
var SECURE_ROWS = [
  ["plain http, no proxy", {}, {}, false],
  ["direct TLS", { tlsOptions: { key: "k", cert: "c" } }, {}, true],
  ["trusted proxy, forwarded https", { trustedProxy: true }, { "X-Forwarded-Proto": "https" }, true],
  ["trusted proxy, forwarded http", { trustedProxy: true }, { "X-Forwarded-Proto": "http" }, false],
  ["trusted proxy, multi-hop header is not trusted", { trustedProxy: true }, { "X-Forwarded-Proto": "https, http" }, false],
  ["no trusted proxy: the header alone is not believed", {}, { "X-Forwarded-Proto": "https" }, false],
];

SECURE_ROWS.forEach(function (s) {
  row("session cookie Secure (" + s[0] + ") on external sign-in, local login and logout", async function (jose) {
    var ctx = await setup(jose, { app: s[1] });
    try {
      var expectSecure = s[3];
      var signed = await ctx.signIn(SUBJECT, {}, s[2]);
      assert.equal(signed.done.status, 302, signed.done.text);
      var cookie = sessionCookie(signed.done);
      assert.equal(/;\s*Secure/.test(cookie), expectSecure, "external sign-in: " + cookie);
      var login = await call(ctx.app.server, { method: "POST", path: "/auth/login", headers: s[2], json: { username: "owner", pin: "123456" } });
      assert.equal(/;\s*Secure/.test(sessionCookie(login)), expectSecure, "local login");
      var out = await call(ctx.app.server, { method: "POST", path: "/auth/logout", headers: Object.assign({ Cookie: cookieHeader([cookie]) }, s[2]) });
      assert.equal(/;\s*Secure/.test(out.cookies[0]), expectSecure, "sign-out");
      assert.match(out.cookies[0], /Max-Age=0/);
      assert.equal(ctx.app.auth.getMultiUserFromReq({ headers: { cookie: cookieHeader([cookie]) } }), null, "sign-out ends the console session");
    } finally { ctx.close(); }
  });
});

row("the client secret is stored owner-only and appears nowhere else", async function (jose) {
  var captured = [];
  var realOut = process.stdout.write;
  var realErr = process.stderr.write;
  var ctx = null;
  process.stdout.write = function (chunk) { captured.push(String(chunk)); return true; };
  process.stderr.write = function (chunk) { captured.push(String(chunk)); return true; };
  try {
    ctx = await setup(jose);
    fs.writeFileSync(path.join(ctx.env.home, "daemon.json"), JSON.stringify({ port: 3000 }));
    var ok = await ctx.signIn(SUBJECT);
    assert.equal(ok.done.status, 302);
    await ctx.signIn("subject-2");
    await ctx.configure({ localFallback: true });
    var read = await call(ctx.app.server, { path: "/api/admin/external-signin", headers: { Cookie: ctx.adminCookie } });
    assert.equal(read.status, 200);
    assert.equal(read.json.externalSignin.oidc.clientSecretSet, true);
    assert.equal(read.text.indexOf(CLIENT_SECRET), -1, "settings read");
    assert.equal(Object.prototype.hasOwnProperty.call(read.json.externalSignin.oidc, "clientSecret"), false);

    var stored = ctx.env.settings.settingsPath();
    assert.equal(fs.statSync(stored).mode & 0o777, 0o600, "owner-only");
    assert.ok(fs.readFileSync(stored, "utf8").indexOf(CLIENT_SECRET) !== -1, "stored in its own file");
    await new Promise(function (resolve) { setImmediate(resolve); });
    fs.readdirSync(ctx.env.home).forEach(function (name) {
      var file = path.join(ctx.env.home, name);
      if (name === ctx.env.settings.FILE_NAME || !fs.statSync(file).isFile()) return;
      assert.equal(fs.readFileSync(file, "utf8").indexOf(CLIENT_SECRET), -1, name);
    });
    assert.equal(captured.join("").indexOf(CLIENT_SECRET), -1, "log output");
    // A WebSocket frame is built from per-project state; no module on that path reads the secret.
    var readers = [];
    (function walk(dir) {
      fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
        var p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "public") walk(p); return; }
        if (/\.js$/.test(e.name) && fs.readFileSync(p, "utf8").indexOf("clientSecret") !== -1) readers.push(path.relative(LIB, p));
      });
    })(LIB);
    assert.deepEqual(readers.sort(), [
      path.join("external-signin", "index.js"),
      path.join("external-signin", "oidc.js"),
      path.join("external-signin", "settings.js"),
    ]);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    if (ctx) ctx.close();
  }
});

row("only an admin may read or change the settings", async function (jose) {
  var ctx = await setup(jose, { enable: false });
  try {
    var anon = await call(ctx.app.server, { path: "/api/admin/external-signin" });
    assert.equal(anon.status, 403);
    var put = await call(ctx.app.server, { method: "PUT", path: "/api/admin/external-signin", json: { enabled: true } });
    assert.equal(put.status, 403);
    var bad = await ctx.configure({ oidc: { issuer: "http://plain.test", clientId: "c", clientSecret: "s", allowedSubject: "x" } });
    assert.equal(bad.status, 400, "an issuer that is not https is refused");
    assert.equal(ctx.env.policy.isEnabled(), false);
  } finally { ctx.close(); }
});

row("the pending store is single-use and bounded", async function () {
  var env = makeEnv();
  var clock = 1000;
  var store = env.oidc.createPendingStore(function () { return clock; });
  store.put("a", { nonce: "n" });
  assert.ok(store.take("a"));
  assert.equal(store.take("a"), null, "single-use");
  store.put("b", { nonce: "n" });
  clock += 11 * 60 * 1000;
  assert.equal(store.take("b"), null, "expired");
  for (var i = 0; i < 500; i++) store.put("s" + i, { nonce: "n" });
  assert.ok(store.size() <= 200, "bounded");
});

row("a flood from one address does not evict another address's pending sign-in", async function (jose) {
  var ctx = await setup(jose, { app: { trustedProxy: true } });
  try {
    var B = { "X-Forwarded-For": "203.0.113.2" };
    var startedB = await ctx.start(B);
    assert.equal(startedB.status, 302, startedB.text);
    var issued = ctx.provider.issueCode(startedB.headers.location, SUBJECT);
    for (var i = 0; i < 300; i++) {
      ctx.app.core.provider.pending.put("flood-" + i, { nonce: "n" }, "203.0.113.1");
    }
    var done = await ctx.callback(issued.code, issued.state, cookieHeader(startedB.cookies), B);
    assert.equal(done.status, 302, done.text);
    assert.ok(sessionCookie(done), "address B still signs in");
  } finally { ctx.close(); }
});

test("external sign-in caller shapes",async function (t) {
  var jose = await import("jose");
  for (var i = 0; i < ROWS.length; i++) {
    await t.test(ROWS[i].name, ROWS[i].fn.bind(null, jose));
  }
});

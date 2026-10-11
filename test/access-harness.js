// A real Clagentic: Console server (lib/server.js) on a loopback port, with
// real users, real login cookies and real WebSocket clients, for the access
// tests. Nothing in lib/ is stubbed: only the project-access lookup the
// daemon would supply (onGetProjectAccess) is a table the test controls.
//
// The data directory is set before lib/ is first required, so a test file
// must require this module, then call start(), before it requires anything
// from lib/ itself.

"use strict";

var fs = require("fs");
var os = require("os");
var path = require("path");
var crypto = require("crypto");
var http = require("http");
var WebSocket = require("ws");

var COOKIE_NAME = "relay_auth_user";
var TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function userRecord(spec) {
  return {
    id: spec.id || crypto.randomUUID(),
    username: spec.username,
    email: null,
    displayName: spec.username,
    pinHash: "unused",
    role: spec.role || "user",
    mustChangePin: false,
    createdAt: Date.now(),
    linuxUser: spec.linuxUser || null,
    permissions: spec.permissions || undefined,
    profile: { name: spec.username, lang: "en-US", avatarColor: "#7c3aed", avatarStyle: "thumbs", avatarSeed: "abcd1234" },
  };
}

/**
 * spec.users      [{ key, username, role?, permissions?, linuxUser? }]
 * spec.projects   [{ slug, visibility?, ownerKey?, allowedKeys?, parent?, noRecord?, files? }]
 *                 `parent` makes a worktree that takes its parent's access.
 *                 `noRecord` leaves the access lookup without an answer for it.
 *                 `files` maps a relative path to its text content.
 * spec.osUsers    run the server in os-users mode
 * spec.serverOpts extra createServer options
 */
async function start(spec) {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-access-"));
  process.env.CLAGENTIC_CONSOLE_HOME = home;
  // The daemon user's own ~/.claude (global CLAUDE.md) lives under HOME: keep it inside the sandbox.
  process.env.HOME = path.join(home, "userhome");
  fs.mkdirSync(path.join(process.env.HOME, ".claude"), { recursive: true });
  var consoleDir = path.join(home, "console");
  fs.mkdirSync(consoleDir, { recursive: true });

  var people = {};
  var records = (spec.users || []).map(function (u) {
    var rec = userRecord(u);
    people[u.key] = rec;
    return rec;
  });
  fs.writeFileSync(path.join(consoleDir, "users.json"), JSON.stringify({
    multiUser: true, setupCode: null, users: records, invites: [], smtp: null,
  }), { mode: 0o600 });

  var tokens = {};
  var cookies = {};
  Object.keys(people).forEach(function (key) {
    var token = crypto.randomBytes(32).toString("hex");
    var now = Date.now();
    tokens[token] = { userId: people[key].id, issuedAt: now, expiresAt: now + TOKEN_TTL_MS };
    cookies[key] = COOKIE_NAME + "=" + token;
  });
  fs.writeFileSync(path.join(consoleDir, "auth-tokens.json"), JSON.stringify(tokens), { mode: 0o600 });

  var access = Object.create(null);
  (spec.projects || []).forEach(function (p) {
    if (p.parent || p.noRecord) return;
    access[p.slug] = {
      visibility: p.visibility,
      ownerId: p.ownerKey ? people[p.ownerKey].id : null,
      allowedUsers: (p.allowedKeys || []).map(function (k) { return people[k].id; }),
    };
  });
  var parentOf = Object.create(null);
  (spec.projects || []).forEach(function (p) { if (p.parent) parentOf[p.slug] = p.parent; });

  // What daemon.js's onGetProjectAccess answers: a worktree carries its parent's access.
  function lookup(slug) {
    var key = parentOf[slug] || slug;
    var a = access[key];
    if (!a) return { error: "Project not found" };
    var out = { slug: slug, allowedUsers: a.allowedUsers, ownerId: a.ownerId };
    if (a.visibility !== undefined) out.visibility = a.visibility;
    return out;
  }

  var serverModule = require("../lib/server");
  var relay = serverModule.createServer(Object.assign({
    port: 0,
    osUsers: !!spec.osUsers,
    onGetProjectAccess: lookup,
  }, spec.serverOpts || {}));
  await new Promise(function (resolve) { relay.server.listen(0, "127.0.0.1", resolve); });
  var port = relay.server.address().port;

  var dirs = {};
  (spec.projects || []).forEach(function (p) {
    var dir = path.join(home, "projects", p.slug);
    fs.mkdirSync(dir, { recursive: true });
    Object.keys(p.files || {}).forEach(function (rel) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), p.files[rel]);
    });
    dirs[p.slug] = dir;
    var meta = p.parent ? { parentSlug: p.parent, branch: p.slug, accessible: true } : null;
    relay.addProject(dir, p.slug, p.slug, null, p.ownerKey ? people[p.ownerKey].id : null, meta);
  });

  var sockets = [];

  /**
   * Opens a WebSocket into a project as a user. Resolves { ok: true, ws, inbox,
   * waitFor } or { ok: false, status } when the upgrade is refused.
   * opts.headers adds or overrides request headers (Origin, Host, ...).
   */
  function connect(slug, userKey, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var headers = Object.assign({}, userKey ? { Cookie: cookies[userKey] } : {}, opts.headers || {});
      var ws = new WebSocket("ws://127.0.0.1:" + port + "/p/" + slug + "/ws", { headers: headers });
      var inbox = [];
      var waiters = [];
      ws.on("message", function (raw) {
        var msg = JSON.parse(raw.toString());
        inbox.push(msg);
        waiters = waiters.filter(function (w) {
          if (!w.pred(msg)) return true;
          clearTimeout(w.timer);
          w.resolve(msg);
          return false;
        });
      });
      function waitFor(pred, ms) {
        var seen = inbox.filter(pred);
        if (seen.length) return Promise.resolve(seen[0]);
        return new Promise(function (res, rej) {
          var waiter = { pred: pred, resolve: res };
          waiter.timer = setTimeout(function () {
            waiters = waiters.filter(function (w) { return w !== waiter; });
            rej(new Error("timed out waiting for a message"));
          }, ms || 4000);
          waiters.push(waiter);
        });
      }
      ws.on("open", function () {
        sockets.push(ws);
        resolve({ ok: true, ws: ws, inbox: inbox, waitFor: waitFor, send: function (m) { ws.send(JSON.stringify(m)); } });
      });
      ws.on("unexpected-response", function (req, res) {
        res.resume();
        resolve({ ok: false, status: res.statusCode });
      });
      ws.on("error", function (e) {
        resolve({ ok: false, status: 0, error: e.message });
      });
    });
  }

  function request(method, urlPath, userKey, body, extraHeaders) {
    return new Promise(function (resolve, reject) {
      var payload = body === undefined ? null : JSON.stringify(body);
      var headers = Object.assign({}, userKey ? { Cookie: cookies[userKey] } : {}, extraHeaders || {});
      if (payload) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(payload); }
      var req = http.request({ host: "127.0.0.1", port: port, method: method, path: urlPath, headers: headers }, function (res) {
        var chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }); });
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function stop() {
    sockets.forEach(function (ws) { try { ws.terminate(); } catch (e) {} });
    try { await relay.destroyAll(); } catch (e) {}
    await new Promise(function (resolve) { relay.server.close(function () { resolve(); }); });
    if (typeof relay.server.closeAllConnections === "function") relay.server.closeAllConnections();
    fs.rmSync(home, { recursive: true, force: true });
  }

  return {
    home: home,
    port: port,
    relay: relay,
    people: people,
    dirs: dirs,
    cookies: cookies,
    connect: connect,
    request: request,
    stop: stop,
  };
}

// Resolves once `ms` has passed with nothing else to wait for: used to show
// that a message was NOT delivered.
function settle(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms || 150); });
}

module.exports = { start: start, settle: settle };

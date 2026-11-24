"use strict";
// Every process the daemon starts as another Linux account goes through one
// helper (lib/os-users.js asUser) and carries the account's uid, gid and
// supplementary groups and a minimal per-user environment; and an owner that is
// set but cannot be run as is refused with a named reason, never answered with
// the daemon account.
//
// One shared table. SPAWN_SITES holds one row per spawn site, each driven
// through its real entry point with child_process and node-pty captured at the
// module boundary (the fakes below answer getent and id from a synthetic
// account table). The caller shapes (an account with and without supplementary
// groups, setpriv missing, os-users off) run over every site row; the owner
// shapes (no record, unmapped, account gone, lookup error) run over every
// acquire site. No account here exists on the host.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var Module = require("module");
var EventEmitter = require("events");
var { PassThrough } = require("stream");
var childProcess = require("child_process");

var SENTINEL = "DAEMON_ONLY_SENTINEL";
process.env[SENTINEL] = "must-not-reach-a-child";
var REAL_PATH = process.env.PATH;

var SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "os-users-spawn-"));
process.env.CLAGENTIC_CONSOLE_HOME = path.join(SANDBOX, "console-home");
fs.mkdirSync(process.env.CLAGENTIC_CONSOLE_HOME, { recursive: true });
var PROJ = path.join(SANDBOX, "proj");
fs.mkdirSync(PROJ);
var BIN_WITH = path.join(SANDBOX, "bin-with");
var BIN_WITHOUT = path.join(SANDBOX, "bin-without");
fs.mkdirSync(BIN_WITH);
fs.mkdirSync(BIN_WITHOUT);
fs.writeFileSync(path.join(BIN_WITH, "setpriv"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
var CODEX_STAND_IN = path.join(SANDBOX, "codex");
fs.writeFileSync(CODEX_STAND_IN, "#!/bin/sh\necho 'codex-cli 0.162.1'\n", { mode: 0o755 });
process.env.CLAGENTIC_CONSOLE_CODEX_PATH = CODEX_STAND_IN;

// ---------------------------------------------------------------------------
// The module boundary: child_process and node-pty are replaced before any lib
// module loads, so every destructured reference is the recorder. Outside a
// world (W is null) they pass straight through to the real ones.
// ---------------------------------------------------------------------------

var real = { execFileSync: childProcess.execFileSync, execFile: childProcess.execFile, spawn: childProcess.spawn };
var W = null;

function newWorld(over) {
  return Object.assign({
    accounts: [], users: {}, calls: [], output: "{}", getentFailure: false, spawnExit: false,
    // The daemon's own supplementary groups: none unless a test says so, so no
    // result depends on the groups of whoever runs the suite.
    daemonGroups: [],
  }, over || {});
}

var realGetgroups = process.getgroups;
process.getgroups = function () {
  return W ? W.daemonGroups.slice() : realGetgroups.apply(process, arguments);
};

function findAccount(key) {
  for (var i = 0; i < W.accounts.length; i++) {
    var a = W.accounts[i];
    if (a.name === key || String(a.uid) === String(key)) return a;
  }
  return null;
}

function statusError(status, text) {
  return Object.assign(new Error(text), { status: status });
}

// The answer to getent passwd / id -G, or undefined when the call is not one.
function lookup(cmd, args) {
  if (cmd === "getent" && args[0] === "passwd") {
    if (W.getentFailure) throw statusError(1, "getent: the name service is unavailable");
    var a = findAccount(args[1]);
    if (!a) throw statusError(2, "getent: no such key");
    return a.name + ":x:" + a.uid + ":" + a.gid + ":gecos:" + a.home + ":" + a.shell + "\n";
  }
  if (cmd === "id" && /^-[Gug]$/.test(String(args[0]))) {
    var b = findAccount(args[1]);
    if (!b) throw statusError(1, "id: no such user");
    if (args[0] === "-u") return b.uid + "\n";
    if (args[0] === "-g") return b.gid + "\n";
    return b.groups.join(" ") + "\n";
  }
  return undefined;
}

function isSetpriv(command) { return path.basename(String(command)) === "setpriv"; }

function record(command, args, options) {
  var call = { command: command, args: (args || []).slice(), options: options || {} };
  W.calls.push(call);
  return call;
}

function fakeExecFileSync(cmd, args, options) {
  if (!W) return real.execFileSync.apply(childProcess, arguments);
  var answered = lookup(cmd, args || []);
  if (answered !== undefined) return answered;
  if (cmd === CODEX_STAND_IN) return "codex-cli 0.162.1\n";
  record(cmd, args, options);
  var asAccount = cmd === process.execPath || isSetpriv(cmd) || (options && options.uid !== undefined);
  return asAccount ? W.output : "";
}

function fakeChild() {
  var child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 4242;
  child.killed = false;
  child.kill = function () { child.killed = true; };
  return child;
}

function fakeSpawn(cmd, args, options) {
  if (!W) return real.spawn.apply(childProcess, arguments);
  record(cmd, args, options);
  var child = fakeChild();
  if (W.spawnExit) setImmediate(function () { child.emit("close", 0); });
  return child;
}

function fakeExecFile(cmd, args, options, cb) {
  if (!W) return real.execFile.apply(childProcess, arguments);
  record(cmd, args, options);
  setImmediate(function () { cb(null, W.output); });
  return fakeChild();
}

childProcess.execFileSync = fakeExecFileSync;
childProcess.spawn = fakeSpawn;
childProcess.execFile = fakeExecFile;

var fakePty = {
  spawn: function (file, args, options) {
    record(file, args, options);
    return {
      pid: 4343,
      onData: function () {}, onExit: function () {},
      write: function () {}, resize: function () {}, kill: function () {},
    };
  },
};
var originalLoad = Module._load;
Module._load = function (request) {
  if (request === "@lydell/node-pty") return fakePty;
  return originalLoad.apply(this, arguments);
};

// The Codex adapter takes its app-server class when it is loaded: swap in a
// recorder before anything loads it, keeping the real class for the spawn row.
var codexAppServerModule = require("../lib/yoke/codex-app-server");
var RealCodexAppServer = codexAppServerModule.CodexAppServer;
var appServers = [];
function FakeAppServer(executablePath, opts) {
  this.opts = opts || {};
  this.started = false;
  this.proc = null;
  appServers.push(this);
}
FakeAppServer.prototype.start = function () { this.started = true; return Promise.resolve(); };
FakeAppServer.prototype.stop = function () { this.started = false; };
FakeAppServer.prototype.notify = function () {};
FakeAppServer.prototype.send = function (method) {
  if (method === "model/list") return Promise.resolve({ data: [{ model: "gpt-test", displayName: "gpt-test", isDefault: true }] });
  if (method === "skills/list") return Promise.resolve({ data: [] });
  return Promise.resolve({});
};
FakeAppServer.prototype.addEventHandler = function () { return {}; };
FakeAppServer.prototype.removeEventHandler = function () {};
FakeAppServer.prototype.updateHandlerThreadId = function () {};
codexAppServerModule.CodexAppServer = FakeAppServer;

var osUsers = require("../lib/os-users");
var usersModule = require("../lib/users");
usersModule.findUserById = function (id) { return W && W.users[id] ? W.users[id] : null; };
var yoke = require("../lib/yoke");

// ---------------------------------------------------------------------------
// Synthetic accounts and owner shapes
// ---------------------------------------------------------------------------

var GROUPED = { name: "clay-grouped", uid: 52001, gid: 52001, groups: [52001, 53001, 53002], home: "/home/clay-grouped", shell: "/bin/bash" };
var PLAIN = { name: "clay-plain", uid: 52002, gid: 52002, groups: [52002], home: "/home/clay-plain", shell: "/bin/bash" };

function extras(acct) {
  return acct.groups.filter(function (g) { return g !== acct.gid; });
}

function withPath(hasSetpriv, fn) {
  var saved = process.env.PATH;
  process.env.PATH = hasSetpriv ? BIN_WITH : BIN_WITHOUT;
  function restore() { process.env.PATH = saved; }
  var out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  return Promise.resolve(out).then(function (v) { restore(); return v; }, function (e) { restore(); throw e; });
}

function until(predicate, label, limitMs) {
  return new Promise(function (resolve, reject) {
    var started = Date.now();
    (function poll() {
      if (predicate()) return resolve();
      if (Date.now() - started > (limitMs || 3000)) return reject(new Error("timed out waiting for " + label));
      setTimeout(poll, 10);
    })();
  });
}

// ---------------------------------------------------------------------------
// What a spawned child must look like
// ---------------------------------------------------------------------------

var ENV_ALLOWED = new Set(["HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "NODE_ENV", "TERM", "COLORFGBG", "XDG_RUNTIME_DIR", "NODE_OPTIONS"]);

// The call that started `want`, direct or through setpriv; the last one wins.
function callFor(calls, want) {
  var found = null;
  calls.forEach(function (c) {
    if (isSetpriv(c.command)) {
      var i = c.args.indexOf("--");
      if (i !== -1 && c.args[i + 1] === want) found = c;
    } else if (c.command === want) {
      found = c;
    }
  });
  return found;
}

// Everything that is wrong with `call` as a child of `acct`. Empty when right.
function problems(call, acct, extraEnv) {
  var out = [];
  if (!call) return ["nothing was started"];
  var o = call.options;
  if (extras(acct).length) {
    if (!isSetpriv(call.command)) out.push("the account's supplementary groups were not set");
    else {
      var a = call.args;
      if (a[0] !== "--reuid=" + acct.uid) out.push("reuid " + a[0]);
      if (a[1] !== "--regid=" + acct.gid) out.push("regid " + a[1]);
      if (a[2] !== "--groups=" + extras(acct).join(",")) out.push("groups " + a[2]);
    }
    if (o.uid !== undefined || o.gid !== undefined) out.push("uid/gid set on the wrapper as well");
  } else {
    if (o.uid !== acct.uid || o.gid !== acct.gid) out.push("uid/gid are " + o.uid + "/" + o.gid);
  }
  var env = o.env || {};
  Object.keys(env).forEach(function (k) {
    if (!ENV_ALLOWED.has(k) && !/^LC_/.test(k) && (extraEnv || []).indexOf(k) === -1) out.push("env carries " + k);
  });
  if (env.HOME !== acct.home) out.push("HOME is " + env.HOME);
  if (env.USER !== acct.name || env.LOGNAME !== acct.name) out.push("USER/LOGNAME are " + env.USER + "/" + env.LOGNAME);
  if (env.XDG_RUNTIME_DIR !== "/run/user/" + acct.uid) out.push("XDG_RUNTIME_DIR is " + env.XDG_RUNTIME_DIR);
  if (env[SENTINEL] !== undefined) out.push("the daemon's environment leaked");
  return out;
}

// ---------------------------------------------------------------------------
// The project context the HTTP and WebSocket routes are driven through
// ---------------------------------------------------------------------------

var contexts = {};

// Built before any world is installed, so what building one starts is real and
// is not counted among the processes a test expects not to see.
test.before(async function () {
  ctxFor(true);
  ctxFor(false);
  await settleFirstConnectionWarmup(ctxFor(true));
});

// The first connection into a project starts its adapters' warmup, which runs
// on after the connection returns and starts processes of its own. Run it here,
// to its end, so it never lands inside a test that counts the processes started.
async function settleFirstConnectionWarmup(ctx) {
  var user = { id: "u-warmup", username: "warmup", role: "admin", linuxUser: null };
  W = newWorld({ users: { "u-warmup": user } });
  var ws = fakeWs(user);
  ws.on = function () {};
  function registries() { return ws.inbox.filter(function (m) { return m.type === "vendor_registry"; }).length; }
  try {
    ctx.handleConnection(ws, user);
    // One registry answers the connection, a second is the end of the warmup.
    await until(function () { return registries() >= 2; }, "the warmup to finish", 60000);
  } catch (e) {
    // A warmup that never finishes is left to run on; the tests then fail on what it starts.
  } finally {
    ctx.handleDisconnection(ws);
    W = null;
  }
}

test.after(async function () {
  for (var key of Object.keys(contexts)) {
    try { await contexts[key].destroy({ reason: "test" }); } catch (e) { /* already stopped */ }
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function ctxFor(osUsersOn) {
  var key = osUsersOn ? "on" : "off";
  if (!contexts[key]) {
    contexts[key] = require("../lib/project").createProjectContext({
      cwd: PROJ, slug: "spawn-" + key, title: "spawn-" + key, debug: false, currentVersion: "0.0.0", osUsers: osUsersOn,
      notificationsModule: { handleNotificationMessage: function () { return false; }, sendConnectionState: function () {} },
    });
  }
  return contexts[key];
}

function httpRound(ctx, method, url, user, body) {
  var req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = {};
  req._clagenticUser = user;
  req.end(body === undefined ? undefined : JSON.stringify(body));
  var res = { status: null, body: "" };
  var done = new Promise(function (resolve) {
    res.writeHead = function (s) { res.status = s; };
    res.end = function (b) { res.body = b ? String(b) : ""; resolve(); };
  });
  var urlPath = url;
  ctx.handleHTTP(req, res, urlPath);
  return done.then(function () { return res; });
}

function refusalOf(res) {
  if (res.status !== 403 && res.status !== 500) return null;
  try { return JSON.parse(res.body).error; } catch (e) { return res.body; }
}

function fakeWs(user) {
  var ws = { readyState: 1, inbox: [], _clagenticUser: user, send: function (m) { ws.inbox.push(JSON.parse(m)); } };
  return ws;
}

function userOf(acct) {
  return { id: "u-" + acct.name, username: acct.name, role: "admin", linuxUser: acct.name };
}

// ---------------------------------------------------------------------------
// The spawn sites. drive(acct) returns { refused: message|null, acct?: effective
// account }, with every child the site started in W.calls. want is the program
// the site runs as the account.
// ---------------------------------------------------------------------------

var SPAWN_SITES = [
  {
    id: "claude worker", want: process.execPath,
    drive: async function (acct) {
      var claude = require("../lib/yoke/adapters/claude");
      var worker = null;
      var refused = null;
      try { worker = claude._test_spawnWorker(acct.name, path.join(SANDBOX, "worker.js"), PROJ); } catch (e) { refused = e.message; }
      if (worker) {
        await until(function () { return W.calls.length > 0; }, "the worker spawn");
        worker.server.close();
      }
      return { refused: refused };
    },
  },
  {
    id: "terminal", want: "/bin/bash",
    drive: async function (acct) {
      try {
        require("../lib/terminal").createTerminal(PROJ, 80, 24, osUsers.resolveOsUserInfo(acct.name));
        return { refused: null };
      } catch (e) { return { refused: e.message }; }
    },
  },
  {
    id: "fsAsUser", want: process.execPath, output: '{"size":1,"isDir":false,"mtime":0}',
    drive: async function (acct) {
      try { osUsers.fsAsUser("stat", { file: path.join(PROJ, "f") }, osUsers.resolveOsUserInfo(acct.name)); return { refused: null }; }
      catch (e) { return { refused: e.message }; }
    },
  },
  {
    id: "skill uninstall", want: process.execPath,
    drive: async function (acct) {
      var res = await httpRound(ctxFor(true), "POST", "/api/uninstall-skill", userOf(acct), { skill: "demo", scope: "global" });
      return { refused: refusalOf(res) };
    },
  },
  {
    id: "skill install", want: "npx", extraEnv: ["npm_config_cache"], spawnExit: true,
    drive: async function (acct) {
      var res = await httpRound(ctxFor(true), "POST", "/api/install-skill", userOf(acct), { url: "https://example.invalid/r", skill: "demo", scope: "global" });
      return { refused: refusalOf(res) };
    },
  },
  {
    id: "idle-compaction settings", want: process.execPath, output: '{"ok":true,"value":"off"}',
    drive: async function (acct) {
      var r = await require("../lib/idle-compaction-setting").applyForOwner("write", "off", { osUsers: true, osUserInfo: osUsers.resolveOsUserInfo(acct.name) });
      return { refused: r.ok ? null : r.error };
    },
  },
  {
    id: "project git init", want: "git",
    drive: async function (acct) {
      var dir = fs.mkdtempSync(path.join(SANDBOX, "init-"));
      try { require("../lib/project-bootstrap").initRepo({ osUsers: true, wsUser: userOf(acct), targetDir: dir }); return { refused: null }; }
      catch (e) { return { refused: e.message }; }
    },
  },
  {
    id: "project git clone", want: "git", extraEnv: ["GIT_ALLOW_PROTOCOL"],
    drive: async function (acct) {
      try {
        var bootstrap = require("../lib/project-bootstrap");
        var spec = bootstrap.cloneSpawnSpec(bootstrap.resolveCreator(true, userOf(acct)), { args: ["clone", "--", "https://example.invalid/r.git", "d"], envOverrides: { GIT_ALLOW_PROTOCOL: "https" } }, PROJ);
        record(spec.command, spec.args, spec.options);
        return { refused: null };
      } catch (e) { return { refused: e.message }; }
    },
  },
  {
    // Git reads run as the repository owner's uid and gid alone, so the owner
    // below has no supplementary groups whatever the caller shape.
    id: "repository git", want: "git", ownerWithoutGroups: true, extraEnv: ["GIT_TERMINAL_PROMPT", "GIT_OPTIONAL_LOCKS", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"],
    drive: async function (acct) {
      var repo = fs.mkdtempSync(path.join(SANDBOX, "repo-"));
      fs.mkdirSync(path.join(repo, ".git"));
      var st = fs.statSync(path.join(repo, ".git"));
      // The account that owns the repository: this one's groups, the stat's uid and gid.
      var owner = { name: "repo-owner-" + acct.name, uid: st.uid, gid: st.gid, home: acct.home, shell: acct.shell, groups: [st.gid] };
      W.accounts.push(owner);
      try {
        require("../lib/project-git").runGit(["log", "-1"], { cwd: repo, osUsers: true, exec: function (c, a, o) { record(c, a, o); return ""; } });
        return { refused: null, acct: owner };
      } catch (e) { return { refused: e.message, acct: owner }; }
    },
  },
  {
    id: "codex app-server", want: path.join(SANDBOX, "codex-bin"), extraEnv: ["MARK"],
    drive: async function (acct) {
      var server = new RealCodexAppServer(path.join(SANDBOX, "codex-bin"), { osUserInfo: osUsers.resolveOsUserInfo(acct.name), env: { MARK: "1" }, cwd: PROJ });
      try { await server.start(); return { refused: null }; }
      catch (e) { return { refused: e.message }; }
    },
  },
];

async function runSite(site, acct, opts) {
  W = newWorld({ accounts: [acct], output: site.output || "{}", spawnExit: !!site.spawnExit });
  try {
    var result = await withPath(opts.setpriv, function () { return site.drive(acct); });
    return { result: result, calls: W.calls.slice(), acct: result.acct || acct };
  } finally {
    W = null;
  }
}

// --- AC1 and AC2: identity and environment, every site, both account shapes ---

SPAWN_SITES.forEach(function (site) {
  [["with supplementary groups", GROUPED], ["without supplementary groups", PLAIN]].forEach(function (shape) {
    test("AC1 AC2 " + site.id + ": an account " + shape[0] + " gets its uid, gid, groups and the minimal environment", async function () {
      var ran = await runSite(site, shape[1], { setpriv: true });
      assert.equal(ran.result.refused, null);
      assert.deepEqual(problems(callFor(ran.calls, site.want), ran.acct, site.extraEnv), []);
    });
  });
});

// --- AC3: no group mechanism ---------------------------------------------------

SPAWN_SITES.forEach(function (site) {
  test("AC3 " + site.id + ": an account with groups is refused by name when setpriv is missing; one without may start", async function () {
    if (!site.ownerWithoutGroups) {
      var refusedRun = await runSite(site, GROUPED, { setpriv: false });
      assert.match(String(refusedRun.result.refused), /supplementary groups/);
      assert.match(String(refusedRun.result.refused), /setpriv/);
      assert.equal(callFor(refusedRun.calls, site.want), null, "nothing was started without the groups");
    }

    var plainRun = await runSite(site, PLAIN, { setpriv: false });
    assert.equal(plainRun.result.refused, null);
    assert.deepEqual(problems(callFor(plainRun.calls, site.want), plainRun.acct, site.extraEnv), []);
  });
});

// A pty child keeps the daemon's groups unless they are cleared, so a daemon that
// has some sends even a no-group account through setpriv; the daemon's own
// account needs no wrapper at all. Both are stated here, not read from the host.
[
  { id: "a daemon with supplementary groups clears them for a no-group account", daemonGroups: [777], acct: PLAIN, clears: true },
  { id: "a daemon with no supplementary groups starts a no-group account directly", daemonGroups: [], acct: PLAIN, clears: false },
  { id: "the daemon's own account starts directly even with groups", daemonGroups: [777], acct: { name: "clay-self", uid: process.geteuid(), gid: process.getegid(), groups: [process.getegid(), 53001], home: "/home/clay-self", shell: "/bin/bash" }, clears: false },
].forEach(function (shape) {
  test("AC1 terminal: " + shape.id, async function () {
    W = newWorld({ accounts: [shape.acct], daemonGroups: shape.daemonGroups });
    try {
      await withPath(true, function () {
        require("../lib/terminal").createTerminal(PROJ, 80, 24, osUsers.resolveOsUserInfo(shape.acct.name));
      });
      var call = W.calls[W.calls.length - 1];
      assert.equal(isSetpriv(call.command), shape.clears);
      if (shape.clears) assert.ok(call.args.indexOf("--clear-groups") !== -1);
      else assert.equal(call.options.uid, shape.acct.uid);
    } finally {
      W = null;
    }
  });
});

// --- Owner shapes at every acquire site (AC4, AC5) ------------------------------

var OWNER_SHAPES = [
  { id: "no user record", ws: false, ownerId: "u-missing", code: "OS_USER_RECORD_MISSING", reason: /no longer has a user record/ },
  { id: "no Linux mapping", ownerId: "u-unmapped", user: { id: "u-unmapped", username: "unmapped", role: "admin", linuxUser: null }, code: "OS_USER_UNMAPPED", reason: /Linux account is mapped/ },
  { id: "account gone", ownerId: "u-gone", user: { id: "u-gone", username: "gone", role: "admin", linuxUser: "clay-gone" }, code: "OS_USER_ACCOUNT_GONE", reason: /no longer exists/ },
  { id: "lookup error", ownerId: "u-flaky", user: { id: "u-flaky", username: "flaky", role: "admin", linuxUser: "clay-flaky" }, code: "OS_USER_LOOKUP_FAILED", reason: /Looking up the Linux account .* failed/, getentFailure: true, notUnmapped: true },
];

function ownerWorld(shape) {
  var users = {};
  if (shape.user) users[shape.user.id] = shape.user;
  return newWorld({ users: users, getentFailure: !!shape.getentFailure });
}

function makeBridge(osUsersOn) {
  var recorded = [];
  var created = [];
  var sm = {
    modelsByVendor: {},
    sendAndRecord: function (session, obj) { recorded.push(obj); },
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
  };
  var adapter = { vendor: "claude", createQuery: function (o) { created.push(o); return Promise.reject(new Error("no runtime in this test")); } };
  var bridge = require("../lib/sdk-bridge").createSDKBridge({
    cwd: PROJ, slug: "bridge", osUsers: osUsersOn, sessionManager: sm, send: function () {}, adapter: adapter, adapters: { claude: adapter },
  });
  return { bridge: bridge, recorded: recorded, created: created };
}

function ownedSession(shape, extra) {
  return Object.assign({ localId: 11, ownerId: shape.ownerId, vendor: "claude", history: [], cwd: PROJ }, extra || {});
}

function assertNamed(shape, text) {
  assert.match(String(text), shape.reason);
  if (shape.notUnmapped) assert.doesNotMatch(String(text), /Linux account is mapped|no longer exists|user record/, "reported as a lookup failure, not as an unmapped user");
}

var ACQUIRE_SITES = [
  {
    id: "session start and resume (sdk-bridge startQuery)",
    run: async function (shape) {
      var b = makeBridge(true);
      try { await b.bridge.startQuery(ownedSession(shape), "hello", undefined, shape.user && shape.user.linuxUser ? shape.user.linuxUser : null); } catch (e) { /* a start that went on fails later, below */ }
      var errors = b.recorded.filter(function (m) { return m.type === "error"; });
      assert.equal(b.created.length, 0, "no agent runtime was created");
      assert.equal(errors.length > 0 && errors[0].code, shape.code);
      assertNamed(shape, errors[0].text);
      return 0;
    },
  },
  {
    id: "a Codex-bound session start",
    run: async function (shape) {
      appServers.length = 0;
      var b = makeBridge(true);
      try { await b.bridge.startQuery(ownedSession(shape, { vendor: "codex" }), "hello", undefined, null); } catch (e) { /* see above */ }
      assert.equal(appServers.length, 0, "no Codex app-server was started");
      var errors = b.recorded.filter(function (m) { return m.type === "error"; });
      assert.equal(errors.length > 0 && errors[0].code, shape.code);
      return 0;
    },
  },
  {
    id: "fork (sdk-bridge forkSession)",
    run: async function (shape) {
      var b = makeBridge(true);
      await assert.rejects(function () { return b.bridge.forkSession(ownedSession(shape, { cliSessionId: "cli-1" }), "uuid-1"); }, function (e) {
        assert.equal(e.code, shape.code);
        assertNamed(shape, e.message);
        return true;
      });
      return 0;
    },
  },
  {
    id: "title read (sdk-bridge refreshAiTitle)",
    run: async function (shape) {
      var daemonDir = fs.mkdtempSync(path.join(SANDBOX, "daemon-claude-"));
      var sessionId = "title-" + shape.ownerId;
      fs.mkdirSync(path.join(daemonDir, "projects", "p"), { recursive: true });
      fs.writeFileSync(path.join(daemonDir, "projects", "p", sessionId + ".jsonl"), JSON.stringify({ type: "ai-title", aiTitle: "the daemon's transcript", sessionId: sessionId }) + "\n");
      var saved = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = daemonDir;
      try {
        var session = ownedSession(shape, { cliSessionId: sessionId, title: "first line" });
        var changed = await makeBridge(true).bridge.refreshAiTitle(session);
        assert.equal(changed, false);
        assert.equal(session.title, "first line", "the daemon account's transcript was not read for the owner");
      } finally {
        if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
      }
      return 0;
    },
  },
  {
    id: "project creation (project-bootstrap initRepo)", needsUser: true,
    run: async function (shape) {
      var dir = fs.mkdtempSync(path.join(SANDBOX, "create-"));
      assert.throws(function () {
        require("../lib/project-bootstrap").initRepo({ osUsers: true, wsUser: shape.user, targetDir: dir });
      }, function (e) { assert.equal(e.code, shape.code); assertNamed(shape, e.message); return true; });
      return 0;
    },
  },
  {
    id: "project clone (project-bootstrap resolveCreator)", needsUser: true,
    run: async function (shape) {
      assert.throws(function () { require("../lib/project-bootstrap").resolveCreator(true, shape.user); }, function (e) {
        assert.equal(e.code, shape.code);
        assertNamed(shape, e.message);
        return true;
      });
      return 0;
    },
  },
  {
    id: "terminal (term_create)", needsUser: true,
    run: async function (shape) {
      var ws = fakeWs(shape.user);
      ctxFor(true).handleMessage(ws, { type: "term_create", cols: 80, rows: 24 });
      var err = ws.inbox.filter(function (m) { return m.type === "term_error"; })[0];
      assert.ok(err, "the terminal request was refused");
      assertNamed(shape, err.error);
      return 0;
    },
  },
  {
    id: "file listing (fs_list)", needsUser: true,
    run: async function (shape) {
      var ws = fakeWs(shape.user);
      ctxFor(true).handleMessage(ws, { type: "fs_list", path: "." });
      var res = ws.inbox.filter(function (m) { return m.type === "fs_list_result"; })[0];
      assert.ok(res && res.error, "the listing was refused");
      assertNamed(shape, res.error);
      return 0;
    },
  },
  {
    id: "file serving (GET /api/file)", needsUser: true,
    run: async function (shape) {
      var res = await httpRound(ctxFor(true), "GET", "/api/file?path=x.png", shape.user);
      assert.equal(res.status, 403);
      assertNamed(shape, res.body);
      return 0;
    },
  },
  {
    id: "skill install (POST /api/install-skill)", needsUser: true,
    run: async function (shape) {
      var res = await httpRound(ctxFor(true), "POST", "/api/install-skill", shape.user, { url: "https://example.invalid/r", skill: "demo", scope: "global" });
      assertNamed(shape, refusalOf(res));
      return 0;
    },
  },
  {
    id: "skill uninstall (POST /api/uninstall-skill)", needsUser: true,
    run: async function (shape) {
      var res = await httpRound(ctxFor(true), "POST", "/api/uninstall-skill", shape.user, { skill: "demo", scope: "global" });
      assertNamed(shape, refusalOf(res));
      return 0;
    },
  },
  {
    id: "vendor model list (get_vendor_models)", needsUser: true,
    run: async function (shape) {
      var ws = fakeWs(shape.user);
      ctxFor(true).handleMessage(ws, { type: "get_vendor_models", vendor: "claude" });
      await until(function () { return ws.inbox.some(function (m) { return m.type === "model_info"; }); }, "the model answer");
      var err = ws.inbox.filter(function (m) { return m.type === "error"; })[0];
      assert.ok(err, "the request was refused by name");
      assert.equal(err.code, shape.code);
      assertNamed(shape, err.text);
      assert.deepEqual(ws.inbox.filter(function (m) { return m.type === "model_info"; })[0].models, [], "no model list from the daemon account");
      return 0;
    },
  },
  {
    id: "vendor registry on connect (handleConnection)", needsUser: true,
    run: async function (shape) {
      var ctx = ctxFor(true);
      var ws = fakeWs(shape.user);
      ws.on = function () {};
      var saved = ctx.sm.installedVendors;
      ctx.sm.installedVendors = ["claude"];
      try {
        ctx.handleConnection(ws, shape.user);
      } finally {
        ctx.sm.installedVendors = saved;
        ctx.handleDisconnection(ws);
      }
      var registryMsg = ws.inbox.filter(function (m) { return m.type === "vendor_registry"; })[0];
      assert.ok(registryMsg, "the registry was sent");
      assert.deepEqual(registryMsg.vendors.filter(function (v) { return v.installed || v.available; }), [], "no agent shown as usable, the daemon's install state is not theirs");
      return 0;
    },
  },
  {
    id: "vendor registry on connect, a narrow context without the resolvers", needsUser: true, onlyShape: "no Linux mapping",
    run: async function (shape) {
      var sm = {
        sessions: new Map(), installedVendors: ["claude"], effectiveSessionModel: function () { return null; },
        availableVendors: [], capabilitiesByVendor: {},
      };
      var sent = [];
      var narrow = require("../lib/project-connection").attachConnection({
        cwd: PROJ, slug: "narrow", osUsers: true, sm: sm, tm: { list: function () { return []; } }, nm: { list: function () { return []; } },
        clients: new Set(), sendTo: function (ws, m) { sent.push(m); }, opts: {},
        _loop: { loopState: {}, loopRegistry: {}, sendConnectionState: function () {} },
        broadcastClientCount: function () {}, broadcastPresence: function () {},
        getProjectList: function () { return []; }, getHubSchedules: function () { return []; },
        getProjectOwnerId: function () { return null; }, getTitle: function () { return "narrow"; }, getProject: function () { return "narrow"; },
        liteStatus: { installed: false, liteHome: null },
      });
      var ws = fakeWs(shape.user);
      ws.on = function () {};
      try { narrow.handleConnection(ws, shape.user, function () {}, function () {}); } catch (e) { /* what follows the registry is not under test */ }
      var registryMsg = sent.filter(function (m) { return m.type === "vendor_registry"; })[0];
      assert.ok(registryMsg, "the registry was sent");
      assert.deepEqual(registryMsg.vendors.filter(function (v) { return v.installed || v.available; }), [], "the daemon's registry was not served to an unmapped user");
      var identity = require("../lib/connection-identity").createConnectionIdentity({ osUsers: true, getSm: function () { return sm; } });
      assert.throws(function () { identity.getLinuxUserForWs(ws); }, function (e) { assert.equal(e.code, shape.code); assertNamed(shape, e.message); return true; });
      return 0;
    },
  },
  {
    id: "vendor re-check (recheck_vendors)", needsUser: true,
    run: async function (shape) {
      var ctx = ctxFor(true);
      var ws = fakeWs(shape.user);
      var saved = ctx.sm.installedVendors;
      ctx.sm.installedVendors = ["claude"];
      try {
        ctx.handleMessage(ws, { type: "recheck_vendors" });
      } finally {
        ctx.sm.installedVendors = saved;
      }
      var err = ws.inbox.filter(function (m) { return m.type === "error"; })[0];
      assert.ok(err, "the re-check was refused by name");
      assert.equal(err.code, shape.code);
      assertNamed(shape, err.text);
      var registryMsg = ws.inbox.filter(function (m) { return m.type === "vendor_registry"; })[0];
      assert.ok(registryMsg, "the registry was sent");
      assert.deepEqual(registryMsg.vendors.filter(function (v) { return v.installed || v.available; }), [], "no agent shown as usable");
      return 0;
    },
  },
  {
    id: "idle-compaction setting (set_idle_compaction)", needsUser: true,
    run: async function (shape) {
      var ws = fakeWs(shape.user);
      ctxFor(true).handleMessage(ws, { type: "set_idle_compaction", value: "off" });
      await until(function () { return ws.inbox.length > 0; }, "the settings answer");
      var res = ws.inbox[0];
      assert.equal(res.ok, false);
      assertNamed(shape, res.error);
      return 0;
    },
  },
];

ACQUIRE_SITES.forEach(function (site) {
  OWNER_SHAPES.forEach(function (shape) {
    if (site.needsUser && !shape.user) return;
    if (site.onlyShape && site.onlyShape !== shape.id) return;
    test("AC4 AC5 " + site.id + ": an owner with " + shape.id + " is refused by name and nothing runs as the daemon", async function () {
      W = ownerWorld(shape);
      try {
        await site.run(shape);
        assert.deepEqual(W.calls.filter(function (c) { return c.command !== "chown"; }), [], "no process was started for it");
      } finally {
        W = null;
      }
    });
  });
});

// --- AC5 at the lookup itself ------------------------------------------------

test("AC5 resolveOsUserInfo tells no-such-user from a failed lookup, and exposes the account's groups", function () {
  W = newWorld({ accounts: [GROUPED] });
  try {
    var info = osUsers.resolveOsUserInfo(GROUPED.name);
    assert.deepEqual([info.uid, info.gid, info.home, info.user], [GROUPED.uid, GROUPED.gid, GROUPED.home, GROUPED.name]);
    assert.deepEqual(info.groups, extras(GROUPED));
    assert.throws(function () { osUsers.resolveOsUserInfo("clay-nobody"); }, { code: "OS_USER_NOT_FOUND" });
    assert.throws(function () { osUsers.resolveOsUserInfo("Not A User"); }, { code: "OS_USER_INVALID" });
    W.getentFailure = true;
    assert.throws(function () { osUsers.resolveOsUserInfo(GROUPED.name); }, { code: "OS_USER_LOOKUP_FAILED" });
  } finally {
    W = null;
  }
});

test("AC5 the identity lookup's own errors keep their meaning for the session identity", function () {
  var owner = require("../lib/identity/owner");
  var warnings = [];
  var warn = function (m) { warnings.push(m); };
  W = newWorld({ accounts: [] });
  try {
    assert.deepEqual(owner.resolveOwner("clay-nobody", osUsers.resolveOsUserInfo, warn), { unresolved: true });
    assert.deepEqual(warnings, [], "no such user is the expected outcome and is not logged");
    W.getentFailure = true;
    assert.deepEqual(owner.resolveOwner("clay-nobody", osUsers.resolveOsUserInfo, warn), { unresolved: true });
    assert.equal(warnings.length, 1, "a failed lookup is logged as unexpected");
  } finally {
    W = null;
  }
});

// --- Sessions with no owner keep today's behaviour (P6), and os-users off -------

test("P6 a session with no ownerId is not refused by the owner check", async function () {
  W = newWorld({});
  try {
    var b = makeBridge(true);
    try { await b.bridge.startQuery({ localId: 12, vendor: "claude", history: [] }, "hello", undefined, null); } catch (e) { /* it goes on to start; the stand-in runtime stops it */ }
    var owned = b.recorded.filter(function (m) { return m.type === "error" && /^OS_/.test(String(m.code)); });
    assert.deepEqual(owned, []);
  } finally {
    W = null;
  }
});

test("AC7 os-users off: a terminal gets no uid, gid or account environment", async function () {
  W = newWorld({});
  try {
    require("../lib/terminal").createTerminal(PROJ, 80, 24, null);
    var call = W.calls[0];
    assert.equal(call.options.uid, undefined);
    assert.equal(call.options.gid, undefined);
    assert.equal(isSetpriv(call.command), false);
    assert.equal(call.options.env.HOME, process.env.HOME || os.homedir());
  } finally {
    W = null;
  }
});

test("AC7 os-users off: a skill install and a project clone keep the daemon's identity and environment", async function () {
  W = newWorld({ spawnExit: true });
  try {
    var res = await httpRound(ctxFor(false), "POST", "/api/install-skill", { id: "u1", role: "admin", username: "a" }, { url: "https://example.invalid/r", skill: "demo", scope: "project" });
    assert.equal(res.status, 200);
    var install = W.calls.filter(function (c) { return c.command === "npx"; })[0];
    assert.equal(install.options.uid, undefined);
    assert.equal(install.options.gid, undefined);
    assert.equal(install.options.env, undefined, "the daemon's own environment is inherited, as before");

    var bootstrap = require("../lib/project-bootstrap");
    assert.equal(bootstrap.resolveCreator(false, { linuxUser: "clay-plain" }), null);
    var spec = bootstrap.cloneSpawnSpec(null, { args: ["clone", "--", "u", "d"], envOverrides: { GIT_ALLOW_PROTOCOL: "https" } }, PROJ);
    assert.equal(spec.command, "git");
    assert.equal(spec.options.uid, undefined);
    assert.equal(spec.options.env[SENTINEL], process.env[SENTINEL]);
    bootstrap.initRepo({ osUsers: false, wsUser: { linuxUser: "clay-plain" }, targetDir: fs.mkdtempSync(path.join(SANDBOX, "off-")) });
    var init = W.calls.filter(function (c) { return c.command === "git" && c.args[0] === "init"; })[0];
    assert.equal(init.options.uid, undefined);
    assert.equal(init.options.env, undefined);
  } finally {
    W = null;
  }
});

test("AC7 os-users off: git reads run as the daemon, a file listing is served directly, and a Codex server is started as before", async function () {
  W = newWorld({});
  try {
    var repo = fs.mkdtempSync(path.join(SANDBOX, "off-repo-"));
    fs.mkdirSync(path.join(repo, ".git"));
    require("../lib/project-git").runGit(["log", "-1"], { cwd: repo, osUsers: false, exec: function (c, a, o) { record(c, a, o); return ""; } });
    assert.equal(W.calls[0].options.uid, undefined);
    assert.equal(W.calls[0].options.gid, undefined);

    fs.writeFileSync(path.join(PROJ, "visible.txt"), "x");
    var ws = fakeWs({ id: "u1", role: "admin", username: "a" });
    ctxFor(false).handleMessage(ws, { type: "fs_read", path: "visible.txt" });
    var read = ws.inbox.filter(function (m) { return m.type === "fs_read_result"; })[0];
    assert.equal(read.content, "x");
    assert.equal(W.calls.filter(function (c) { return c.command === process.execPath; }).length, 0, "no helper process was started");

    appServers.length = 0;
    var adapter = yoke.createAdapter({ vendor: "codex", cwd: PROJ, slug: "off", osUsers: false });
    await adapter.init({ cwd: PROJ, runtimeEnv: null });
    assert.equal(appServers.length, 1);
    assert.equal(appServers[0].opts.osUserInfo, undefined);
    await adapter.shutdown();
  } finally {
    W = null;
  }
});

// --- AC6: Codex in os-users mode ---------------------------------------------------

test("AC6 Codex is offered in os-users mode: the registry, the probe and adapter creation no longer refuse it", function () {
  W = newWorld({});
  appServers.length = 0;
  try {
    yoke.invalidateAuthCache();
    assert.equal(yoke.registry.get("codex").osUsersSupported, true);
    assert.equal(yoke.registry.disabledByOsUsers("codex", true), false);
    var state = require("../lib/yoke/install-probe").detectVendorInstallState("clay-grouped", { osUsers: true });
    assert.notEqual(state.installed.indexOf("codex"), -1);
    assert.ok(!state.details.codex.reason, "no os-users reason is given: " + state.details.codex.reason);
    var made = yoke.createAdapters({ cwd: PROJ, slug: "offered", osUsers: true });
    assert.equal(typeof made.adapters.codex, "object");
    assert.equal(appServers.length, 0, "creating the adapter starts no app-server");
  } finally {
    W = null;
  }
});

test("AC6 two mapped accounts in one project get two app-servers, each with its own uid, gid, groups and HOME, never shared or the daemon's", async function () {
  appServers.length = 0;
  W = newWorld({ accounts: [GROUPED, PLAIN] });
  try {
    var adapter = yoke.createAdapter({ vendor: "codex", cwd: PROJ, slug: "two", osUsers: true });
    await adapter.init({ cwd: PROJ, linuxUser: GROUPED.name, runtimeEnv: null });
    await adapter.init({ cwd: PROJ, linuxUser: PLAIN.name, runtimeEnv: null });
    await adapter.init({ cwd: PROJ, linuxUser: GROUPED.name, runtimeEnv: null });
    assert.equal(appServers.length, 2, "one per account; the second start for an account reuses its server");
    var a = appServers[0].opts.osUserInfo;
    var b = appServers[1].opts.osUserInfo;
    assert.deepEqual([a.user, a.uid, a.gid, a.home, a.groups], [GROUPED.name, GROUPED.uid, GROUPED.gid, GROUPED.home, extras(GROUPED)]);
    assert.deepEqual([b.user, b.uid, b.gid, b.home, b.groups], [PLAIN.name, PLAIN.uid, PLAIN.gid, PLAIN.home, extras(PLAIN)]);
    assert.notEqual(a.uid, process.getuid(), "not the daemon's account");
    appServers.forEach(function (s) { assert.equal(s.opts.env, undefined, "no daemon environment is laid under the server's"); });
    await adapter.shutdown();
  } finally {
    W = null;
  }
});

test("AC6 no app-server starts in os-users mode for a caller with no account, a gone account or a failed lookup", async function () {
  appServers.length = 0;
  W = newWorld({ accounts: [PLAIN] });
  try {
    var adapter = yoke.createAdapter({ vendor: "codex", cwd: PROJ, slug: "none", osUsers: true });
    await assert.rejects(adapter.init({ cwd: PROJ, runtimeEnv: null }), { code: "CODEX_OS_USER_REQUIRED" });
    await assert.rejects(adapter.init({ cwd: PROJ, linuxUser: "clay-gone", runtimeEnv: null }), { code: "OS_USER_ACCOUNT_GONE" });
    W.getentFailure = true;
    await assert.rejects(adapter.init({ cwd: PROJ, linuxUser: PLAIN.name, runtimeEnv: null }), { code: "OS_USER_LOOKUP_FAILED" });
    assert.equal(appServers.length, 0);
  } finally {
    W = null;
  }
});

// --- The groups a child really gets (root only) -----------------------------------

function hostHasSetpriv() {
  return REAL_PATH.split(path.delimiter).some(function (d) {
    try { fs.accessSync(path.join(d, "setpriv"), fs.constants.X_OK); return true; } catch (e) { return false; }
  });
}

var GROUP_PROBE = "process.stdout.write(JSON.stringify(process.getgroups().sort(function(a,b){return a-b;})))";
var REAL_ACCOUNT = { uid: 52101, gid: 52101, user: "synthetic", home: "/nonexistent", shell: "/bin/sh", groups: [52102, 52103] };
var DAEMON_GROUP = 52999;

function asDaemonWithGroup(fn) {
  var before = process.getgroups();
  process.setgroups([DAEMON_GROUP]);
  try { return fn(); } finally { process.setgroups(before); }
}

function rootGate(t) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) { t.skip("needs root to run a child as another uid"); return false; }
  return true;
}

test("AC1 AC3 a real child started through the helper has the account's groups and none of the daemon's", function (t) {
  if (!rootGate(t)) return;
  if (!hostHasSetpriv()) { t.skip("setpriv is not installed on this host"); return; }
  var groups;
  try {
    groups = asDaemonWithGroup(function () {
      var spec = withPathSync(REAL_PATH, function () { return osUsers.asUser(REAL_ACCOUNT, process.execPath, ["-e", GROUP_PROBE], { encoding: "utf8", cwd: SANDBOX }); });
      return JSON.parse(real.execFileSync(spec.command, spec.args, spec.options));
    });
  } catch (e) {
    t.skip("the host cannot run this node binary as another uid: " + String(e.message).split("\n")[0]);
    return;
  }
  assert.ok(groups.indexOf(52102) !== -1 && groups.indexOf(52103) !== -1, "the account's supplementary groups are set: " + groups);
  assert.equal(groups.indexOf(DAEMON_GROUP), -1, "the daemon's group is gone: " + groups);
  assert.equal(groups.indexOf(0), -1);
});

function withPathSync(p, fn) {
  var saved = process.env.PATH;
  process.env.PATH = p;
  try { return fn(); } finally { process.env.PATH = saved; }
}

test("finding: a node child started with uid and gid drops the daemon's groups; a node-pty child keeps them", function (t) {
  if (!rootGate(t)) return;
  var nodeChild;
  try {
    nodeChild = asDaemonWithGroup(function () {
      return JSON.parse(real.execFileSync(process.execPath, ["-e", GROUP_PROBE], { encoding: "utf8", uid: 52101, gid: 52101, cwd: SANDBOX }));
    });
  } catch (e) {
    t.skip("the host cannot run this node binary as another uid: " + String(e.message).split("\n")[0]);
    return;
  }
  assert.equal(nodeChild.indexOf(DAEMON_GROUP), -1, "node (libuv) clears the group list when gid is set: " + nodeChild);

  var realPty;
  try { realPty = originalLoad.call(Module, "@lydell/node-pty", module, false); } catch (e) { t.skip("node-pty is not installed"); return; }
  return new Promise(function (resolve, reject) {
    var out = "";
    var term;
    try {
      asDaemonWithGroup(function () {
        term = realPty.spawn(process.execPath, ["-e", GROUP_PROBE], { name: "xterm", cols: 80, rows: 24, cwd: SANDBOX, env: { PATH: process.env.PATH }, uid: 52101, gid: 52101 });
      });
    } catch (e) { t.skip("a pty cannot be opened here: " + e.message); resolve(); return; }
    term.onData(function (d) { out += d; });
    term.onExit(function () {
      try {
        var m = out.match(/\[[0-9,]*\]/);
        if (!m) { t.skip("the pty child could not run this node binary as another uid: " + out.trim()); resolve(); return; }
        assert.notEqual(JSON.parse(m[0]).indexOf(DAEMON_GROUP), -1, "node-pty sets uid and gid but keeps the daemon's groups: " + m[0]);
        resolve();
      } catch (e) { reject(e); }
    });
  });
});

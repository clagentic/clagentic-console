// `clagentic-console settings get|set|list`: the registry, the CLI parsing, the
// daemon IPC (against a spawned daemon, so the real switch cases run), and the
// help and guard wiring. A set must read back from the daemon, a refused value
// must save nothing, and the validator must be the Settings page's.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");
var net = require("net");
var { spawn, execFile, execFileSync } = require("child_process");

var { sendIPCCommand } = require("../lib/ipc");
var registry = require("../lib/settings-registry");
var { handleSettingsCommand } = require("../lib/settings-ipc");
var { parseSettingsArgs, parseValue } = require("../lib/cli/settings-subcommands");
var promptExpirySettings = require("../lib/prompt-expiry-settings");

var ROOT = path.resolve(__dirname, "..");
var DAEMON_SCRIPT = path.join(ROOT, "lib", "daemon.js");
var CLI = path.join(ROOT, "bin", "cli.js");
var KEY = "promptExpiryMinutes";
var WIDTH_KEY = "chatWidth";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("registry: reads the default when unset and a stored value otherwise", function () {
  var entry = registry.findSetting(KEY);
  assert.equal(entry.default, 30);
  assert.equal(entry.read({}), 30);
  assert.equal(entry.read({ promptExpiryMinutes: 10 }), 10);
});

[
  [10, true],
  [0, true],
  [35791, true],
  [-1, false],
  [99999, false],
  [1.5, false],
  ["abc", false],
  ["10", false],
  [undefined, false],
].forEach(function (row) {
  test("registry: pick " + JSON.stringify(row[0]) + (row[1] ? " is accepted" : " is refused with the shared reason"), function () {
    var picked = registry.findSetting(KEY).pick(row[0]);
    assert.equal(picked.ok, row[1]);
    if (row[1]) assert.equal(picked.value, row[0]);
    else assert.match(picked.reason, /whole number of minutes from 0/);
  });
});

test("registry: apply stores a value and removes the key at the default", function () {
  var entry = registry.findSetting(KEY);
  var cfg = {};
  entry.apply(cfg, 10);
  assert.equal(cfg.promptExpiryMinutes, 10);
  entry.apply(cfg, 30);
  assert.equal("promptExpiryMinutes" in cfg, false);
});

test("registry: an unknown key and inherited names are not settings", function () {
  assert.equal(registry.findSetting("nope"), null);
  assert.equal(registry.findSetting("constructor"), null);
  assert.equal(registry.findSetting("__proto__"), null);
  assert.deepEqual(registry.settingKeys(), [KEY, WIDTH_KEY]);
});

// The chat width default: the same list the browser and the profile use, and no
// bubble/channel entry.
[
  ["compact", true],
  ["comfortable", true],
  ["wide", true],
  ["full", true],
  ["bubble", false],
  ["channel", false],
  ["Wide", false],
  ["", false],
  [820, false],
  [undefined, false],
].forEach(function (row) {
  test("registry: chatWidth pick " + JSON.stringify(row[0]) + (row[1] ? " is accepted" : " is refused naming the steps"), function () {
    var picked = registry.findSetting(WIDTH_KEY).pick(row[0]);
    assert.equal(picked.ok, row[1]);
    if (row[1]) assert.equal(picked.value, row[0]);
    else assert.match(picked.reason, /compact, comfortable, wide, full/);
  });
});

test("registry: chatWidth reads the default when unset, stores a step and removes the key at the default", function () {
  var entry = registry.findSetting(WIDTH_KEY);
  assert.equal(entry.default, "comfortable");
  assert.equal(entry.read({}), "comfortable");
  assert.equal(entry.read({ chatWidth: "bubble" }), "comfortable", "a stale value is not a step");
  var cfg = {};
  entry.apply(cfg, "full");
  assert.equal(entry.read(cfg), "full");
  entry.apply(cfg, "comfortable");
  assert.equal("chatWidth" in cfg, false);
  assert.equal(registry.findSetting("chatLayout"), null, "the bubble/channel setting is not offered");
});

test("the registry validator is the Settings page's pickSettingChange, with no second range check", function () {
  var src = fs.readFileSync(path.join(ROOT, "lib", "settings-registry.js"), "utf8");
  assert.match(src, /require\(["']\.\/prompt-expiry-settings["']\)/);
  assert.match(src, /promptExpirySettings\.pickSettingChange\(/);
  assert.doesNotMatch(src, /MAX_MINUTES|isFinite|Math\.floor/);
  var wsSrc = fs.readFileSync(path.join(ROOT, "lib", "project-prompt-expiry-settings.js"), "utf8");
  assert.match(wsSrc, /promptExpirySettings\.pickSettingChange\(/);
  var req = { type: "set_prompt_expiry_settings", promptExpiryMinutes: 99999 };
  assert.equal(registry.findSetting(KEY).pick(99999).reason, promptExpirySettings.pickSettingChange(req).reason);
});

test("daemon: the settings IPC cases route to the shared handler and announce through the page hook", function () {
  var src = fs.readFileSync(DAEMON_SCRIPT, "utf8");
  var start = src.indexOf('case "settings_get"');
  assert.ok(start !== -1);
  var body = src.slice(start, src.indexOf('case "set_pin"', start));
  assert.match(body, /case "settings_set"/);
  assert.match(body, /case "settings_list"/);
  assert.match(body, /handleSettingsCommand/);
  assert.match(body, /relay\.broadcastAll\(settingsHooks\[key\]\.announce\(\)\)/);
  assert.match(src, /set: serverHooks\.onSetPromptExpirySettings/);
  assert.match(src, /announce: serverHooks\.onGetPromptExpirySettings/);
});

// ---------------------------------------------------------------------------
// IPC handler, with fakes
// ---------------------------------------------------------------------------

function fakeDeps(config) {
  var calls = { set: [], announce: [] };
  return {
    calls: calls,
    registry: registry,
    getConfig: function () { return config; },
    set: function (key, value) {
      calls.set.push([key, value]);
      registry.findSetting(key).apply(config, value);
      return true;
    },
    announce: function (key) { calls.announce.push(key); },
  };
}

test("handler: set stores, announces once and reads back from the live config", function () {
  var deps = fakeDeps({});
  var res = handleSettingsCommand(deps, { cmd: "settings_set", key: KEY, value: 10 });
  assert.deepEqual(res, { ok: true, result: "saved", key: KEY, value: 10, default: 30 });
  assert.deepEqual(deps.calls.set, [[KEY, 10]]);
  assert.deepEqual(deps.calls.announce, [KEY]);
});

test("handler: a refused value stores and announces nothing and shows the live value", function () {
  var deps = fakeDeps({ promptExpiryMinutes: 12 });
  var res = handleSettingsCommand(deps, { cmd: "settings_set", key: KEY, value: -1 });
  assert.equal(res.ok, false);
  assert.equal(res.result, "refused");
  assert.equal(res.value, 12);
  assert.equal(deps.calls.set.length, 0);
  assert.equal(deps.calls.announce.length, 0);
});

test("handler: an unknown key is unknown-key for get and set; list names the keys", function () {
  var deps = fakeDeps({});
  ["settings_get", "settings_set"].forEach(function (cmd) {
    var res = handleSettingsCommand(deps, { cmd: cmd, key: "nope", value: 1 });
    assert.equal(res.ok, false);
    assert.equal(res.result, "unknown-key");
    assert.match(res.reason, /promptExpiryMinutes/);
  });
  var listed = handleSettingsCommand(deps, { cmd: "settings_list" });
  assert.deepEqual(listed, { ok: true, result: "listed", settings: [
    { key: KEY, value: 30, default: 30 },
    { key: WIDTH_KEY, value: "comfortable", default: "comfortable" },
  ] });
  assert.equal(deps.calls.set.length, 0);
});

test("handler: a key with no setter is an error, not a silent success", function () {
  var deps = fakeDeps({});
  deps.set = function () { return false; };
  var res = handleSettingsCommand(deps, { cmd: "settings_set", key: KEY, value: 10 });
  assert.equal(res.ok, false);
  assert.equal(res.result, "error");
  assert.equal(deps.calls.announce.length, 0);
});

// ---------------------------------------------------------------------------
// CLI parsing and wiring
// ---------------------------------------------------------------------------

[
  ["10", 10],
  ["true", true],
  ["abc", "abc"],
  ["-1", -1],
  ["\"7\"", "7"],
].forEach(function (row) {
  test("cli: value " + row[0] + " parses to " + JSON.stringify(row[1]), function () {
    assert.deepEqual(parseValue(row[0]), row[1]);
  });
});

test("cli: parses the three subcommands", function () {
  assert.deepEqual(parseSettingsArgs(["get", KEY]).request, { cmd: "settings_get", key: KEY });
  assert.deepEqual(parseSettingsArgs(["set", KEY, "10"]).request, { cmd: "settings_set", key: KEY, value: 10 });
  assert.deepEqual(parseSettingsArgs(["list"]).request, { cmd: "settings_list" });
  assert.equal(parseSettingsArgs(["--help"]).help, true);
  assert.equal(parseSettingsArgs(["set", "--help"]).help, true);
});

[
  [[], /Missing settings subcommand/],
  [["frob"], /Unknown settings subcommand/],
  [["get"], /Missing argument/],
  [["set", KEY], /Missing argument/],
  [["get", KEY, "x"], /Unexpected argument/],
  [["list", "x"], /Unexpected argument/],
  [["constructor"], /Unknown settings subcommand/],
].forEach(function (row) {
  test("cli: usage error for " + JSON.stringify(row[0]), function () {
    assert.match(parseSettingsArgs(row[0]).error, row[1]);
  });
});

function runCli(args, env) {
  return new Promise(function (resolve) {
    execFile(process.execPath, [CLI].concat(args), { env: Object.assign({}, process.env, env || {}), encoding: "utf8" }, function (err, stdout, stderr) {
      resolve({ code: err ? err.code : 0, stdout: stdout, stderr: stderr });
    });
  });
}

test("cli: --help prints usage and exits 0; the top-level help lists the verb", function () {
  var help = execFileSync(process.execPath, [CLI, "settings", "--help"], { encoding: "utf8" });
  assert.match(help, /clagentic-console settings get <key>/);
  var top = execFileSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.match(top, /clagentic-console settings set <key> <value>/);
  assert.match(top, /clagentic-console settings list/);
});

test("cli: a usage error exits 1 with usage on stderr and no daemon contact", function () {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr-b007d5-cli-"));
  return runCli(["settings", "set", KEY], { CLAGENTIC_HOME: home, CLAGENTIC_CONFIG: path.join(home, "daemon.json") }).then(function (r) {
    fs.rmSync(home, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stdout, /"result"/);
    assert.match(r.stderr, /Usage: clagentic-console settings get/);
    assert.doesNotMatch(r.stderr, /no running daemon/);
  });
});

test("cli: the verb is routed before the unknown-argument guard", function () {
  var src = fs.readFileSync(CLI, "utf8");
  assert.ok(src.indexOf('args[0] === "settings"') !== -1);
  assert.ok(src.indexOf('args[0] === "settings"') < src.indexOf("findUnrecognisedArg(args)"));
});

// ---------------------------------------------------------------------------
// Spawned daemon: the real IPC cases and the real CLI
// ---------------------------------------------------------------------------

var tmpHome = null;
var daemonProc = null;
var daemonLog = [];
var sockPath = null;
var configFile = null;
var daemonEnv = null;

function findFreePort() {
  return new Promise(function (resolve, reject) {
    var srv = net.createServer();
    srv.listen(0, "127.0.0.1", function () {
      var p = srv.address().port;
      srv.close(function () { resolve(p); });
    });
    srv.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function waitForIpc(timeoutMs) {
  var start = Date.now();
  function attempt() {
    if (Date.now() - start > timeoutMs) {
      return Promise.reject(new Error("daemon IPC did not answer within " + timeoutMs + " ms\n" + daemonLog.slice(-30).join("")));
    }
    if (!fs.existsSync(sockPath)) return sleep(100).then(attempt);
    return sendIPCCommand(sockPath, { cmd: "get_status" }, 1000).then(function (resp) {
      return resp && resp.ok ? resp : sleep(100).then(attempt);
    });
  }
  return attempt();
}

function readPersisted() {
  return JSON.parse(fs.readFileSync(configFile, "utf8"));
}

function waitForPersisted(predicate, timeoutMs) {
  var start = Date.now();
  function attempt() {
    var cfg = readPersisted();
    if (predicate(cfg)) return Promise.resolve(cfg);
    if (Date.now() - start > timeoutMs) {
      return Promise.reject(new Error("persisted config never satisfied predicate: " + JSON.stringify(cfg)));
    }
    return sleep(50).then(attempt);
  }
  return attempt();
}

function killAndWait(proc) {
  return new Promise(function (resolve) {
    if (proc.exitCode !== null) { resolve(); return; }
    proc.once("exit", resolve);
    try { proc.kill("SIGTERM"); } catch (_) {}
    setTimeout(function () {
      try { proc.kill("SIGKILL"); } catch (_) {}
      resolve();
    }, 4000);
  });
}

function send(msg) {
  return sendIPCCommand(sockPath, msg, 3000);
}

test.before(function () {
  return findFreePort().then(function (port) {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr-b007d5-"));
    var consoleDir = path.join(tmpHome, "console");
    fs.mkdirSync(consoleDir, { recursive: true });
    configFile = path.join(consoleDir, "daemon.json");
    sockPath = path.join(consoleDir, "daemon.sock");
    fs.writeFileSync(configFile, JSON.stringify({ port: port, host: "127.0.0.1", tls: false, debug: false, projects: [] }, null, 2), { mode: 0o600 });
    daemonEnv = Object.assign({}, process.env, { CLAGENTIC_HOME: tmpHome, CLAGENTIC_CONFIG: configFile });
    daemonProc = spawn(process.execPath, [DAEMON_SCRIPT], { env: daemonEnv, stdio: ["ignore", "pipe", "pipe"] });
    daemonProc.stdout.on("data", function (d) { daemonLog.push(d.toString()); });
    daemonProc.stderr.on("data", function (d) { daemonLog.push("[err] " + d.toString()); });
    return waitForIpc(20000).then(function () {
      return waitForPersisted(function (c) { return c.pid === daemonProc.pid; }, 20000);
    });
  });
});

test.after(function () {
  var stop = daemonProc ? killAndWait(daemonProc) : Promise.resolve();
  return stop.then(function () {
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });
});

test("daemon: an invalid value and an unknown key are refused and nothing is saved", function () {
  var before = fs.readFileSync(configFile, "utf8");
  var bad = [-1, 99999, "abc"].map(function (v) {
    return function () {
      return send({ cmd: "settings_set", key: KEY, value: v }).then(function (res) {
        assert.equal(res.ok, false);
        assert.equal(res.result, "refused");
        assert.equal(res.value, 30);
        assert.match(res.reason, /whole number of minutes from 0/);
      });
    };
  });
  bad.push(function () {
    return send({ cmd: "settings_set", key: "nope", value: 1 }).then(function (res) {
      assert.equal(res.ok, false);
      assert.equal(res.result, "unknown-key");
    });
  });
  return bad.reduce(function (p, step) { return p.then(step); }, Promise.resolve()).then(function () {
    return sleep(400);
  }).then(function () {
    assert.equal(fs.readFileSync(configFile, "utf8"), before);
  });
});

test("cli against the daemon: set 10 reads back 10, get returns 10 and the default, list shows it, then 30 clears it", function () {
  var cliEnv = { CLAGENTIC_HOME: tmpHome, CLAGENTIC_CONFIG: configFile };
  return runCli(["settings", "set", KEY, "10"], cliEnv).then(function (r) {
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, result: "saved", key: KEY, value: 10, default: 30 });
    return waitForPersisted(function (c) { return c.promptExpiryMinutes === 10; }, 3000);
  }).then(function () {
    return runCli(["settings", "get", KEY], cliEnv);
  }).then(function (r) {
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, result: "read", key: KEY, value: 10, default: 30 });
    return runCli(["settings", "list"], cliEnv);
  }).then(function (r) {
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).settings, [
      { key: KEY, value: 10, default: 30 },
      { key: WIDTH_KEY, value: "comfortable", default: "comfortable" },
    ]);
    return runCli(["settings", "set", KEY, "abc"], cliEnv);
  }).then(function (r) {
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stdout).result, "refused");
    return runCli(["settings", "get", "nope"], cliEnv);
  }).then(function (r) {
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stdout).result, "unknown-key");
    return runCli(["settings", "set", KEY, "30"], cliEnv);
  }).then(function (r) {
    assert.equal(r.code, 0, r.stderr);
    return waitForPersisted(function (c) { return !("promptExpiryMinutes" in c); }, 3000);
  });
});

test("cli against the daemon: chatWidth set wide reads back wide and persists, a bubble value is refused, comfortable clears the key", function () {
  var cliEnv = { CLAGENTIC_HOME: tmpHome, CLAGENTIC_CONFIG: configFile };
  return runCli(["settings", "set", WIDTH_KEY, "wide"], cliEnv).then(function (r) {
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, result: "saved", key: WIDTH_KEY, value: "wide", default: "comfortable" });
    return waitForPersisted(function (c) { return c.chatWidth === "wide"; }, 3000);
  }).then(function () {
    return runCli(["settings", "get", WIDTH_KEY], cliEnv);
  }).then(function (r) {
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, result: "read", key: WIDTH_KEY, value: "wide", default: "comfortable" });
    return runCli(["settings", "set", WIDTH_KEY, "bubble"], cliEnv);
  }).then(function (r) {
    assert.equal(r.code, 1);
    var out = JSON.parse(r.stdout);
    assert.equal(out.result, "refused");
    assert.equal(out.value, "wide", "the refused value saved nothing");
    return runCli(["settings", "set", WIDTH_KEY, "comfortable"], cliEnv);
  }).then(function (r) {
    assert.equal(r.code, 0, r.stderr);
    return waitForPersisted(function (c) { return !("chatWidth" in c); }, 3000);
  });
});

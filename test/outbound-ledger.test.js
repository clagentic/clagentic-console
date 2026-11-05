"use strict";
// The ledger holds message-adjacent data on disk and sits on the send path, so
// it must keep its files private, expire old entries, and never let a failed
// write break the send that triggered it.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var {
  createOutboundLedger, retentionDaysFrom, DEFAULT_RETENTION_DAYS,
} = require("../lib/outbound-ledger");

var DAY = 24 * 60 * 60 * 1000;
var NOW = Date.parse("2026-06-30T12:00:00Z");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "outbound-ledger-"));
}

function quietLog() {
  var calls = { error: [], warn: [], log: [] };
  return {
    calls: calls,
    error: function () { calls.error.push([].slice.call(arguments).join(" ")); },
    warn: function () { calls.warn.push([].slice.call(arguments).join(" ")); },
    log: function () { calls.log.push([].slice.call(arguments).join(" ")); },
  };
}

function ledgerIn(dir, extra) {
  return createOutboundLedger(Object.assign({
    getBaseDir: function () { return dir; },
    now: function () { return NOW; },
    log: quietLog(),
  }, extra || {}));
}

function extracted(over) {
  return Object.assign({
    ts: new Date(NOW).toISOString(),
    verb: "send_input",
    result: "delivered",
    sender: { kind: "extracted", attribution: "extracted", project: "p", sessionId: "5", cliSessionId: "cli-5", name: "agent-a@p" },
    target: { project: "q", sessionId: "9" },
    prompt: "hello",
  }, over || {});
}

function declared(name) {
  return { ts: new Date(NOW).toISOString(), verb: "send_input", result: "delivered", sender: { kind: "declared", attribution: "unverified", name: name }, target: {}, prompt: "x" };
}

function undeclared() {
  return { ts: new Date(NOW).toISOString(), verb: "open_session", result: "refused", sender: { kind: "undeclared", attribution: "unverified" }, target: {}, prompt: "y" };
}

test("an identified sender gets its own file under its project, keyed by the vendor session id", function () {
  var dir = tmp();
  var ledger = ledgerIn(dir);
  assert.equal(ledger.record(extracted()), true);
  var file = path.join(dir, "outbound", "sessions", "p", "cli-5.jsonl");
  var lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).prompt, "hello");
});

test("a sender with no vendor session id yet is keyed by the console id", function () {
  var dir = tmp();
  var ledger = ledgerIn(dir);
  ledger.record(extracted({ sender: { kind: "extracted", attribution: "extracted", project: "p", sessionId: "5" } }));
  assert.ok(fs.existsSync(path.join(dir, "outbound", "sessions", "p", "console-5.jsonl")));
});

test("declared and undeclared senders are kept apart from identified ones", function () {
  var dir = tmp();
  var ledger = ledgerIn(dir);
  ledger.record(declared("builder"));
  ledger.record(undeclared());
  assert.ok(fs.existsSync(path.join(dir, "outbound", "unattributed", "declared", "builder.jsonl")));
  assert.ok(fs.existsSync(path.join(dir, "outbound", "unattributed", "undeclared", "undeclared.jsonl")));
  assert.equal(fs.existsSync(path.join(dir, "outbound", "sessions")), false);
});

function filesBelow(dir) {
  var out = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    var full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(filesBelow(full));
    else out.push(full);
  });
  return out;
}

test("a declared sender cannot name a path", function () {
  var dir = tmp();
  var ledger = ledgerIn(dir);
  assert.equal(ledger.record(declared("../../etc")), true);
  assert.equal(ledger.record(declared("a/b")), true);
  assert.equal(ledger.record(declared("A B")), true);
  assert.equal(ledger.record(declared("A  B")), true);
  assert.equal(ledger.record(extracted({ sender: { kind: "extracted", attribution: "extracted", project: "../p", sessionId: "1" } })), true);
  var root = path.join(dir, "outbound");
  var rels = filesBelow(root).map(function (f) { return path.relative(root, f); });
  // Every write landed inside the ledger root, and distinct names kept distinct files.
  assert.equal(rels.length, 5);
  rels.forEach(function (r) { assert.equal(r.indexOf(".."), -1); });
  var declaredFiles = rels.filter(function (r) { return r.indexOf("unattributed") === 0; });
  assert.equal(declaredFiles.length, 4);
  declaredFiles.forEach(function (r) { assert.match(path.basename(r), /^(x-[0-9a-f]{16}|[A-Za-z0-9_-]+)\.jsonl$/); });
  assert.equal(fs.existsSync(path.join(dir, "etc.jsonl")), false);
});

test("directories are 0700 and files 0600", function () {
  if (process.platform === "win32") return;
  var dir = tmp();
  var prev = process.umask(0o022);
  try {
    ledgerIn(dir).record(extracted());
  } finally {
    process.umask(prev);
  }
  var mode = function (p) { return fs.statSync(p).mode & 0o777; };
  assert.equal(mode(path.join(dir, "outbound")), 0o700);
  assert.equal(mode(path.join(dir, "outbound", "sessions", "p")), 0o700);
  assert.equal(mode(path.join(dir, "outbound", "sessions", "p", "cli-5.jsonl")), 0o600);
});

test("retention: default 30 days, whole days 0 to 3650, anything else falls back and says so", function () {
  assert.equal(DEFAULT_RETENTION_DAYS, 30);
  assert.deepEqual(retentionDaysFrom(undefined), { days: 30 });
  assert.deepEqual(retentionDaysFrom(7), { days: 7 });
  assert.deepEqual(retentionDaysFrom(0), { days: 0 });
  ["7", -1, 1.5, 4000, NaN, {}].forEach(function (bad) {
    assert.deepEqual(retentionDaysFrom(bad), { days: 30, invalid: true }, String(bad));
  });
  var log = quietLog();
  var ledger = ledgerIn(tmp(), { getRetentionDays: function () { return "soon"; }, log: log });
  assert.equal(ledger.retentionDays(), 30);
  ledger.retentionDays();
  assert.equal(log.calls.warn.length, 1);
});

test("retention is read at use, so a change in daemon.json needs no restart", function () {
  var days = 30;
  var ledger = ledgerIn(tmp(), { getRetentionDays: function () { return days; } });
  assert.equal(ledger.retentionDays(), 30);
  days = 3;
  assert.equal(ledger.retentionDays(), 3);
});

test("prune drops expired lines, keeps current ones, and removes a file left empty", function () {
  var dir = tmp();
  var ledger = ledgerIn(dir, { getRetentionDays: function () { return 30; } });
  ledger.record(extracted({ ts: new Date(NOW - 31 * DAY).toISOString(), prompt: "old" }));
  ledger.record(extracted({ ts: new Date(NOW - 29 * DAY).toISOString(), prompt: "recent" }));
  ledger.record(extracted({ sender: { kind: "extracted", attribution: "extracted", project: "p", sessionId: "6", cliSessionId: "cli-6" }, ts: new Date(NOW - 40 * DAY).toISOString(), prompt: "gone" }));
  ledger.record(declared("builder"));

  var res = ledger.prune();
  assert.equal(res.removed, 2);

  var kept = fs.readFileSync(path.join(dir, "outbound", "sessions", "p", "cli-5.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(kept.map(function (e) { return e.prompt; }), ["recent"]);
  assert.equal(fs.existsSync(path.join(dir, "outbound", "sessions", "p", "cli-6.jsonl")), false);
  assert.ok(fs.existsSync(path.join(dir, "outbound", "unattributed", "declared", "builder.jsonl")));
  assert.deepEqual(fs.readdirSync(path.join(dir, "outbound", "sessions", "p")), ["cli-5.jsonl"]);
});

test("prune ignores ENOTEMPTY and ENOENT from rmdir and logs any other failure once, with path and errno", function () {
  var dir = tmp();
  var log = quietLog();
  var ledger = createOutboundLedger({ getBaseDir: function () { return dir; }, now: function () { return NOW; }, getRetentionDays: function () { return 30; }, log: log });
  ledger.record(extracted({ ts: new Date(NOW - 40 * DAY).toISOString(), prompt: "old" }));
  var real = fs.rmdirSync;
  var code = "EACCES";
  fs.rmdirSync = function () { var e = new Error("denied"); e.code = code; throw e; };
  try {
    ledger.prune();
    assert.equal(log.calls.error.length, 1);
    assert.match(log.calls.error[0], /could not remove the directory .*sessions.*EACCES/);
    ledger.record(extracted({ ts: new Date(NOW - 40 * DAY).toISOString(), prompt: "old again" }));
    ledger.prune();
    assert.equal(log.calls.error.length, 1, "the same path and errno is logged once");
    ["ENOTEMPTY", "ENOENT"].forEach(function (c) {
      code = c;
      ledger.record(extracted({ ts: new Date(NOW - 40 * DAY).toISOString(), prompt: "old " + c }));
      ledger.prune();
    });
    assert.equal(log.calls.error.length, 1, "ENOTEMPTY and ENOENT are not logged");
  } finally {
    fs.rmdirSync = real;
  }
});

test("prune honours a configured retention, and 0 removes everything and turns the ledger off", function () {
  var dir = tmp();
  var days = 7;
  var ledger = ledgerIn(dir, { getRetentionDays: function () { return days; } });
  ledger.record(extracted({ ts: new Date(NOW - 8 * DAY).toISOString(), prompt: "eight days" }));
  ledger.record(extracted({ ts: new Date(NOW - 2 * DAY).toISOString(), prompt: "two days" }));
  assert.equal(ledger.prune().removed, 1);

  days = 0;
  assert.equal(ledger.record(extracted()), false);
  ledger.prune();
  assert.equal(fs.existsSync(path.join(dir, "outbound", "sessions", "p", "cli-5.jsonl")), false);
  assert.deepEqual(ledger.readAttributed(), []);
});

test("a reader never returns an entry past the retention, even before it is pruned", function () {
  var dir = tmp();
  var ledger = ledgerIn(dir);
  ledger.record(extracted({ ts: new Date(NOW - 31 * DAY).toISOString(), prompt: "old" }));
  ledger.record(extracted({ ts: new Date(NOW - DAY).toISOString(), prompt: "new" }));
  assert.deepEqual(ledger.readAttributed().map(function (e) { return e.prompt; }), ["new"]);
});

test("a torn or damaged line is skipped, not fatal", function () {
  var dir = tmp();
  var ledger = ledgerIn(dir);
  ledger.record(extracted({ prompt: "good" }));
  var file = path.join(dir, "outbound", "sessions", "p", "cli-5.jsonl");
  fs.appendFileSync(file, '{"ts": "2026-06-30T12:00:00.000Z", "prom');
  assert.deepEqual(ledger.readAttributed().map(function (e) { return e.prompt; }), ["good"]);
  ledger.prune();
});

test("a write that fails is logged and does not throw", function () {
  var dir = tmp();
  // The ledger directory is a regular file, so nothing can be created in it.
  fs.writeFileSync(path.join(dir, "outbound"), "not a directory");
  var log = quietLog();
  var ledger = ledgerIn(dir, { log: log });
  assert.doesNotThrow(function () {
    assert.equal(ledger.record(extracted()), false);
  });
  assert.equal(log.calls.error.length, 1);
  assert.match(log.calls.error[0], /could not write/);
});

test("reads are limited to a project and to the time asked for", function () {
  var dir = tmp();
  var ledger = ledgerIn(dir);
  ledger.record(extracted({ ts: new Date(NOW - 3 * DAY).toISOString(), prompt: "p-old" }));
  ledger.record(extracted({ ts: new Date(NOW - 1 * DAY).toISOString(), prompt: "p-new" }));
  ledger.record(extracted({ sender: { kind: "extracted", attribution: "extracted", project: "other", sessionId: "1", cliSessionId: "cli-o" }, prompt: "other" }));
  assert.deepEqual(ledger.readAttributed({ project: "p" }).map(function (e) { return e.prompt; }), ["p-old", "p-new"]);
  assert.deepEqual(ledger.readAttributed({ project: "p", sinceMs: NOW - 2 * DAY }).map(function (e) { return e.prompt; }), ["p-new"]);
  assert.equal(ledger.readAttributed().length, 3);
});

test("a ledger that was never written has no entries: absent is empty, not an error", function () {
  var ledger = ledgerIn(path.join(tmp(), "never-created"));
  assert.deepEqual(ledger.readAttributed(), []);
  assert.deepEqual(ledger.readUnattributed(), []);
});

test("a ledger directory that cannot be listed is an error naming the path and errno, never an empty list", function () {
  var dir = tmp();
  // A file where the sessions directory belongs: readdir fails with ENOTDIR.
  fs.mkdirSync(path.join(dir, "outbound"));
  fs.writeFileSync(path.join(dir, "outbound", "sessions"), "not a directory");
  var ledger = ledgerIn(dir);
  assert.throws(function () { ledger.readAttributed(); }, function (e) {
    assert.equal(e.code, "ENOTDIR");
    assert.ok(e.message.indexOf(path.join(dir, "outbound", "sessions")) !== -1, e.message);
    assert.match(e.message, /ENOTDIR/);
    return true;
  });
  // The other side is untouched by the damage to this one.
  assert.deepEqual(ledger.readUnattributed(), []);
});

test("a project directory that cannot be listed is an error too", function () {
  var dir = tmp();
  fs.mkdirSync(path.join(dir, "outbound", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(dir, "outbound", "sessions", "p"), "not a directory");
  assert.throws(function () { ledgerIn(dir).readAttributed(); }, /ENOTDIR/);
});

test("a ledger file that exists but cannot be read is an error naming the file", function () {
  var dir = tmp();
  var ledger = ledgerIn(dir);
  ledger.record(extracted());
  var file = path.join(dir, "outbound", "sessions", "p", "cli-5.jsonl");
  fs.rmSync(file);
  // A directory named like a ledger file: stat succeeds, the read fails with EISDIR.
  fs.mkdirSync(file);
  assert.throws(function () { ledger.readAttributed(); }, function (e) {
    assert.equal(e.code, "EISDIR");
    assert.ok(e.message.indexOf(file) !== -1, e.message);
    return true;
  });
});

test("a project directory that vanishes between the listing and the read is empty, not an error", function () {
  var dir = tmp();
  var ledger = ledgerIn(dir);
  ledger.record(extracted());
  var original = fs.readdirSync;
  fs.readdirSync = function (p) {
    if (String(p).endsWith(path.join("sessions", "p"))) {
      var e = new Error("gone");
      e.code = "ENOENT";
      throw e;
    }
    return original.apply(fs, arguments);
  };
  try {
    assert.deepEqual(ledger.readAttributed(), []);
  } finally {
    fs.readdirSync = original;
  }
});

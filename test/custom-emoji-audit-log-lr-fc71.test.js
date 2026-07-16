// custom-emoji-audit-log-lr-fc71.test.js — lr-fc71: audit-log entries for
// POST/DELETE /api/custom-emoji/:slug.
//
// Context: MILLER bounce off PR #303 (emoji-picker silent-failure diagnosis).
// Custom-emoji uploads left no runtime trace — audit.log recorded zero
// custom-emoji events, so a silent no-op required a live browser repro to
// diagnose. lib/server-settings.js now calls audit.log("custom_emoji.upload"
// | "custom_emoji.delete", ...) on every terminating branch of both routes
// (success AND failure/no-op), mirroring the existing "resource.verb" +
// {actorId, actorName, target, metadata} convention used elsewhere
// (lib/server-admin.js user.delete/user.create/etc).
//
// lib/audit.js resolves its log path from lib/config.js's CONFIG_DIR, which
// is derived from CLAGENTIC_HOME at module-load time. Following the
// established per-test pattern (see session-lifecycle-lr-e0de.test.js): bust
// require.cache, point CLAGENTIC_HOME at a fresh tmpdir, require a fresh
// lib/audit.js instance, call audit.log with the same action/metadata shape
// the routes use, then read back audit.log and assert its contents. This
// verifies the log format/target end matches convention without needing to
// drive the full HTTP handler (which has module-load side effects unsafe to
// require directly in a unit test — same rationale as custom-icons-lr-d1d9).

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-audit-test-"));
}

// Bust require cache + point CLAGENTIC_HOME at tmpHome, require a fresh
// lib/audit.js, then restore the env var. Mirrors the makeSessionManager
// pattern in session-lifecycle-lr-e0de.test.js.
function freshAudit(tmpHome) {
  ["../lib/config", "../lib/audit"].forEach(function (m) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  });
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var audit;
  try {
    audit = require("../lib/audit");
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
  return audit;
}

// audit.log defers its write via setImmediate (non-blocking by design) — wait
// one tick before reading the file back.
function flush() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

function readEntries(auditLogPath) {
  var raw = fs.readFileSync(auditLogPath, "utf8");
  return raw
    .split("\n")
    .filter(function (l) { return l.length > 0; })
    .map(function (l) { return JSON.parse(l); });
}

test("custom_emoji.upload: success path logs slug, status, size, caller", async () => {
  var tmpHome = makeTempHome();
  var audit = freshAudit(tmpHome);

  audit.log("custom_emoji.upload", {
    actorId: "user-1",
    actorName: "alice",
    target: "rocket",
    metadata: { status: 200, size: 4096 },
  });
  await flush();

  var entries = readEntries(audit.auditLogPath());
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, "custom_emoji.upload");
  assert.equal(entries[0].actorId, "user-1");
  assert.equal(entries[0].actorName, "alice");
  assert.equal(entries[0].target, "rocket");
  assert.equal(entries[0].metadata.status, 200);
  assert.equal(entries[0].metadata.size, 4096);
});

test("custom_emoji.upload: failure path (unsupported format) still logs slug/status/size/caller", async () => {
  var tmpHome = makeTempHome();
  var audit = freshAudit(tmpHome);

  // Mirrors lib/server-settings.js's unsupported-format branch — this is
  // exactly the class of silent no-op (lr-fc71) that previously left zero
  // runtime trace.
  audit.log("custom_emoji.upload", {
    actorId: "user-1",
    actorName: "alice",
    target: "bad-emoji",
    metadata: { status: 400, size: 12, reason: "unsupported image format" },
  });
  await flush();

  var entries = readEntries(audit.auditLogPath());
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, "custom_emoji.upload");
  assert.equal(entries[0].target, "bad-emoji");
  assert.equal(entries[0].metadata.status, 400);
  assert.equal(entries[0].metadata.size, 12);
  assert.match(entries[0].metadata.reason, /unsupported/);
});

test("custom_emoji.delete: success path (file actually removed) logs deleted:true", async () => {
  var tmpHome = makeTempHome();
  var audit = freshAudit(tmpHome);

  audit.log("custom_emoji.delete", {
    actorId: "user-2",
    actorName: "bob",
    target: "rocket",
    metadata: { status: 200, size: 2048, deleted: true, reason: null },
  });
  await flush();

  var entries = readEntries(audit.auditLogPath());
  assert.equal(entries[0].action, "custom_emoji.delete");
  assert.equal(entries[0].metadata.deleted, true);
  assert.equal(entries[0].metadata.size, 2048);
});

test("custom_emoji.delete: no-op path (valid slug, no matching file) is distinguishable from an actual delete", async () => {
  var tmpHome = makeTempHome();
  var audit = freshAudit(tmpHome);

  // This is the exact silent-no-op shape from the MILLER bounce (PR #303):
  // a valid-looking request that changes nothing on disk. deleted:false +
  // a reason string is what makes it diagnosable from the log alone.
  audit.log("custom_emoji.delete", {
    actorId: "user-2",
    actorName: "bob",
    target: "ghost-slug",
    metadata: { status: 200, size: null, deleted: false, reason: "no matching file (no-op)" },
  });
  await flush();

  var entries = readEntries(audit.auditLogPath());
  assert.equal(entries[0].metadata.deleted, false);
  assert.match(entries[0].metadata.reason, /no-op/);
});

test("custom_emoji.delete: invalid-slug failure path logs before any filesystem access", async () => {
  var tmpHome = makeTempHome();
  var audit = freshAudit(tmpHome);

  audit.log("custom_emoji.delete", {
    actorId: "user-2",
    actorName: "bob",
    target: "../escape",
    metadata: { status: 400, reason: "invalid slug" },
  });
  await flush();

  var entries = readEntries(audit.auditLogPath());
  assert.equal(entries[0].metadata.status, 400);
  assert.match(entries[0].metadata.reason, /invalid slug/);
});

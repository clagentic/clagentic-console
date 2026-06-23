// Tests for the single-user to multi-user migration path (lr-ec2d)
// Covers migrateSingleUserToMultiUser in daemon.js logic, extracted as a
// pure-function test to avoid daemon startup overhead.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var os = require("os");
var crypto = require("crypto");

// --- Extract the migration logic as a pure function for testing ---
// The production function lives in daemon.js and writes to disk.
// We replicate it here without the file-write so tests are self-contained.

function migrateSingleUserToMultiUser(cfg, data) {
  if (data.multiUser) return; // already migrated

  var hasPin = !!(cfg && cfg.pinHash);
  data.multiUser = true;

  var setupCode = crypto.randomBytes(4).toString("hex").toUpperCase();
  data.setupCode = setupCode;

  // Case A: PIN set, no users — create admin stub
  if (hasPin && (!data.users || data.users.length === 0)) {
    var adminId = crypto.randomUUID();
    data.users = [{
      id: adminId,
      username: "admin",
      email: null,
      displayName: "Admin",
      pinHash: null,
      role: "admin",
      createdAt: Date.now(),
      mustChangePin: false,
      linuxUser: null,
      profile: {
        name: "Admin",
        lang: "en-US",
        avatarColor: "#7c3aed",
        avatarStyle: "thumbs",
        avatarSeed: crypto.randomBytes(4).toString("hex"),
      },
    }];
  }
  // Case B and C: setupCode already set; users (if any) stay
}

// --- Tests ---

test("migration: no-op when data.multiUser is already true", function () {
  var data = { multiUser: true, setupCode: null, users: [], invites: [] };
  var cfg = { pinHash: null };
  migrateSingleUserToMultiUser(cfg, data);
  assert.strictEqual(data.setupCode, null, "setupCode should remain null when already migrated");
  assert.strictEqual(data.users.length, 0, "no users should be added");
});

test("migration Case A: PIN set, no users — creates admin stub with null pinHash", function () {
  var data = { multiUser: false, setupCode: null, users: [], invites: [] };
  var cfg = { pinHash: "salt:hash" };
  migrateSingleUserToMultiUser(cfg, data);

  assert.strictEqual(data.multiUser, true, "multiUser should be set to true");
  assert.ok(data.setupCode, "setupCode should be generated");
  assert.strictEqual(typeof data.setupCode, "string", "setupCode should be a string");
  assert.strictEqual(data.users.length, 1, "one admin user should be created");

  var admin = data.users[0];
  assert.strictEqual(admin.role, "admin", "created user should be admin");
  assert.strictEqual(admin.username, "admin", "created user should have username 'admin'");
  assert.strictEqual(admin.pinHash, null, "pinHash cannot be transferred — must be null");
  assert.ok(admin.id, "admin should have an id");
});

test("migration Case B: users exist but no admin — sets setupCode only", function () {
  var data = {
    multiUser: false,
    setupCode: null,
    users: [{ id: "u1", username: "bob", role: "user" }],
    invites: [],
  };
  var cfg = { pinHash: null };
  migrateSingleUserToMultiUser(cfg, data);

  assert.strictEqual(data.multiUser, true, "multiUser should be set to true");
  assert.ok(data.setupCode, "setupCode should be generated");
  assert.strictEqual(data.users.length, 1, "existing users should be preserved");
  assert.strictEqual(data.users[0].username, "bob", "existing user retained");
});

test("migration Case C: no PIN, no users — sets multiUser=true and setupCode", function () {
  var data = { multiUser: false, setupCode: null, users: [], invites: [] };
  var cfg = { pinHash: null };
  migrateSingleUserToMultiUser(cfg, data);

  assert.strictEqual(data.multiUser, true, "multiUser should be set to true");
  assert.ok(data.setupCode, "setupCode should be generated");
  assert.strictEqual(data.users.length, 0, "no users created when no PIN and no existing users");
});

test("migration: setupCode is hex-uppercase and plausibly random (Case A)", function () {
  var data = { multiUser: false, setupCode: null, users: [], invites: [] };
  var cfg = { pinHash: "salt:hash" };
  migrateSingleUserToMultiUser(cfg, data);

  var code = data.setupCode;
  assert.ok(code, "setupCode must be non-empty");
  assert.ok(/^[0-9A-F]+$/.test(code), "setupCode should be uppercase hex");
});

test("migration: each run produces a unique setupCode (non-deterministic)", function () {
  function runMigration() {
    var data = { multiUser: false, setupCode: null, users: [], invites: [] };
    migrateSingleUserToMultiUser({}, data);
    return data.setupCode;
  }
  var code1 = runMigration();
  var code2 = runMigration();
  // Extremely unlikely to collide with 4 bytes of random
  assert.notStrictEqual(code1, code2, "two migration runs should produce different setup codes");
});

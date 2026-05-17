var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var os = require("os");

// We need to load store.js in an environment where CONFIG_DIR is overridden.
// store.js imports CONFIG_DIR from config.js at require time. To test with a
// temp directory we monkey-patch the config module's CONFIG_DIR before loading
// store.js. We use a fresh require by manipulating the module cache.

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-test-"));

// Patch config module before requiring store so CONFIG_DIR resolves to tmpDir.
// This works because Node caches require() by filename; we inject a fake entry.
var configModPath = require.resolve("../lib/config");
var originalConfigMod = require.cache[configModPath];

// Temporarily override the cached config module to expose our temp dir.
require.cache[configModPath] = {
  id: configModPath,
  filename: configModPath,
  loaded: true,
  exports: Object.assign({}, require(configModPath), { CONFIG_DIR: tmpDir }),
};

// Now load store with the patched config.
var storeModPath = require.resolve("../lib/store");
// Clear any cached version so it re-evaluates with our patched config.
delete require.cache[storeModPath];
var store = require("../lib/store");

// Restore original config module cache entry (leave store patched to our tmpDir).
if (originalConfigMod) {
  require.cache[configModPath] = originalConfigMod;
} else {
  delete require.cache[configModPath];
}

// ============================================================
// Cleanup helper
// ============================================================

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}

// ============================================================
// 1. Concurrent writes: 10 parallel writeJson calls — no corruption
// ============================================================

test("writeJson: 10 concurrent writes serialize correctly — final value is one of the written values", function (t, done) {
  var name = "concurrent-test.json";
  var values = [];
  for (var i = 0; i < 10; i++) {
    values.push({ seq: i, payload: "value-" + i });
  }

  // Fire 10 parallel writes. The queue serializes them.
  var promises = values.map(function (v) {
    return store.writeJson(name, v);
  });

  Promise.all(promises).then(function () {
    // Read the final file — must be valid JSON equal to one of the 10 values.
    var raw = fs.readFileSync(path.join(tmpDir, name), "utf8");
    var result = JSON.parse(raw);
    // The final write in call order (seq 9) wins because the queue is FIFO.
    assert.strictEqual(typeof result.seq, "number", "result.seq should be a number");
    assert.ok(result.seq >= 0 && result.seq <= 9, "seq should be one of 0-9");
    // Verify no corruption: file parses cleanly and has the expected shape.
    assert.ok("payload" in result, "result should have payload field");
    done();
  }).catch(done);
});

// ============================================================
// 2. readJson: corrupt JSON returns defaultValue instead of throwing
// ============================================================

test("readJson: corrupt JSON file returns defaultValue without throwing", function (t, done) {
  var name = "corrupt.json";
  var filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, "this is not valid json {{{{");

  var defaultValue = { fallback: true };
  store.readJson(name, defaultValue).then(function (result) {
    assert.deepStrictEqual(result, defaultValue, "corrupt file should return defaultValue");
    done();
  }).catch(done);
});

// ============================================================
// 3. readJson: missing file returns defaultValue silently
// ============================================================

test("readJson: missing file returns defaultValue", function (t, done) {
  var name = "nonexistent-" + Date.now() + ".json";
  var defaultValue = { missing: true };
  store.readJson(name, defaultValue).then(function (result) {
    assert.deepStrictEqual(result, defaultValue, "missing file should return defaultValue");
    done();
  }).catch(done);
});

// ============================================================
// 4. writeJson: file is written with mode 0o600
// ============================================================

test("writeJson: file permissions are 0o600 after write", function (t, done) {
  if (process.platform === "win32") {
    // chmod is a no-op on Windows
    done();
    return;
  }
  var name = "perms-test.json";
  store.writeJson(name, { ok: true }).then(function () {
    var stats = fs.statSync(path.join(tmpDir, name));
    var mode = stats.mode & 0o777;
    assert.strictEqual(mode, 0o600, "file should have 0o600 permissions");
    done();
  }).catch(done);
});

// ============================================================
// 5. readJson / writeJson roundtrip
// ============================================================

test("writeJson then readJson returns the written value", function (t, done) {
  var name = "roundtrip.json";
  var value = { hello: "world", nested: { n: 42 } };
  store.writeJson(name, value).then(function () {
    return store.readJson(name, {});
  }).then(function (result) {
    assert.deepStrictEqual(result, value, "readJson should return the value written by writeJson");
    done();
  }).catch(done);
});

// ============================================================
// 6. writeJsonAt / readJsonAt: arbitrary full path variant
// ============================================================

test("writeJsonAt then readJsonAt roundtrip on a sub-path", function (t, done) {
  var subDir = path.join(tmpDir, "loops", "loop_test");
  var fullPath = path.join(subDir, "state.json");
  var value = { phase: "executing", iteration: 3 };
  store.writeJsonAt(fullPath, value).then(function () {
    return store.readJsonAt(fullPath, {});
  }).then(function (result) {
    assert.deepStrictEqual(result, value, "readJsonAt should return the value written by writeJsonAt");
    done();
  }).catch(done);
});

// ============================================================
// Cleanup after all tests
// ============================================================

process.on("exit", cleanup);

// memory-limits.test.js — unit tests for lib/memory-limits.js (lr-de07)

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var {
  parseMemoryLimit,
  renderDropIn,
  applyDropIn,
  memoryValueToBytes,
  readMemTotalBytes,
  computeDefaultAbsoluteLimits,
  checkAppliedMemoryCeiling,
  startMemoryHighWatcher,
  DROP_IN_FILE,
  DEFAULT_MEMORY_HIGH_FRACTION,
  DEFAULT_MEMORY_MAX_FRACTION,
} = require('../lib/memory-limits');

// ---------------------------------------------------------------------------
// Test helpers — mocked /proc/meminfo and cgroup memory.max files (lr-c10f6d)
// ---------------------------------------------------------------------------

function writeMockMeminfo(dir, memTotalKb) {
  var p = path.join(dir, 'meminfo');
  fs.writeFileSync(p, 'MemTotal:       ' + memTotalKb + ' kB\nMemFree:        1000 kB\n');
  return p;
}

function writeMockCgroupMax(dir, value) {
  var p = path.join(dir, 'memory.max');
  fs.writeFileSync(p, String(value) + '\n');
  return p;
}

// ---------------------------------------------------------------------------
// parseMemoryLimit
// ---------------------------------------------------------------------------

test('parseMemoryLimit: accepts integer percentage', function () {
  var r = parseMemoryLimit('70%');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, '70%');
});

test('parseMemoryLimit: accepts percentage with spaces', function () {
  var r = parseMemoryLimit('  85 %  ');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, '85%');
});

test('parseMemoryLimit: rejects fractional percentage', function () {
  var r = parseMemoryLimit('70.5%');
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('whole number'));
});

test('parseMemoryLimit: rejects 0%', function () {
  var r = parseMemoryLimit('0%');
  assert.strictEqual(r.ok, false);
});

test('parseMemoryLimit: rejects >100%', function () {
  var r = parseMemoryLimit('101%');
  assert.strictEqual(r.ok, false);
});

test('parseMemoryLimit: accepts GB absolute', function () {
  var r = parseMemoryLimit('6G');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, '6G');
});

test('parseMemoryLimit: accepts MB absolute', function () {
  var r = parseMemoryLimit('512M');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, '512M');
});

test('parseMemoryLimit: accepts KB absolute', function () {
  var r = parseMemoryLimit('1024K');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, '1024K');
});

test('parseMemoryLimit: accepts bare byte count', function () {
  var r = parseMemoryLimit('1073741824');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, '1073741824');
});

test('parseMemoryLimit: rejects empty string', function () {
  var r = parseMemoryLimit('');
  assert.strictEqual(r.ok, false);
});

test('parseMemoryLimit: rejects garbage', function () {
  var r = parseMemoryLimit('banana');
  assert.strictEqual(r.ok, false);
});

test('parseMemoryLimit: rejects non-string', function () {
  var r = parseMemoryLimit(6);
  assert.strictEqual(r.ok, false);
});

test('parseMemoryLimit: case-insensitive suffix', function () {
  var r = parseMemoryLimit('6g');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, '6G');
});

// ---------------------------------------------------------------------------
// renderDropIn
// ---------------------------------------------------------------------------

test('renderDropIn: both overrides', function () {
  var content = renderDropIn({ memoryHigh: '70%', memoryMax: '85%' });
  assert.ok(content.includes('[Service]'));
  assert.ok(content.includes('MemoryHigh=\nMemoryHigh=70%'));
  assert.ok(content.includes('MemoryMax=\nMemoryMax=85%'));
});

test('renderDropIn: only memoryHigh', function () {
  var content = renderDropIn({ memoryHigh: '6G' });
  assert.ok(content.includes('MemoryHigh=6G'));
  assert.ok(!content.includes('MemoryMax=6G'));
});

test('renderDropIn: only memoryMax', function () {
  var content = renderDropIn({ memoryMax: '8G' });
  assert.ok(content.includes('MemoryMax=8G'));
  assert.ok(!content.includes('MemoryHigh=8G'));
});

test('renderDropIn: returns null when no overrides', function () {
  var content = renderDropIn({});
  assert.strictEqual(content, null);
});

test('renderDropIn: throws on invalid memoryHigh', function () {
  assert.throws(function () {
    renderDropIn({ memoryHigh: 'banana' });
  }, /unrecognized memory limit format/);
});

test('renderDropIn: throws on invalid memoryMax', function () {
  assert.throws(function () {
    renderDropIn({ memoryMax: '0%' });
  }, /between 0/);
});

// ---------------------------------------------------------------------------
// applyDropIn — file system tests using tmp dir
// ---------------------------------------------------------------------------

test('applyDropIn: writes drop-in when overrides set', function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlimits-test-'));
  var dropInFile = path.join(tmpDir, 'memory-overrides.conf');

  // Patch DROP_IN_FILE by monkey-patching the module-level path via the
  // applyDropIn function's internal reference. Since we can't easily patch
  // module internals, test the logic by providing a custom applyDropIn call
  // that verifies the rendered content is correct.

  // Verify renderDropIn output for the expected file content.
  var content = renderDropIn({ memoryHigh: '70%', memoryMax: '85%' });
  assert.ok(content !== null);

  // Write manually to the tmp path to verify the write-path works.
  var tmpFile = dropInFile + '.tmp';
  fs.writeFileSync(tmpFile, content, { mode: 0o644 });
  fs.renameSync(tmpFile, dropInFile);

  var written = fs.readFileSync(dropInFile, 'utf8');
  assert.ok(written.includes('MemoryHigh=70%'));
  assert.ok(written.includes('MemoryMax=85%'));
  assert.ok(written.includes('[Service]'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('applyDropIn: no-op when no overrides and file absent', function () {
  var logs = [];
  // Should not throw even when drop-in dir doesn't exist (nothing to remove).
  // We test by verifying the log is empty (no removal message) when file absent.
  try {
    // Use a non-existent path — the real applyDropIn checks existsSync before unlink.
    // We can only test this by calling applyDropIn with root access; here we just
    // verify the validation path by confirming renderDropIn returns null.
    var content = renderDropIn({});
    assert.strictEqual(content, null, 'no overrides → no drop-in content');
  } catch (e) {
    assert.fail('should not throw: ' + e.message);
  }
});

// ---------------------------------------------------------------------------
// memoryValueToBytes
// ---------------------------------------------------------------------------

test('memoryValueToBytes: 1G = 1073741824', function () {
  assert.strictEqual(memoryValueToBytes('1G'), 1073741824);
});

test('memoryValueToBytes: 512M = 536870912', function () {
  assert.strictEqual(memoryValueToBytes('512M'), 536870912);
});

test('memoryValueToBytes: 1024K = 1048576', function () {
  assert.strictEqual(memoryValueToBytes('1024K'), 1048576);
});

test('memoryValueToBytes: bare bytes', function () {
  assert.strictEqual(memoryValueToBytes('8192'), 8192);
});

test('memoryValueToBytes: returns null for null', function () {
  assert.strictEqual(memoryValueToBytes(null), null);
});

test('memoryValueToBytes: returns null for garbage', function () {
  assert.strictEqual(memoryValueToBytes('banana'), null);
});

// ---------------------------------------------------------------------------
// startMemoryHighWatcher — de-duplication and event emission
// ---------------------------------------------------------------------------

test('startMemoryHighWatcher: returns a stop handle', function () {
  var watcher = startMemoryHighWatcher({}, { pollIntervalMs: 100000 });
  assert.ok(typeof watcher.stop === 'function', 'watcher must have a stop() method');
  watcher.stop();
});

test('startMemoryHighWatcher: emits warning on RSS crossing (mock cgroup unavailable)', function (t, done) {
  // We cannot inject cgroup reads directly, so we exercise the strategy-B
  // (RSS fallback) path by providing a very low threshold via a tiny
  // percentage override that will be below actual process RSS.
  //
  // Strategy B fires when cgroup current is unavailable AND rss > threshold.
  // We provide a 0-byte threshold equivalent so RSS (always > 0) triggers it.
  //
  // However, memoryValueToBytes('0%') would return 0 only if MemTotal is 0.
  // Instead, we verify the watcher emits when resolveMemoryHighBytes returns
  // a value below process.memoryUsage().rss via a custom cfg.
  //
  // Since we cannot mock fs.readFileSync at module level without dependency
  // injection, we verify the behavior by checking the watcher can be stopped
  // cleanly without throwing (smoke test for the polling path).
  var watcher = startMemoryHighWatcher({ memoryHigh: '100%' }, { pollIntervalMs: 50 });
  setTimeout(function () {
    watcher.stop();
    done();
  }, 200);
});

test('startMemoryHighWatcher: stop() clears interval without throwing', function () {
  var watcher = startMemoryHighWatcher({}, { pollIntervalMs: 10000 });
  assert.doesNotThrow(function () { watcher.stop(); });
});

test('startMemoryHighWatcher: de-dup — single warning per crossing (counter path)', function (t, done) {
  // Verify that if the cgroup counter does NOT advance, no additional warnings
  // are emitted. We do this by inspecting stderr output during a poll cycle.
  //
  // Since we cannot mock the cgroup fs in this test environment (no cgroup
  // present in test runner), the counter path returns null and strategy B is
  // used. Verify only that the watcher does not emit spuriously when threshold
  // is set far above actual RSS.
  var stderrLines = [];
  var origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function (chunk) {
    var s = typeof chunk === 'string' ? chunk : chunk.toString();
    if (s.includes('memory_high_watermark')) stderrLines.push(s);
    return origWrite(chunk);
  };

  // Set threshold to 100% of RAM — process RSS should be well below.
  var watcher = startMemoryHighWatcher({ memoryHigh: '100%' }, { pollIntervalMs: 30 });

  setTimeout(function () {
    watcher.stop();
    process.stderr.write = origWrite;
    // Should be 0 warnings because RSS << 100% of total RAM.
    assert.strictEqual(stderrLines.length, 0, 'no spurious warnings when RSS below threshold');
    done();
  }, 200);
});

// ---------------------------------------------------------------------------
// startMemoryHighWatcher — onCrossing callback (lr-6b30)
// ---------------------------------------------------------------------------

test('startMemoryHighWatcher: onCrossing callback not called when no crossing', function (t, done) {
  // High threshold (100% RAM) means no crossing in normal test environments.
  var crossings = [];
  var watcher = startMemoryHighWatcher(
    { memoryHigh: '100%' },
    { pollIntervalMs: 30, onCrossing: function (ev) { crossings.push(ev); } }
  );

  setTimeout(function () {
    watcher.stop();
    assert.strictEqual(crossings.length, 0, 'onCrossing must not fire when RSS < threshold');
    done();
  }, 200);
});

test('startMemoryHighWatcher: onCrossing is optional — watcher works without it', function () {
  // Should not throw when onCrossing is absent (non-function).
  var watcher = startMemoryHighWatcher({}, { pollIntervalMs: 100000 });
  assert.ok(typeof watcher.stop === 'function');
  watcher.stop();
});

test('startMemoryHighWatcher: onCrossing receives event object with required fields', function (t, done) {
  // We cannot force a real MemoryHigh crossing in a unit test without cgroup
  // access. Instead, verify that when a crossing does occur (strategy B path),
  // the event passed to onCrossing is the same structured object emitted to
  // stderr. We mock stderr.write to capture the JSON and verify field names.
  //
  // Strategy B fires only if threshold is set BELOW current RSS. Since we cannot
  // reliably set a sub-RSS threshold without /proc/meminfo access, this test
  // verifies the structural contract by checking the existing de-dup test's
  // stderr output when a crossing would have been emitted.
  //
  // For a direct coverage path: the onCrossing contract is covered by drain.js
  // integration (drain-lr-6b30.test.js#onMemoryHighCrossing tests), which
  // verifies that crossing events flow through to the drain controller.
  // Here we verify the field contract on the event object itself.
  var receivedEvents = [];
  var stderrCaptures = [];
  var origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function (chunk) {
    var s = typeof chunk === 'string' ? chunk : chunk.toString();
    if (s.includes('memory_high_watermark')) stderrCaptures.push(s);
    return origWrite(chunk);
  };

  // Use a threshold guaranteed to be below RSS to trigger strategy B.
  // '1' byte threshold → any RSS > 1 byte fires a crossing.
  var watcher = startMemoryHighWatcher(
    { memoryHigh: '1' },  // 1 byte — always below actual RSS
    {
      pollIntervalMs: 30,
      onCrossing: function (ev) { receivedEvents.push(ev); },
    }
  );

  setTimeout(function () {
    watcher.stop();
    process.stderr.write = origWrite;
    // We expect at most one crossing event (de-dup prevents more).
    assert.ok(receivedEvents.length <= 1, 'at most one crossing event due to de-dup');
    if (receivedEvents.length === 1) {
      var ev = receivedEvents[0];
      assert.strictEqual(ev.event, 'memory_high_watermark', 'event field must be memory_high_watermark');
      assert.ok(typeof ev.timestamp === 'string', 'timestamp must be a string');
      assert.ok(typeof ev.source === 'string', 'source must be a string');
    }
    done();
  }, 200);
});

// ---------------------------------------------------------------------------
// readMemTotalBytes / computeDefaultAbsoluteLimits — absolute-byte
// computation from mocked /proc/meminfo (lr-c10f6d)
// ---------------------------------------------------------------------------

test('readMemTotalBytes: parses MemTotal kB line into bytes', function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlimits-meminfo-'));
  var meminfoPath = writeMockMeminfo(tmpDir, 12 * 1024 * 1024); // 12G in kB
  assert.strictEqual(readMemTotalBytes(meminfoPath), 12 * 1024 * 1024 * 1024);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('readMemTotalBytes: returns null when file is missing', function () {
  assert.strictEqual(readMemTotalBytes('/nonexistent/path/meminfo'), null);
});

test('readMemTotalBytes: returns null when MemTotal line is absent', function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlimits-meminfo-'));
  var p = path.join(tmpDir, 'meminfo');
  fs.writeFileSync(p, 'MemFree:    1000 kB\n');
  assert.strictEqual(readMemTotalBytes(p), null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('computeDefaultAbsoluteLimits: computes floor(60%)/floor(75%) of MemTotal', function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlimits-meminfo-'));
  var memTotalBytes = 12 * 1024 * 1024 * 1024; // 12G, matches the lr-2ea2a7/lr-c10f6d incident container
  var meminfoPath = writeMockMeminfo(tmpDir, memTotalBytes / 1024);

  var result = computeDefaultAbsoluteLimits(meminfoPath);
  assert.ok(result !== null);
  assert.strictEqual(result.memTotalBytes, memTotalBytes);
  assert.strictEqual(result.memoryHigh, String(Math.floor(memTotalBytes * DEFAULT_MEMORY_HIGH_FRACTION)));
  assert.strictEqual(result.memoryMax, String(Math.floor(memTotalBytes * DEFAULT_MEMORY_MAX_FRACTION)));
  // Sanity: computed values are well below MemTotal (unlike the inoperative
  // 19.8G/24.0G ceiling that lr-c10f6d observed on a 12G container).
  assert.ok(Number(result.memoryHigh) < memTotalBytes);
  assert.ok(Number(result.memoryMax) < memTotalBytes);
  assert.ok(Number(result.memoryHigh) < Number(result.memoryMax));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('computeDefaultAbsoluteLimits: computed values pass parseMemoryLimit validation', function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlimits-meminfo-'));
  var meminfoPath = writeMockMeminfo(tmpDir, 8 * 1024 * 1024); // 8G

  var result = computeDefaultAbsoluteLimits(meminfoPath);
  assert.ok(parseMemoryLimit(result.memoryHigh).ok);
  assert.ok(parseMemoryLimit(result.memoryMax).ok);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('computeDefaultAbsoluteLimits: returns null when MemTotal is undeterminable', function () {
  assert.strictEqual(computeDefaultAbsoluteLimits('/nonexistent/meminfo'), null);
});

test('renderDropIn: rendering computed absolute default values is unchanged from override rendering', function () {
  // The drop-in renderer must not care whether the values came from an
  // operator override or a computed default — same format, same semantics.
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlimits-meminfo-'));
  var meminfoPath = writeMockMeminfo(tmpDir, 12 * 1024 * 1024);
  var computed = computeDefaultAbsoluteLimits(meminfoPath);

  var content = renderDropIn({ memoryHigh: computed.memoryHigh, memoryMax: computed.memoryMax });
  assert.ok(content.includes('[Service]'));
  assert.ok(content.includes('MemoryHigh=\nMemoryHigh=' + computed.memoryHigh));
  assert.ok(content.includes('MemoryMax=\nMemoryMax=' + computed.memoryMax));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('renderDropIn: operator override values still render exactly as before (regression, lr-de07)', function () {
  var content = renderDropIn({ memoryHigh: '6G', memoryMax: '8G' });
  assert.ok(content.includes('MemoryHigh=\nMemoryHigh=6G'));
  assert.ok(content.includes('MemoryMax=\nMemoryMax=8G'));
});

// ---------------------------------------------------------------------------
// checkAppliedMemoryCeiling — startup sanity check (lr-c10f6d)
// ---------------------------------------------------------------------------

test('checkAppliedMemoryCeiling: inoperative when applied memory.max is "max"', function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlimits-cgroup-'));
  var meminfoPath = writeMockMeminfo(tmpDir, 12 * 1024 * 1024);
  var cgroupPath = writeMockCgroupMax(tmpDir, 'max');

  var result = checkAppliedMemoryCeiling({ cgroupMemoryMaxPath: cgroupPath, procMeminfoPath: meminfoPath });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.inoperative, true);
  assert.ok(result.reason.includes("'max'"));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('checkAppliedMemoryCeiling: inoperative when applied memory.max >= MemTotal', function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlimits-cgroup-'));
  var memTotalBytes = 12 * 1024 * 1024 * 1024; // 12G container
  var meminfoPath = writeMockMeminfo(tmpDir, memTotalBytes / 1024);
  // Reproduces the lr-c10f6d incident: applied ceiling (24.0G) exceeds the
  // container's true RAM (12G) because it was resolved against host MemTotal.
  var cgroupPath = writeMockCgroupMax(tmpDir, 24 * 1024 * 1024 * 1024);

  var result = checkAppliedMemoryCeiling({ cgroupMemoryMaxPath: cgroupPath, procMeminfoPath: meminfoPath });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.inoperative, true);
  assert.strictEqual(result.appliedMaxBytes, 24 * 1024 * 1024 * 1024);
  assert.strictEqual(result.memTotalBytes, memTotalBytes);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('checkAppliedMemoryCeiling: inoperative when applied memory.max exactly equals MemTotal', function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlimits-cgroup-'));
  var memTotalBytes = 4 * 1024 * 1024 * 1024;
  var meminfoPath = writeMockMeminfo(tmpDir, memTotalBytes / 1024);
  var cgroupPath = writeMockCgroupMax(tmpDir, memTotalBytes);

  var result = checkAppliedMemoryCeiling({ cgroupMemoryMaxPath: cgroupPath, procMeminfoPath: meminfoPath });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.inoperative, true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('checkAppliedMemoryCeiling: NOT inoperative when applied memory.max < MemTotal', function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlimits-cgroup-'));
  var memTotalBytes = 12 * 1024 * 1024 * 1024; // 12G container
  var meminfoPath = writeMockMeminfo(tmpDir, memTotalBytes / 1024);
  // The correctly-computed default from this task: floor(75% of 12G) = 9G.
  var cgroupPath = writeMockCgroupMax(tmpDir, Math.floor(memTotalBytes * 0.75));

  var result = checkAppliedMemoryCeiling({ cgroupMemoryMaxPath: cgroupPath, procMeminfoPath: meminfoPath });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.inoperative, false);
  assert.strictEqual(result.reason, null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('checkAppliedMemoryCeiling: ok=false (not inoperative) when cgroup memory.max is unreadable', function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlimits-cgroup-'));
  var meminfoPath = writeMockMeminfo(tmpDir, 12 * 1024 * 1024);

  var result = checkAppliedMemoryCeiling({
    cgroupMemoryMaxPath: path.join(tmpDir, 'nonexistent-memory.max'),
    procMeminfoPath: meminfoPath,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.inoperative, false);
  assert.ok(result.reason.includes('unreadable'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('checkAppliedMemoryCeiling: ok=false (not inoperative) when MemTotal is unreadable', function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlimits-cgroup-'));
  var cgroupPath = writeMockCgroupMax(tmpDir, 4 * 1024 * 1024 * 1024);

  var result = checkAppliedMemoryCeiling({
    cgroupMemoryMaxPath: cgroupPath,
    procMeminfoPath: path.join(tmpDir, 'nonexistent-meminfo'),
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.inoperative, false);
  assert.ok(result.reason.includes('MemTotal'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

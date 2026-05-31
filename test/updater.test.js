var test = require("node:test");
var assert = require("node:assert");

var updater = require("../lib/updater");
var isNewer = updater.isNewer;

// Regression coverage for the silent-downgrade incident: a machine running a
// beta (e.g. 1.3.1-beta.1) was downgraded to an older stable (1.3.0) because the
// updater installed a dist-tag (@latest) without checking the resolved version
// was actually newer than the running one. isNewer is the guard that must hold.

test("isNewer: higher base is newer", function () {
  assert.strictEqual(isNewer("1.4.0", "1.3.0"), true);
  assert.strictEqual(isNewer("1.3.0", "1.4.0"), false);
  assert.strictEqual(isNewer("2.0.0", "1.99.99"), true);
});

test("isNewer: higher patch within same minor is newer", function () {
  assert.strictEqual(isNewer("1.3.1", "1.3.0"), true);
  assert.strictEqual(isNewer("1.3.0", "1.3.1"), false);
});

test("isNewer: a beta with a higher base beats a lower stable", function () {
  // 1.4.0-beta.1 must be considered newer than stable 1.3.0 so a beta-channel
  // machine upgrades forward rather than being pinned to an older latest.
  assert.strictEqual(isNewer("1.4.0-beta.1", "1.3.0"), true);
});

test("isNewer: an older stable is NOT newer than the running beta (no downgrade)", function () {
  // The exact incident: running 1.3.1-beta.1, registry @latest = 1.3.0.
  // isNewer(1.3.0, 1.3.1-beta.1) must be false so the guard refuses the install.
  assert.strictEqual(isNewer("1.3.0", "1.3.1-beta.1"), false);
});

test("isNewer: same-base stable outranks the running pre-release", function () {
  // Promoting a beta to its stable of the same base is a legitimate upgrade.
  assert.strictEqual(isNewer("1.4.0", "1.4.0-beta.1"), true);
  assert.strictEqual(isNewer("1.4.0-beta.1", "1.4.0"), false);
});

test("isNewer: later pre-release of same base is newer", function () {
  assert.strictEqual(isNewer("1.4.0-beta.2", "1.4.0-beta.1"), true);
  assert.strictEqual(isNewer("1.4.0-beta.1", "1.4.0-beta.2"), false);
});

test("isNewer: equal versions are not newer", function () {
  assert.strictEqual(isNewer("1.3.0", "1.3.0"), false);
  assert.strictEqual(isNewer("1.4.0-beta.1", "1.4.0-beta.1"), false);
});

test("isNewer: null/undefined inputs are safe and falsey", function () {
  assert.strictEqual(isNewer(null, "1.3.0"), false);
  assert.strictEqual(isNewer("1.3.0", null), false);
  assert.strictEqual(isNewer(undefined, undefined), false);
});

// Simulate the updater's resolve-then-guard selection across the beta channel's
// two candidate tags. Mirrors the loop in checkAndUpdate / daemon IPC update:
// pick the newest candidate, then only install if it beats the running version.
function pickTarget(current, candidates) {
  var target = null;
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (c && (!target || isNewer(c, target))) target = c;
  }
  if (!target || !isNewer(target, current)) return null; // no-op (no downgrade)
  return target;
}

test("resolve+guard: beta channel picks beta over older latest", function () {
  // current beta, beta tag ahead, latest behind -> upgrade to the beta.
  assert.strictEqual(pickTarget("1.3.1-beta.1", ["1.4.0-beta.1", "1.3.0"]), "1.4.0-beta.1");
});

test("resolve+guard: refuses to downgrade when only an older latest exists", function () {
  // current beta is already ahead of every candidate -> no install at all.
  assert.strictEqual(pickTarget("1.5.0-beta.1", ["1.4.0-beta.1", "1.3.0"]), null);
});

test("resolve+guard: stable channel upgrades to newer latest", function () {
  assert.strictEqual(pickTarget("1.3.0", ["1.4.0"]), "1.4.0");
});

test("resolve+guard: stable channel no-ops when on the newest", function () {
  assert.strictEqual(pickTarget("1.4.0", ["1.4.0"]), null);
});

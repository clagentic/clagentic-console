"use strict";

// The client half of the offer: the first click only asks, and only the
// confirmation carries the token the daemon issued.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var { pathToFileURL } = require("url");

var MODULES = path.join(__dirname, "..", "lib", "public", "modules");
var diagnosticsSrc = fs.readFileSync(path.join(MODULES, "diagnostics.js"), "utf8");

test("the first click sends no token: it only asks the daemon for the offer", function () {
  var m = /restart_for_build_update:\s*function\s*\(\)\s*\{([\s\S]*?)\},\n/.exec(diagnosticsSrc);
  assert.ok(m, "expected the restart_for_build_update handler");
  assert.match(m[1], /sendWs\(\{ type: 'restart_for_build_update' \}\)/);
  assert.doesNotMatch(m[1], /confirmToken/);
});

test("only the confirmation sends a token, and only the one the daemon issued", function () {
  var m = /confirm_build_update_restart:\s*function\s*\(entry\)\s*\{([\s\S]*?)\n  \},/.exec(diagnosticsSrc);
  assert.ok(m, "expected the confirm_build_update_restart handler");
  assert.match(m[1], /entry\.buildUpdate && entry\.buildUpdate\.token/);
  assert.match(m[1], /confirmToken: token/);
  assert.match(m[1], /typeof token === 'string' && token/, "no token, nothing is sent");
});

test("an offer can be declined from the toast and from the panel", function () {
  assert.match(diagnosticsSrc, /_buildDeclineEl\(entry, "toast-diagnostic-action-btn"/);
  assert.match(diagnosticsSrc, /_buildDeclineEl\(entry, "diagnostics-actionable-btn"/);
  assert.match(diagnosticsSrc, /btn\.textContent = "Not now"/);
});

test("the handler allowlist is closed: a diagnostic cannot name an arbitrary action", function () {
  var m = /var ACTIONABLE_HANDLERS = \{([\s\S]*?)\n\};/.exec(diagnosticsSrc);
  var keys = (m[1].match(/^\s{2}([a-z_]+):/gm) || []).map(function (k) { return k.trim().replace(":", ""); });
  assert.deepEqual(keys, ["restart_for_build_update", "confirm_build_update_restart"]);
});

// A DOM small enough to read back what build-update-detail.js builds.
function fakeDocument() {
  function el(tag) {
    return {
      tag: tag, className: "", children: [], _text: "",
      set textContent(v) { this._text = String(v); },
      get textContent() { return this._text + this.children.map(function (c) { return c.textContent; }).join(""); },
      appendChild: function (c) { this.children.push(c); return c; },
    };
  }
  return { createElement: el };
}

test("build-update-detail renders both builds and the commits, as text", async function () {
  global.document = fakeDocument();
  try {
    var mod = await import(pathToFileURL(path.join(MODULES, "build-update-detail.js")).href);
    var root = mod.buildUpdateDetailEl({
      loadedBuildSha: "a".repeat(40), installedBuildSha: "b".repeat(40), reason: "sha",
      changes: { available: true, truncated: true, reason: null, commits: [{ sha: "1234567890abcdef", subject: "<img src=x onerror=alert(1)> fix" }] },
    });
    var text = root.textContent;
    assert.ok(text.indexOf("Running: " + "a".repeat(12)) !== -1, text);
    assert.ok(text.indexOf("Installed: " + "b".repeat(12)) !== -1, text);
    assert.ok(text.indexOf("12345678 <img src=x onerror=alert(1)> fix") !== -1, "the subject is shown literally");
    assert.ok(text.indexOf("More commits not shown") !== -1);
    assert.equal(mod.buildUpdateDetailEl(null), null);
  } finally {
    delete global.document;
  }
});

test("build-update-detail says why the change list is missing instead of showing an empty one", async function () {
  global.document = fakeDocument();
  try {
    var mod = await import(pathToFileURL(path.join(MODULES, "build-update-detail.js")).href);
    var root = mod.buildUpdateDetailEl({
      loadedBuildSha: "a", installedBuildSha: "b", reason: "sha",
      changes: { available: false, commits: [], truncated: false, reason: "no git history is available for this install" },
    });
    assert.ok(root.textContent.indexOf("Change list unavailable: no git history is available for this install.") !== -1);
    var same = mod.buildUpdateDetailEl({ loadedBuildSha: "a", installedBuildSha: "a", reason: "content", changes: { available: false, commits: [] } });
    assert.ok(same.textContent.indexOf("same build") !== -1);
  } finally {
    delete global.document;
  }
});

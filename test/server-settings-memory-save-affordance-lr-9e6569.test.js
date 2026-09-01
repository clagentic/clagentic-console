// server-settings-memory-save-affordance-lr-9e6569.test.js
//
// Regression test for lr-9e6569 (MILLER diagnosis fnd-04996e, third round on
// this surface). ROOT CAUSE: the Advanced > Memory panel
// (lib/public/index.html, data-section="advanced") had NO commit affordance
// at all -- the ps-textarea-actions container held only the
// ss-memory-save-status feedback span, no button. The only commit trigger
// for either memory input was the native `change` event (blur/Enter). A user
// who typed a value and navigated away without blurring sent nothing to the
// daemon, with zero error and zero feedback.
//
// WHY THE EXISTING TESTS DID NOT CATCH THIS (the double-loop point this task
// exists to close): PR #414 passed
// test/ws-schema-s2c-handler-completeness-lr-93e3c8.test.js and
// test/app-messages-registry-completeness-lr-4e49.test.js, both of which ask
// "is the message plumbed end to end?" -- does a registered handler function
// exist for set_mem_available_threshold_result, mem_available_threshold_changed,
// etc. Neither asks "can a human actually trigger the message in the first
// place?" A panel with a fully-wired handler chain and *zero* interactive
// commit elements passes both of those tests. This file asserts the thing
// they don't: that a reachable, clickable submit control actually exists in
// the shipped HTML and is bound, in the shipped JS, to the exact save
// functions that send set_mem_available_threshold / set_tokens_per_mb_headroom.
//
// WHAT THIS TEST DOES NOT PROVE, AND WHERE THAT GAP WAS ACTUALLY CLOSED
// (PEACHES PR #416 finding 4, fold-in): this file is static source-inspection
// only and cannot execute a click, so it cannot catch a double-send, a save
// function whose ws.send was quietly removed, CSS-class-based hiding, or a
// shared-status race between the two fields -- and indeed it did not catch
// findings 1 and 2 in this PR's own diff (PEACHES caught them; this file did
// not). This repo has no jsdom/happy-dom/linkedom/Playwright dependency
// (confirmed against package.json devDependencies), but it DOES have an
// established, dependency-free EXECUTION pattern used across the suite
// (dynamic import() of the real ES module + a hand-built fake `document` --
// see test/context-meter-vendor-first-lr-3af675.test.js,
// test/rate-limit-pill-percent-lr-872f94.test.js, and five more). This
// file's own header previously (incorrectly) treated a full DOM-execution
// harness as unavailable here; test/server-settings-memory-save-dedup-status-lr-9e6569.test.js
// uses that existing pattern to drive the real saveMemAvailableThreshold /
// saveTokensPerMbHeadroom / status-rendering code paths and demonstrably
// fails against the pre-fix code for both findings. This static file is kept
// as a floor (it still proves the button/wiring exist at all) but is no
// longer the whole story for this surface.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var REPO_ROOT = path.join(__dirname, "..");
var indexHtml = fs.readFileSync(path.join(REPO_ROOT, "lib", "public", "index.html"), "utf8");
var serverSettingsJs = fs.readFileSync(
  path.join(REPO_ROOT, "lib", "public", "modules", "server-settings.js"),
  "utf8"
);

// Isolate the Advanced > Memory panel markup so assertions can't accidentally
// match an unrelated button/span elsewhere in this large file.
function extractMemoryPanelHtml() {
  var bodyStart = indexHtml.indexOf('id="settings-advanced-memory-body"');
  assert.ok(bodyStart !== -1, "settings-advanced-memory-body container not found in index.html");
  // The panel body closes with the matching </div> for the div opened at
  // bodyStart; a fixed-size window comfortably covers this panel's known
  // extent without needing a full HTML parser.
  return indexHtml.slice(bodyStart, bodyStart + 2000);
}

test("the Advanced > Memory panel's ps-textarea-actions container has a real button, not just the status span", function () {
  var panelHtml = extractMemoryPanelHtml();
  var actionsMatch = /<div class="ps-textarea-actions"[^>]*>([\s\S]*?)<\/div>/.exec(panelHtml);
  assert.ok(actionsMatch, "ps-textarea-actions container not found inside the memory panel body");

  var actionsHtml = actionsMatch[1];
  assert.match(
    actionsHtml,
    /<button[^>]*id="ss-memory-save-btn"[^>]*>/,
    "ps-textarea-actions in the Advanced > Memory panel must contain a <button id=\"ss-memory-save-btn\"> " +
    "-- every other panel using this container (CLAUDE.md: ss-claudemd-save, shared-env: ss-env-add-btn) " +
    "pairs its status span with a real button; this panel previously had only the span (fnd-04996e)"
  );
  assert.match(
    actionsHtml,
    /id="ss-memory-save-status"/,
    "the existing ss-memory-save-status feedback span (PR #414) must still be present alongside the new button"
  );
});

test("the memory Save button is not disabled/hidden by default (a real reachable control, not a decoy)", function () {
  var panelHtml = extractMemoryPanelHtml();
  var btnMatch = /<button[^>]*id="ss-memory-save-btn"[^>]*>/.exec(panelHtml);
  assert.ok(btnMatch, "ss-memory-save-btn not found");
  var btnTag = btnMatch[0];
  assert.doesNotMatch(btnTag, /\bdisabled\b/, "ss-memory-save-btn must not render disabled by default");
  assert.doesNotMatch(btnTag, /\bhidden\b/, "ss-memory-save-btn must not render hidden by default");
});

test("ss-memory-save-btn's click handler is wired to the real save functions, not a no-op or a re-implemented inline sender", function () {
  var clickListenerMatch =
    /document\.getElementById\("ss-memory-save-btn"\)[\s\S]{0,300}?addEventListener\("click",\s*function\s*\(\)\s*\{([\s\S]*?)\}\);/.exec(
      serverSettingsJs
    );
  assert.ok(clickListenerMatch, "no addEventListener(\"click\", ...) wiring found for ss-memory-save-btn in server-settings.js");

  var body = clickListenerMatch[1];
  assert.match(
    body,
    /saveMemAvailableThreshold\s*\(\s*\)/,
    "the save button's click handler must call saveMemAvailableThreshold() -- the same function the min-available " +
    "input's change listener calls, not a parallel/duplicated send"
  );
  assert.match(
    body,
    /saveTokensPerMbHeadroom\s*\(\s*\)/,
    "the save button's click handler must call saveTokensPerMbHeadroom() -- the same function the tokens-per-MB " +
    "input's change listener calls, not a parallel/duplicated send"
  );
});

test("the min-available and tokens-per-mb change listeners still exist (blur/Enter commit path preserved, not removed)", function () {
  assert.match(
    serverSettingsJs,
    /getElementById\("settings-mem-available-min"\)/,
    "settings-mem-available-min lookup missing"
  );
  assert.match(
    serverSettingsJs,
    /memAvailInput\.addEventListener\("change",\s*function\s*\(\)\s*\{\s*saveMemAvailableThreshold\(\);\s*\}\);/,
    "settings-mem-available-min's change listener must still call saveMemAvailableThreshold() -- lr-9e6569 adds " +
    "the button as an ADDITIONAL commit path, it does not remove the existing blur/Enter path"
  );
  assert.match(
    serverSettingsJs,
    /tpmInput\.addEventListener\("change",\s*function\s*\(\)\s*\{\s*saveTokensPerMbHeadroom\(\);\s*\}\);/,
    "settings-tokens-per-mb-headroom's change listener must still call saveTokensPerMbHeadroom() for the same reason"
  );
});

test("saveMemAvailableThreshold and saveTokensPerMbHeadroom both actually send their WS message types (the save button is not a dead click)", function () {
  assert.match(
    serverSettingsJs,
    /function saveMemAvailableThreshold\(\)\s*\{[\s\S]*?type:\s*"set_mem_available_threshold"[\s\S]*?\n\}/,
    "saveMemAvailableThreshold() must send a set_mem_available_threshold WS message"
  );
  assert.match(
    serverSettingsJs,
    /function saveTokensPerMbHeadroom\(\)\s*\{[\s\S]*?type:\s*"set_tokens_per_mb_headroom"[\s\S]*?\n\}/,
    "saveTokensPerMbHeadroom() must send a set_tokens_per_mb_headroom WS message"
  );
});

test("default-vs-persisted distinction (secondary scope): daemon config payload and client both reference the *IsDefault flags", function () {
  var daemonJs = fs.readFileSync(path.join(REPO_ROOT, "lib", "daemon.js"), "utf8");
  assert.match(
    daemonJs,
    /memAvailableMinMBIsDefault:\s*config\.memAvailableMinMB === undefined/,
    "onGetDaemonConfig must report whether memAvailableMinMB is a fallback default or a persisted value"
  );
  assert.match(
    daemonJs,
    /tokensPerMbHeadroomIsDefault:\s*config\.tokensPerMbHeadroom === undefined/,
    "onGetDaemonConfig must report whether tokensPerMbHeadroom is a fallback default or a persisted value"
  );
  assert.match(
    serverSettingsJs,
    /config\.memAvailableMinMBIsDefault/,
    "updateDaemonConfig must consume memAvailableMinMBIsDefault to surface the default-vs-persisted distinction"
  );
  assert.match(
    serverSettingsJs,
    /config\.tokensPerMbHeadroomIsDefault/,
    "updateDaemonConfig must consume tokensPerMbHeadroomIsDefault to surface the default-vs-persisted distinction"
  );
});

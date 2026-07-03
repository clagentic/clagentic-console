// history-pagination-client-auto-advance-lr-c24b.test.js
//
// app-header.js is an ESM module with DOM (#messages, IntersectionObserver)
// dependencies that this project's test runner does not exercise via a DOM
// harness (see the existing diagnostics-dismiss-clear-all-parity.test.js /
// diagnostics-panel-pointer-events-lr-b580.test.js convention) — these are
// source-text regression checks matching that same convention, covering the
// two client-side edits from lr-c24b:
//   1. prependOlderHistory auto-advances when a page renders zero visible DOM.
//   2. updateHistorySentinel never renders a solitary sentinel.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var APP_HEADER_JS = fs.readFileSync(
  path.join(__dirname, "../lib/public/modules/app-header.js"),
  "utf8"
);

// ---------------------------------------------------------------------------
// prependOlderHistory: auto-advance on zero visible yield
// ---------------------------------------------------------------------------

test("prependOlderHistory: measures whether the batch rendered any visible DOM", () => {
  var idx = APP_HEADER_JS.indexOf("export function prependOlderHistory");
  assert.ok(idx !== -1, "expected prependOlderHistory to be exported");
  var block = APP_HEADER_JS.slice(idx, idx + 4000);

  assert.match(
    block,
    /siblingBeforeAnchor\s*=\s*anchorEl\s*\?\s*anchorEl\.previousSibling\s*:\s*messagesEl\.lastChild/,
    "must snapshot the sibling immediately before the anchor before rendering the batch"
  );
  assert.match(
    block,
    /renderedNoVisibleContent\s*=\s*anchorEl[\s\S]{0,80}anchorEl\.previousSibling\s*===\s*siblingBeforeAnchor/,
    "must compare the anchor's previousSibling after rendering against the pre-batch snapshot"
  );
});

test("prependOlderHistory: auto-advances (does not settle loadingMore:false) when the page rendered nothing visible and more history exists", () => {
  var idx = APP_HEADER_JS.indexOf("export function prependOlderHistory");
  assert.ok(idx !== -1);
  var block = APP_HEADER_JS.slice(idx, idx + 5000);

  assert.match(
    block,
    /if\s*\(\s*renderedNoVisibleContent\s*&&\s*meta\.hasMore\s*\)\s*\{[\s\S]{0,200}sendLoadMoreHistory\(/,
    "a zero-visible-yield page with more history remaining must request the next page instead of settling"
  );
});

test("prependOlderHistory: settles loadingMore:false only in the branch where content rendered or nothing more remains", () => {
  var idx = APP_HEADER_JS.indexOf("export function prependOlderHistory");
  assert.ok(idx !== -1);
  var block = APP_HEADER_JS.slice(idx, idx + 5000);

  // The `else` branch (rendered something, or hasMore is false) is the only
  // place that flips loadingMore back to false.
  var elseIdx = block.indexOf("} else {");
  assert.ok(elseIdx !== -1, "expected an else branch alongside the auto-advance branch");
  var elseBlock = block.slice(elseIdx, elseIdx + 400);
  assert.match(elseBlock, /loadingMore:\s*false/);
});

test("sendLoadMoreHistory helper is not gated by the loadingMore guard (auto-advance is already mid-load)", () => {
  var idx = APP_HEADER_JS.indexOf("function sendLoadMoreHistory");
  assert.ok(idx !== -1, "expected a sendLoadMoreHistory helper");
  var endIdx = APP_HEADER_JS.indexOf("\nexport function requestMoreHistory", idx);
  assert.ok(endIdx !== -1, "expected requestMoreHistory to follow sendLoadMoreHistory");
  var block = APP_HEADER_JS.slice(idx, endIdx);
  assert.doesNotMatch(
    block,
    /loadingMore/,
    "sendLoadMoreHistory must not itself re-check loadingMore — the auto-advance caller is already mid-load and would be blocked by requestMoreHistory's guard"
  );
});

// ---------------------------------------------------------------------------
// updateHistorySentinel: never render a solitary sentinel
// ---------------------------------------------------------------------------

test("updateHistorySentinel: detects whether any visible content is rendered below the sentinel position", () => {
  var idx = APP_HEADER_JS.indexOf("export function updateHistorySentinel");
  assert.ok(idx !== -1, "expected updateHistorySentinel to be exported");
  var block = APP_HEADER_JS.slice(idx, idx + 1200);

  assert.match(
    block,
    /hasRenderedContent\s*=\s*!!\(existing\s*\?\s*existing\.nextElementSibling\s*:\s*messagesEl\.firstElementChild\)/,
    "must check for a real rendered element below where the sentinel sits (or would sit)"
  );
});

test("updateHistorySentinel: triggers a load instead of rendering a solitary sentinel, but only outside an in-progress initial replay", () => {
  var idx = APP_HEADER_JS.indexOf("export function updateHistorySentinel");
  assert.ok(idx !== -1);
  var block = APP_HEADER_JS.slice(idx, idx + 1500);

  assert.match(
    block,
    /if\s*\(\s*!hasRenderedContent\s*&&\s*!store\.get\('replayingHistory'\)\s*\)\s*\{/,
    "the solitary-sentinel guard must be skipped mid-initial-replay, where #messages is expected to be transiently empty"
  );
  var guardIdx = block.indexOf("if (!hasRenderedContent");
  var guardBlock = block.slice(guardIdx, guardIdx + 300);
  assert.match(guardBlock, /requestMoreHistory\(\)/, "must trigger a load rather than showing a lone button");
});

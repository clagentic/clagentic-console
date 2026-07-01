// custom-icons-lr-0847.test.js — lr-0847: post-merge fixes to the lr-d1d9
// Custom Icons surface (picker upload failure, mobile management parity,
// hyphen-segment search).
//
// Coverage:
//   matchesCustomIconQuery (lib/public/modules/custom-icons.js) — the
//   shared hyphen/underscore-segment substring match used by BOTH the
//   emoji-picker Custom tab search and the Server Settings > Custom Icons
//   list filter, so the two surfaces can't drift on tokenization (Defect 4).
//
// Defect 1 (picker upload failures now surfaced via showToast instead of a
// bare `return`) and Defect 3 (mobile reachability of Server Settings /
// Custom Icons via the More sheet + settings command palette) are DOM-driven
// UI changes without an existing DOM-test harness in this repo (see
// custom-icons-lr-d1d9.test.js's own note on daemon.js being unsafe to
// require directly) — covered here only where a pure function boundary
// exists (matchesCustomIconQuery); manually verified end-to-end per the PR
// description.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

// ============================================================
// 1. matchesCustomIconQuery — shared hyphen/underscore-segment match
// ============================================================

test("matchesCustomIconQuery: empty query matches everything", async () => {
  var { matchesCustomIconQuery } = await import("../lib/public/modules/custom-icons.js?t=" + Date.now());
  assert.equal(matchesCustomIconQuery("clagentic-console", ""), true);
  assert.equal(matchesCustomIconQuery("clagentic-console", "   "), true);
});

test("matchesCustomIconQuery: matches a substring of the whole slug (prefix/whole-slug case, pre-existing behavior)", async () => {
  var { matchesCustomIconQuery } = await import("../lib/public/modules/custom-icons.js?t=" + (Date.now() + 1));
  assert.equal(matchesCustomIconQuery("clagentic-console", "clage"), true);
  assert.equal(matchesCustomIconQuery("clagentic-console", "clagentic-console"), true);
});

test("matchesCustomIconQuery: matches a later hyphen-delimited segment on its own (lr-0847 regression case)", async () => {
  var { matchesCustomIconQuery } = await import("../lib/public/modules/custom-icons.js?t=" + (Date.now() + 2));
  // The exact case from the bug report: "console" must find "clagentic-console".
  assert.equal(matchesCustomIconQuery("clagentic-console", "console"), true);
});

test("matchesCustomIconQuery: matches an underscore-delimited segment", async () => {
  var { matchesCustomIconQuery } = await import("../lib/public/modules/custom-icons.js?t=" + (Date.now() + 3));
  assert.equal(matchesCustomIconQuery("team_logo_v2", "logo"), true);
  assert.equal(matchesCustomIconQuery("team_logo_v2", "v2"), true);
});

test("matchesCustomIconQuery: matches mixed hyphen/underscore delimiters", async () => {
  var { matchesCustomIconQuery } = await import("../lib/public/modules/custom-icons.js?t=" + (Date.now() + 4));
  assert.equal(matchesCustomIconQuery("clagentic-console_beta", "beta"), true);
  assert.equal(matchesCustomIconQuery("clagentic-console_beta", "console"), true);
});

test("matchesCustomIconQuery: matches a substring within a segment, not just whole-segment", async () => {
  var { matchesCustomIconQuery } = await import("../lib/public/modules/custom-icons.js?t=" + (Date.now() + 5));
  assert.equal(matchesCustomIconQuery("clagentic-console", "onsol"), true);
});

test("matchesCustomIconQuery: is case-insensitive", async () => {
  var { matchesCustomIconQuery } = await import("../lib/public/modules/custom-icons.js?t=" + (Date.now() + 6));
  assert.equal(matchesCustomIconQuery("clagentic-console", "CONSOLE"), true);
});

test("matchesCustomIconQuery: returns false when no segment matches", async () => {
  var { matchesCustomIconQuery } = await import("../lib/public/modules/custom-icons.js?t=" + (Date.now() + 7));
  assert.equal(matchesCustomIconQuery("clagentic-console", "rocket"), false);
});

test("matchesCustomIconQuery: handles a slug with no delimiters (single segment)", async () => {
  var { matchesCustomIconQuery } = await import("../lib/public/modules/custom-icons.js?t=" + (Date.now() + 8));
  assert.equal(matchesCustomIconQuery("rocket", "rock"), true);
  assert.equal(matchesCustomIconQuery("rocket", "boat"), false);
});

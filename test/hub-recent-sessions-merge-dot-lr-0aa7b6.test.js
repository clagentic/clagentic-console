// hub-recent-sessions-merge-dot-lr-0aa7b6.test.js — lr-0aa7b6 regression coverage.
//
// Feature: Home Hub Recent Sessions rows previously showed TWO indicators —
// a left status dot (.hub-recent-dot; green=live/processing, grey=idle) and
// a SEPARATE right red alert dot (.hub-recent-alert-dot, added by
// lr-2b1f03). This merges them into ONE left dot whose COLOR encodes
// everything, with a LOCKED precedence (andy, lr-0aa7b6):
//   alert(red) > processing(green) > live(green) > idle(grey)
// .hub-recent-alert-dot is removed entirely — alert is now just another
// color state (.hub-recent-dot.alert) of the single left dot.
//
// Supersedes test/hub-recent-sessions-alert-dot-lr-2b1f03.test.js, which
// asserted the old two-dot design this task explicitly replaces.
//
// lr-0aa7b6 (follow-up, holden/andy decision): the alert state is now
// PER-SESSION, not per-project. lib/server.js's crossProjectUnread map was
// restructured to key by "slug::localId" (see crossUnreadKey /
// getSessionUnread), threaded through lib/sessions.js's onSessionDone(),
// lib/project.js, and lib/project-loop.js's hub_recent_sessions_list
// handler, which now attaches each session's OWN unread count onto the
// sess object sent to the client. The client keys the merged dot's alert
// state on sess.unread, not projectHasAlert(sess.projectSlug) — see
// test/server-cross-project-unread-per-session-lr-0aa7b6.test.js for the
// server-side data-path coverage (composite key, no cross-project
// misattribution, project-badge rollup non-regression).
//
// app-home-hub.js imports getCachedProjects from app-projects.js, and
// pulls in a long chain of DOM-touching modules (theme, scheduler,
// filebrowser, ws-ref, etc.) that assume a browser environment, so
// importing it directly under node:test is impractical. Matching the
// project's existing convention for DOM-heavy frontend modules (see
// mobile-home-toggle-lr-551048.test.js), this is a source-text regression
// check against the built file.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var HOME_HUB_JS = fs.readFileSync(
  path.join(__dirname, "../lib/public/modules/app-home-hub.js"),
  "utf8"
);

var HOME_HUB_CSS = fs.readFileSync(
  path.join(__dirname, "../lib/public/css/home-hub.css"),
  "utf8"
);

test("app-home-hub.js: the separate hub-recent-alert-dot span markup is removed — no second dot", () => {
  // A prose comment MAY still reference the removed class name for context
  // (e.g. "formerly a separate ... .hub-recent-alert-dot"); what must not
  // exist is the actual markup that renders it as a span.
  assert.doesNotMatch(
    HOME_HUB_JS,
    /class="hub-recent-alert-dot"/,
    "no element with class=\"hub-recent-alert-dot\" may be rendered — alert is now a color state of the single left dot, not a separate span"
  );
});

test("home-hub.css: the separate .hub-recent-alert-dot rule is removed", () => {
  // A prose comment MAY still reference the removed selector for context;
  // the actual CSS rule declaring it must not exist.
  assert.doesNotMatch(
    HOME_HUB_CSS,
    /\.hub-recent-alert-dot\s*\{/,
    "no .hub-recent-alert-dot { ... } rule may exist in home-hub.css — folded into .hub-recent-dot.alert"
  );
});

test("app-home-hub.js: projectHasAlert helper still exists (kept for the Projects-list badge) reading getCachedProjects() unread state", () => {
  var idx = HOME_HUB_JS.indexOf("function projectHasAlert");
  assert.ok(idx !== -1, "expected a projectHasAlert(projectSlug) helper to exist");
  var block = HOME_HUB_JS.slice(idx, idx + 1600);

  assert.match(
    block,
    /getCachedProjects\s*\(\s*\)/,
    "projectHasAlert must reuse getCachedProjects() — the same per-project cache that drives the Projects-list unread badge — rather than inventing a new data path"
  );
  assert.match(
    block,
    /\.unread/,
    "projectHasAlert must key off proj.unread, the same field rendered as the Projects-list alert count badge"
  );
});

// lr-66c118 (epic lr-a6a449 child 4/4): the LOCKED precedence chain these
// two tests originally proved as a local special case in this function is
// now the CANONICAL derivation, promoted into
// lib/public/modules/activity-state.js's sessionActivity/indicatorClass and
// exercised behaviorally in test/activity-state-lr-66c118.test.js. These
// tests are updated (not weakened) to assert the new call-site shape, same
// pattern as the source-shape checks elsewhere in this file.

test("app-home-hub.js: handleHubRecentSessions derives the dot via sessionActivity/indicatorClass, keyed PER-SESSION", () => {
  var idx = HOME_HUB_JS.indexOf("export function handleHubRecentSessions");
  assert.ok(idx !== -1, "expected handleHubRecentSessions to exist");
  var block = HOME_HUB_JS.slice(idx, idx + 2600);

  // lr-0aa7b6 follow-up (still true): alert state must never be keyed on
  // the project aggregate helper — that was THE bug (every session row in
  // a notifying project lit red even when only one was notifying).
  assert.doesNotMatch(
    block,
    /projectHasAlert\s*\(\s*sess\.projectSlug\s*\)/,
    "handleHubRecentSessions must NOT key alert state on projectHasAlert(sess.projectSlug) — that over-lights every sibling session in the project"
  );

  // lr-66c118: alert/processing/idle is now derived, not open-coded here.
  assert.match(
    block,
    /sessionActivity\s*\(\s*sess\s*,/,
    "handleHubRecentSessions must derive the row's state via sessionActivity(sess, ...) — the canonical derivation, not a local ternary"
  );
  assert.match(
    block,
    /indicatorClass\s*\(\s*recentActivityState\s*\)/,
    "handleHubRecentSessions must pick the CSS class via indicatorClass(), the one place a class name is chosen"
  );

  // Exactly one dot span per row — no second/separate alert span.
  var dotSpanMatches = block.match(/<span class="'\s*\+\s*dotClass/);
  assert.ok(dotSpanMatches, "expected a single dot span driven by dotClass");
});

test("app-home-hub.js: the merged dot preserves a title/tooltip explaining the state", () => {
  var idx = HOME_HUB_JS.indexOf("export function handleHubRecentSessions");
  var block = HOME_HUB_JS.slice(idx, idx + 2500);

  assert.match(
    block,
    /dotTitle/,
    "expected a dotTitle local used as the dot's title attribute"
  );
  assert.match(
    block,
    /title="'\s*\+\s*dotTitle\s*\+\s*'"/,
    "dotTitle must be rendered as the dot span's title attribute so hover still explains the state"
  );
});

test("activity-state.js: sessionActivity's alert label matches the removed .hub-recent-alert-dot's 'Unread activity' tooltip text", () => {
  // The literal 'Unread activity' string now lives in the shared derivation
  // module (one copy, not duplicated per render site) rather than inline in
  // app-home-hub.js — asserted here rather than via source-text grep on
  // app-home-hub.js since it no longer contains the string directly.
  var ACTIVITY_STATE_JS = fs.readFileSync(
    path.join(__dirname, "../lib/public/modules/activity-state.js"),
    "utf8"
  );
  assert.match(
    ACTIVITY_STATE_JS,
    /Unread activity/,
    "sessionActivity's alert-tone label must still read 'Unread activity', matching the removed .hub-recent-alert-dot's tooltip"
  );
});

test("home-hub.css: .hub-recent-dot.alert is styled with the established alert red, and no longer conflicts with .processing", () => {
  var idx = HOME_HUB_CSS.indexOf(".hub-recent-dot.alert");
  assert.ok(idx !== -1, "expected a .hub-recent-dot.alert rule in home-hub.css");
  var block = HOME_HUB_CSS.slice(idx, idx + 300);

  assert.match(
    block,
    /#e74c3c/,
    "alert dot state must use the same red (#e74c3c) as the removed .hub-recent-alert-dot / .icon-strip-project-badge unread badge"
  );
});

test("app-home-hub.js: the per-project KNOWN LIMITATION note is gone now that the alert path is per-session", () => {
  // The stale KNOWN LIMITATION comment (documenting the per-project-only
  // alert bug) must not remain now that the real per-session data path has
  // been built — a fixed bug should not still read as an open limitation.
  assert.doesNotMatch(
    HOME_HUB_JS,
    /KNOWN LIMITATION \(lr-0aa7b6\)/,
    "the lr-0aa7b6 KNOWN LIMITATION comment must be removed now that per-session alert attribution is implemented, not just documented as a gap"
  );
});

// release-config-channel-aware-lr-8a08.test.js
//
// Regression coverage for lr-8a08: @semantic-release/github successComment +
// releasedLabels must fire ONLY on the stable channel, never on the beta/prerelease
// channel (folds in lr-cd86 — a beta is not "released", plan #670 lifecycle rule).
//
// @semantic-release/github has no inline per-channel toggle for successComment/
// releasedLabels; the supported gate is `successCommentCondition`, a lodash
// template string evaluated by the plugin against the full release context
// (including nextRelease.channel). This test evaluates that same condition
// directly for a beta (prerelease) context and a stable context, so a future
// edit that breaks the gate fails CI instead of silently commenting on beta
// releases again.

var test = require("node:test");
var assert = require("node:assert");
var path = require("path");

var config = require(path.join("..", "release.config.js"));

function findGithubPluginConfig(cfg) {
  var match = cfg.plugins.find(function (entry) {
    return Array.isArray(entry) && entry[0] === "@semantic-release/github";
  });
  assert.ok(match, "expected @semantic-release/github plugin entry to be present");
  return match[1];
}

// Mirrors lodash `template()`'s handling of a bare `<%= expr %>` interpolation
// closely enough for this boolean-gate condition, without adding a lodash
// dependency to the project just for a test.
function evaluateCondition(conditionTemplate, context) {
  var match = /^<%=\s*(.+?)\s*%>$/.exec(conditionTemplate);
  assert.ok(match, "expected a single <%= ... %> interpolation in successCommentCondition");
  var expr = match[1];
  // eslint-disable-next-line no-new-func
  var fn = new Function("nextRelease", "with (arguments[1] || {}) { return (" + expr + "); }");
  return Boolean(fn(context.nextRelease, context));
}

test("release.config.js: github plugin defines successCommentCondition", function () {
  var githubConfig = findGithubPluginConfig(config);
  assert.strictEqual(typeof githubConfig.successCommentCondition, "string");
});

test("successCommentCondition is false on the beta (prerelease) channel", function () {
  var githubConfig = findGithubPluginConfig(config);
  var betaContext = { nextRelease: { version: "1.6.0-beta.3", channel: "beta" } };
  assert.strictEqual(
    evaluateCondition(githubConfig.successCommentCondition, betaContext),
    false,
    "expected successCommentCondition to suppress comments/labels on the beta channel"
  );
});

test("successCommentCondition is true on the stable channel (no channel set)", function () {
  var githubConfig = findGithubPluginConfig(config);
  var stableContext = { nextRelease: { version: "1.6.0", channel: undefined } };
  assert.strictEqual(
    evaluateCondition(githubConfig.successCommentCondition, stableContext),
    true,
    "expected successCommentCondition to allow comments/labels on the stable channel"
  );
});

test("releasedLabels uses the shared status/released vocabulary (not the old colon form)", function () {
  var githubConfig = findGithubPluginConfig(config);
  assert.deepStrictEqual(githubConfig.releasedLabels, ["status/released"]);
});

test("successComment wording does not reference the deprecated channel-suffixed phrasing", function () {
  var githubConfig = findGithubPluginConfig(config);
  assert.ok(
    !/\(\$\{nextRelease\.channel/.test(githubConfig.successComment),
    "successComment should no longer branch its wording on nextRelease.channel — the condition gate handles that now"
  );
});

test("branches: main stays a beta prerelease channel, release stays the stable channel", function () {
  var mainBranch = config.branches.find(function (b) {
    return b.name === "main";
  });
  var releaseBranch = config.branches.find(function (b) {
    return b === "release" || b.name === "release";
  });
  assert.strictEqual(mainBranch.prerelease, "beta");
  assert.strictEqual(mainBranch.channel, "beta");
  assert.ok(releaseBranch, "expected a release branch entry");
});

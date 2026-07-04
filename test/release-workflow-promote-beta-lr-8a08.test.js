// release-workflow-promote-beta-lr-8a08.test.js
//
// Regression coverage for lr-8a08 (Model 2 promote-beta-to-stable). Full YAML
// parsing would need a new dependency (no js-yaml in package.json), so this
// test asserts on the raw workflow text — enough to catch the two failure
// modes the operator called out as non-negotiable:
//   1. The promote job must land the SELECTED beta commit on release, not
//      main HEAD (the bug this task fixes).
//   2. The ensure-release-branch guard must survive (retro #483/#485 —
//      ERELEASEBRANCHES recurred twice when the release branch went missing).
// It does not execute the workflow (no CI-runner sandbox available here) —
// see the PR body for the manual-verification checklist for the parts that
// can only be exercised by an actual GitHub Actions run.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");

var workflowPath = path.join(__dirname, "..", ".github", "workflows", "release.yml");
var yml = fs.readFileSync(workflowPath, "utf8");

function jobBody(jobName) {
  var jobHeaderRe = new RegExp("^  " + jobName + ":", "m");
  var match = jobHeaderRe.exec(yml);
  assert.ok(match, "expected to find job `" + jobName + "` in release.yml");
  var start = match.index;
  // Next top-level job (two-space indent, word + colon) after this one, or EOF.
  var rest = yml.slice(start + match[0].length);
  var nextJobMatch = /^\n {2}\S.*:\n/m.exec(rest);
  var end = nextJobMatch ? start + match[0].length + nextJobMatch.index : yml.length;
  return yml.slice(start, end);
}

test("workflow_dispatch exposes a beta_ref input for selecting the beta to promote", function () {
  assert.match(yml, /beta_ref:/);
});

test("promote job resolves beta_ref to a tag before touching release", function () {
  var promote = jobBody("promote");
  assert.match(promote, /Resolve beta_ref to a tag/);
  assert.match(promote, /refs\/tags\/\$\{TAG\}/);
});

test("promote job checks out the resolved beta commit onto release, not main HEAD", function () {
  var promote = jobBody("promote");
  // The resolved beta sha is passed through env: (not interpolated directly into the
  // run: shell, per lr-8a08 injection remediation) and referenced as a quoted shell var.
  assert.match(
    promote,
    /git checkout -B release "\$\{BETA_SHA\}"/,
    "expected release to be built from the resolved beta commit sha, not a merge of main"
  );
  assert.match(
    promote,
    /BETA_SHA:\s*\$\{\{\s*steps\.resolve-beta\.outputs\.sha\s*\}\}/,
    "expected BETA_SHA to be sourced from the resolve-beta step's output via env:"
  );
  assert.doesNotMatch(
    promote,
    /git merge main/,
    "promote must not merge (moving) main into release — that was the bug this task fixes"
  );
});

test("promote job has no -X theirs / force-resolve hacks left", function () {
  var promote = jobBody("promote");
  assert.doesNotMatch(promote, /-X theirs/);
  assert.doesNotMatch(promote, /git checkout -- CHANGELOG\.md package\.json/);
});

test("promote job preserves the ensure-release-branch guard (retro #483/#485)", function () {
  var promote = jobBody("promote");
  assert.match(promote, /Ensure release branch exists/);
  assert.match(promote, /rev-parse --verify origin\/release/);
});

test("beta job is unchanged: still cuts from main HEAD and keeps its own release-branch guard", function () {
  var beta = jobBody("beta");
  assert.match(beta, /Ensure release branch exists/);
  assert.match(beta, /main HEAD/);
  assert.doesNotMatch(beta, /beta_ref/);
});

test("stable job's version-file sync back to main has no -X theirs / force-resolve hacks", function () {
  var stable = jobBody("stable");
  assert.doesNotMatch(stable, /-X theirs/);
  assert.doesNotMatch(stable, /git merge release/);
});

test("release.config.js branches array is untouched by the workflow change (beta stays on @beta)", function () {
  var configPath = path.join(__dirname, "..", "release.config.js");
  var config = require(configPath);
  var mainBranch = config.branches.find(function (b) {
    return b.name === "main";
  });
  assert.strictEqual(mainBranch.channel, "beta");
});

test("security (lr-8a08): no ${{ }} expression is interpolated directly inside a run: shell block", function () {
  // GHA run-shell-injection (semgrep: yaml.github-actions.security.run-shell-injection).
  // Untrusted/operator-influenced expressions must be passed through a step's env: block
  // and referenced as a quoted shell var, never interpolated straight into `run:`.
  //
  // Walk the file line by line: once inside a `run: |` block, every subsequent line
  // indented MORE than the `run:` line itself is still shell body; the first line at
  // or below that indentation ends the block (next key, next step, or dedent).
  var lines = yml.split("\n");
  var offenders = [];
  var inRunBlock = false;
  var runIndent = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var indentMatch = /^( *)/.exec(line);
    var indent = indentMatch[1].length;
    var trimmed = line.trim();

    if (inRunBlock) {
      if (trimmed.length > 0 && indent <= runIndent) {
        inRunBlock = false;
      } else {
        var exprRe = /\$\{\{[^}]*\}\}/g;
        var exprMatch;
        while ((exprMatch = exprRe.exec(line)) !== null) {
          offenders.push(exprMatch[0]);
        }
        continue;
      }
    }

    if (/^run:\s*\|\s*$/.test(trimmed)) {
      inRunBlock = true;
      runIndent = indent;
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    "found ${{ }} expression(s) interpolated directly inside a run: block: " + offenders.join(", ")
  );
});

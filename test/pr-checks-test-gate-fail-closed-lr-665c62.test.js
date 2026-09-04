// pr-checks-test-gate-fail-closed-lr-665c62.test.js
//
// Regression coverage for lr-665c62: PR Checks (.github/workflows/pr-checks.yml)
// could report the whole run SUCCESS while the `test` job was SKIPPED (not
// failed) — GitHub does not fail a run because a job was skipped, so a head
// that produced only a pull_request_target run previously reported green
// with `npm test` never having executed. Commit 4b150ff added a `test-gate`
// job that asserts `needs.test.result == 'success'` and fails otherwise.
//
// PEACHES (PR #418, comment 5546266561) held this BLOCKING: the guard's
// correctness was reasoned from reading the YAML, never demonstrated by an
// actual failing execution. This file closes that gap the same way lr-243b
// closed an analogous one for release.yml (see
// test/release-workflow-promote-version-guard-lr-243b.test.js) — no YAML
// parser dependency (none in package.json), so it extracts the test-gate
// step's run: block VERBATIM from the workflow text and executes it under
// `sh -c` with `needs.test.result` substituted exactly as GitHub Actions'
// `${{ }}` expression interpolation would substitute it: a literal string,
// spliced into the script text before any shell ever runs it. That is the
// real substitution mechanism (GHA expressions are evaluated by the runner,
// not by the step's shell), so this test exercises the identical script the
// runner would execute for each value, not an approximation of it.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");

var workflowPath = path.join(__dirname, "..", ".github", "workflows", "pr-checks.yml");
var yml = fs.readFileSync(workflowPath, "utf8");

function jobBody(jobName) {
  var jobHeaderRe = new RegExp("^  " + jobName + ":", "m");
  var match = jobHeaderRe.exec(yml);
  assert.ok(match, "expected to find job `" + jobName + "` in pr-checks.yml");
  var start = match.index;
  var rest = yml.slice(start + match[0].length);
  var nextJobMatch = /^\n {2}\S.*:\n/m.exec(rest);
  var end = nextJobMatch ? start + match[0].length + nextJobMatch.index : yml.length;
  return yml.slice(start, end);
}

function stepBody(job, stepName) {
  var stepHeaderRe = new RegExp("- name: " + stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  var match = stepHeaderRe.exec(job);
  assert.ok(match, "expected to find step `" + stepName + "` in job");
  var start = match.index;
  var rest = job.slice(start + match[0].length);
  var nextStepMatch = /\n {6}- name:/.exec(rest);
  var end = nextStepMatch ? start + match[0].length + nextStepMatch.index : job.length;
  return job.slice(start, end);
}

test("test-gate job needs the test job and runs on always()", function () {
  var gate = jobBody("test-gate");
  assert.match(gate, /needs:\s*test/);
  assert.match(gate, /if:\s*always\(\)/);
});

test("test job stays excluded from pull_request_target (safety property, must not regress)", function () {
  var testJob = jobBody("test");
  assert.match(testJob, /if:\s*github\.event_name != 'pull_request_target'/);
});

test("test-gate job stays a pure metadata assertion: no checkout, no npm install", function () {
  var gate = jobBody("test-gate");
  assert.doesNotMatch(gate, /actions\/checkout/);
  // Check only the executed run: bodies, not the job's own header comments —
  // the job's SECURITY comment names "npm install" in prose to explain the
  // constraint, which must not make this check trip on its own documentation.
  var runBlocks = gate.match(/run:\s*\|[\s\S]*?(?=\n {6}- name:|$)/g) || [];
  runBlocks.forEach(function (block) {
    assert.doesNotMatch(block, /npm (ci|install)/);
  });
});

function extractGateScript() {
  var gate = jobBody("test-gate");
  var step = stepBody(gate, "Require test job to have actually run and passed");
  var runMatch = /run:\s*\|\n([\s\S]*)$/.exec(step);
  assert.ok(runMatch, "expected to extract the test-gate run: block");
  // De-indent (the block is indented 10 spaces under `run: |` in the workflow).
  var lines = runMatch[1].split("\n").map(function (line) {
    return line.replace(/^ {10}/, "");
  });
  // Drop trailing blank lines left over from the step/job boundary trim.
  while (lines.length && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  var text = lines.join("\n");
  assert.match(
    text,
    /\$\{\{\s*needs\.test\.result\s*\}\}/,
    "expected the extracted script to still reference the needs.test.result expression"
  );
  return text;
}

// GitHub Actions expression interpolation (`${{ ... }}`) is a literal text
// substitution performed by the runner BEFORE the shell ever sees the
// script — it is not a shell variable. Reproducing that substitution here
// (rather than sourcing needs.test.result through env:, which is not how
// the real step is written) keeps this test byte-faithful to what actually
// runs, including the direct-interpolation shape of the real step.
function runGate(resultValue) {
  var script = extractGateScript().split("${{ needs.test.result }}").join(resultValue);
  return childProcess.spawnSync("sh", ["-c", script], { encoding: "utf8" });
}

test("guard behavior: passes when the test job result is success", function () {
  var result = runGate("success");
  assert.strictEqual(result.status, 0, "expected the guard to pass for success: " + result.stderr);
});

test("guard behavior: fails closed when the test job result is skipped", function () {
  var result = runGate("skipped");
  assert.notStrictEqual(result.status, 0, "expected the guard to fail for skipped");
  assert.match(result.stdout + result.stderr, /did not succeed/);
});

test("guard behavior: fails closed when the test job result is failure", function () {
  var result = runGate("failure");
  assert.notStrictEqual(result.status, 0, "expected the guard to fail for failure");
});

test("guard behavior: fails closed when the test job result is cancelled", function () {
  var result = runGate("cancelled");
  assert.notStrictEqual(result.status, 0, "expected the guard to fail for cancelled");
});

test("guard behavior: fails closed when the test job result is the empty string", function () {
  var result = runGate("");
  assert.notStrictEqual(result.status, 0, "expected the guard to fail for an empty/unset result");
});

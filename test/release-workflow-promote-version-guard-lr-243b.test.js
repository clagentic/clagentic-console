// release-workflow-promote-version-guard-lr-243b.test.js
//
// Regression coverage for lr-243b (follow-up to lr-8a08/PR #308, flagged
// non-blocking by PEACHES + BOBBIE). The promote job resolves an
// operator-selected beta and cuts stable from it, but did not check that the
// selected version was actually newer than the current published @latest —
// a lower/non-newest selection would fail LATE (npm rejects the republish)
// instead of failing fast with an actionable message.
//
// Full YAML parsing would need a new dependency (no js-yaml in
// package.json — matches the existing lr-8a08 test's approach), so this
// asserts on the raw workflow text for step wiring, plus executes the
// preflight step's actual shell logic (extracted verbatim) under node's
// child_process to prove the guard behavior: reject <=, allow newer, allow
// first-release (no @latest yet).

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var os = require("os");
var childProcess = require("child_process");

var workflowPath = path.join(__dirname, "..", ".github", "workflows", "release.yml");
var yml = fs.readFileSync(workflowPath, "utf8");

function jobBody(jobName) {
  var jobHeaderRe = new RegExp("^  " + jobName + ":", "m");
  var match = jobHeaderRe.exec(yml);
  assert.ok(match, "expected to find job `" + jobName + "` in release.yml");
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

test("promote job has a preflight version-guard step before the release branch is touched", function () {
  var promote = jobBody("promote");
  var preflightIdx = promote.indexOf("Preflight");
  var resolveIdx = promote.indexOf("Resolve beta_ref to a tag");
  var ensureReleaseIdx = promote.indexOf("Ensure release branch exists");
  var landIdx = promote.indexOf("Land the selected beta commit on release");
  assert.ok(preflightIdx > -1, "expected a Preflight step in the promote job");
  assert.ok(
    preflightIdx > resolveIdx,
    "preflight must run after beta_ref has been resolved to a concrete tag/sha"
  );
  assert.ok(
    preflightIdx < ensureReleaseIdx && preflightIdx < landIdx,
    "preflight must run before the release branch is created or the beta commit is landed"
  );
});

test("preflight step sources the selected version through env:, not direct ${{ }} interpolation in run:", function () {
  var promote = jobBody("promote");
  var preflight = stepBody(promote, "Preflight");
  assert.match(preflight, /SELECTED_TAG:\s*\$\{\{\s*steps\.resolve-beta\.outputs\.tag\s*\}\}/);
  assert.doesNotMatch(
    preflight.split("env:")[0],
    /\$\{\{/,
    "the run: block itself must not interpolate ${{ }} directly (injection-safe pattern from lr-8a08)"
  );
});

test("preflight step checks npm dist-tags.latest and fails fast on a non-newer selection", function () {
  var promote = jobBody("promote");
  var preflight = stepBody(promote, "Preflight");
  assert.match(preflight, /npm view "\$NPM_PACKAGE" dist-tags\.latest/);
  assert.match(preflight, /::error::/);
  assert.match(preflight, /exit 1/);
});

test("preflight step passes through (does not fail) when no @latest exists yet (first release)", function () {
  var promote = jobBody("promote");
  var preflight = stepBody(promote, "Preflight");
  assert.match(preflight, /first release, guard passes/);
});

// --- Behavioral test of the guard's actual shell logic ---
//
// The preflight step's run: body is extracted from the workflow file and
// executed directly under `sh -c`, with `npm view` stubbed out via a fake
// `npm` on PATH so the guard logic is exercised without a real registry
// call. This proves the comparison logic itself is correct, not just that
// the right step names exist in the YAML.

function extractPreflightScript() {
  var promote = jobBody("promote");
  var preflight = stepBody(promote, "Preflight");
  var runMatch = /run:\s*\|\n([\s\S]*?)\n {8}env:/.exec(preflight);
  assert.ok(runMatch, "expected to extract the preflight run: block");
  // De-indent (the block is indented 10 spaces under `run: |` in the workflow).
  return runMatch[1]
    .split("\n")
    .map(function (line) {
      return line.replace(/^ {10}/, "");
    })
    .join("\n");
}

function runPreflight(selectedTag, currentLatest) {
  var script = extractPreflightScript();
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lr-243b-preflight-"));
  var fakeNpmPath = path.join(tmpDir, "npm");
  // Fake `npm view <pkg> dist-tags.latest` — echoes the stubbed current-latest,
  // or exits non-zero (simulating "no such dist-tag") when there isn't one yet.
  var fakeNpmScript =
    "#!/bin/sh\n" +
    "if [ \"$4\" = \"" +
    (currentLatest || "") +
    "\" ]; then :; fi\n" +
    (currentLatest ? "echo '" + currentLatest + "'\nexit 0\n" : "exit 1\n");
  fs.writeFileSync(fakeNpmPath, fakeNpmScript, { mode: 0o755 });

  var result = childProcess.spawnSync("sh", ["-c", script], {
    env: {
      SELECTED_TAG: selectedTag,
      NPM_PACKAGE: "@clagentic/console",
      PATH: tmpDir + ":" + process.env.PATH,
    },
    encoding: "utf8",
  });
  return result;
}

test("guard behavior: rejects a selection whose base version is lower than current @latest", function () {
  var result = runPreflight("v1.5.0-beta.1", "1.6.0");
  assert.notStrictEqual(result.status, 0, "expected the guard to fail for a lower version");
  assert.match(result.stdout + result.stderr, /not strictly newer/);
});

test("guard behavior: rejects a selection equal to current @latest", function () {
  var result = runPreflight("v1.6.0-beta.1", "1.6.0");
  assert.notStrictEqual(result.status, 0, "expected the guard to fail for an equal version");
});

test("guard behavior: allows a selection strictly newer than current @latest", function () {
  var result = runPreflight("v1.7.0-beta.1", "1.6.0");
  assert.strictEqual(result.status, 0, "expected the guard to pass for a newer version: " + result.stderr);
});

test("guard behavior: allows any selection when there is no published @latest yet (first release)", function () {
  var result = runPreflight("v1.0.0-beta.1", null);
  assert.strictEqual(result.status, 0, "expected the guard to pass on first release: " + result.stderr);
  assert.match(result.stdout, /first release, guard passes/);
});

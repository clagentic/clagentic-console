// release-list-betas-lr-01c6.test.js
//
// Regression coverage for lr-01c6 (default-to-latest beta promotion +
// beta-job-generated .betas.json + `clagentic-console release list-betas`).
//
// Three surfaces are covered here:
//   1. lib/release-list.js — the read/parse/format module backing the CLI
//      subcommand, unit-tested in isolation (missing file, invalid JSON,
//      empty list, populated list).
//   2. bin/cli.js — the `release list-betas` subcommand wiring, exercised
//      as a real child process against a temp cwd containing a .betas.json.
//   3. .github/workflows/release.yml — text assertions for the promote job's
//      default-to-latest resolution and the beta job's .betas.json generation
//      step, following the same raw-text-assertion approach as the existing
//      lr-8a08 / lr-243b workflow tests (no js-yaml dependency in this repo).
//      The shell logic itself cannot run without a real git repo + tags +
//      npm registry, so behavioral coverage of the resolution/generation
//      scripts is called out as a manual-verification item in the PR body.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var os = require("os");
var childProcess = require("child_process");

var releaseList = require("../lib/release-list");

// --- lib/release-list.js unit tests ---

test("readBetasFile: missing file returns ok:false reason:missing", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lr-01c6-betas-"));
  var result = releaseList.readBetasFile(tmpDir);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "missing");
});

test("readBetasFile: invalid JSON returns ok:false reason:invalid", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lr-01c6-betas-"));
  fs.writeFileSync(path.join(tmpDir, ".betas.json"), "{ not valid json");
  var result = releaseList.readBetasFile(tmpDir);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "invalid");
});

test("readBetasFile: valid JSON missing promotable_betas array returns ok:false reason:invalid", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lr-01c6-betas-"));
  fs.writeFileSync(path.join(tmpDir, ".betas.json"), JSON.stringify({ generated_at: "2026-07-05T00:00:00Z" }));
  var result = releaseList.readBetasFile(tmpDir);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "invalid");
});

test("readBetasFile: valid file with entries returns ok:true and the parsed list", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lr-01c6-betas-"));
  var data = {
    generated_at: "2026-07-05T12:00:00Z",
    promotable_betas: ["v1.6.0-beta.3", "v1.6.0-beta.2"],
  };
  fs.writeFileSync(path.join(tmpDir, ".betas.json"), JSON.stringify(data));
  var result = releaseList.readBetasFile(tmpDir);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.generatedAt, "2026-07-05T12:00:00Z");
  assert.deepStrictEqual(result.promotableBetas, ["v1.6.0-beta.3", "v1.6.0-beta.2"]);
});

test("readBetasFile: valid file with an empty list returns ok:true and an empty array", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lr-01c6-betas-"));
  fs.writeFileSync(path.join(tmpDir, ".betas.json"), JSON.stringify({ generated_at: "x", promotable_betas: [] }));
  var result = releaseList.readBetasFile(tmpDir);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.promotableBetas, []);
});

test("formatBetasOutput: missing file tells the operator to cut/await a beta, brand-safe", function () {
  var lines = releaseList.formatBetasOutput({ ok: false, reason: "missing" });
  var joined = lines.join("\n");
  assert.match(joined, /No \.betas\.json found/);
  assert.match(joined, /Cut a beta/);
  assert.doesNotMatch(joined, /[^-_/@:]clagentic(?![-_/@a-zA-Z])/, "must never use bare 'clagentic' in user-facing output");
});

test("formatBetasOutput: invalid file surfaces the error and brand-correct product name", function () {
  var lines = releaseList.formatBetasOutput({ ok: false, reason: "invalid", error: "boom" });
  var joined = lines.join("\n");
  assert.match(joined, /could not be read/);
  assert.match(joined, /boom/);
  assert.match(joined, /Clagentic: Console/, "expected the full brand-correct product name in the error line");
});

test("formatBetasOutput: empty promotable list tells the operator to cut/await a beta", function () {
  var lines = releaseList.formatBetasOutput({ ok: true, generatedAt: "x", promotableBetas: [] });
  var joined = lines.join("\n");
  assert.match(joined, /No promotable betas found/);
  assert.match(joined, /Cut a beta/);
});

test("formatBetasOutput: populated list prints each beta tag and the generated_at timestamp", function () {
  var lines = releaseList.formatBetasOutput({
    ok: true,
    generatedAt: "2026-07-05T12:00:00Z",
    promotableBetas: ["v1.6.0-beta.3", "v1.6.0-beta.2"],
  });
  var joined = lines.join("\n");
  assert.match(joined, /2026-07-05T12:00:00Z/);
  assert.match(joined, /v1\.6\.0-beta\.3/);
  assert.match(joined, /v1\.6\.0-beta\.2/);
});

// --- bin/cli.js `release list-betas` subcommand (real child process) ---

var cliPath = path.join(__dirname, "..", "bin", "cli.js");

test("CLI: `release list-betas` reads .betas.json from cwd and prints entries", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lr-01c6-cli-"));
  fs.writeFileSync(
    path.join(tmpDir, ".betas.json"),
    JSON.stringify({ generated_at: "2026-07-05T00:00:00Z", promotable_betas: ["v1.6.0-beta.3"] })
  );
  var result = childProcess.spawnSync(process.execPath, [cliPath, "release", "list-betas"], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.strictEqual(result.status, 0, "stderr: " + result.stderr);
  assert.match(result.stdout, /v1\.6\.0-beta\.3/);
});

test("CLI: `release list-betas` exits non-zero with a graceful message when .betas.json is absent", function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lr-01c6-cli-missing-"));
  var result = childProcess.spawnSync(process.execPath, [cliPath, "release", "list-betas"], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stdout, /No \.betas\.json found/);
});

test("CLI: unknown `release` subcommand prints usage and exits non-zero", function () {
  var result = childProcess.spawnSync(process.execPath, [cliPath, "release", "bogus-subcommand"], {
    encoding: "utf8",
  });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /Unknown release subcommand/);
  assert.match(result.stderr, /clagentic-console release list-betas/);
});

// --- .github/workflows/release.yml text assertions ---

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

test("workflow: beta_ref input description documents the default-to-latest behavior", function () {
  assert.match(yml, /beta_ref input.*Optional.*defaults? to the latest promotable beta|Optional — leave empty to default to the latest promotable beta/);
});

test("workflow: promote job defaults to the latest beta tag when beta_ref is empty (no hard-fail)", function () {
  var promote = jobBody("promote");
  assert.doesNotMatch(
    promote,
    /beta_ref input is required to promote a beta to stable/,
    "the old hard-required-input error message must be gone now that empty defaults to latest"
  );
  assert.match(promote, /Default-to-latest/);
  assert.match(promote, /git tag -l 'v\*-beta\.\*'/);
});

test("workflow: promote job echoes the resolved tag and commit SHA to the run summary", function () {
  var promote = jobBody("promote");
  assert.match(promote, /GITHUB_STEP_SUMMARY/);
  assert.match(promote, /resolved tag/i);
  assert.match(promote, /resolved commit/i);
});

test("workflow: promote job still preserves the ensure-release-branch guard and monotonicity preflight", function () {
  var promote = jobBody("promote");
  assert.match(promote, /Ensure release branch exists/);
  assert.match(promote, /Preflight — reject a non-newer beta selection/);
});

test("workflow: beta job generates .betas.json after a successful publish, non-fatally", function () {
  var beta = jobBody("beta");
  var semanticReleaseIdx = beta.indexOf("Run semantic-release (beta)");
  var betasIdx = beta.indexOf("Generate .betas.json");
  assert.ok(semanticReleaseIdx > -1 && betasIdx > -1, "expected both steps to exist in the beta job");
  assert.ok(betasIdx > semanticReleaseIdx, ".betas.json generation must run after the beta publish succeeds");
  assert.match(beta, /\[skip ci\]/);
  assert.doesNotMatch(
    beta.slice(betasIdx),
    /\n {6}- name:/,
    "the .betas.json step should be the last step in the beta job (nothing depends on it)"
  );
});

test("workflow: .betas.json generation step's git commands never touch .github/workflows/**", function () {
  var beta = jobBody("beta");
  var betasIdx = beta.indexOf("Generate .betas.json");
  var betasStepAndRest = beta.slice(betasIdx);
  var nextStepMatch = /\n {6}- name:/.exec(betasStepAndRest.slice(1));
  var betasStep = nextStepMatch ? betasStepAndRest.slice(0, nextStepMatch.index + 1) : betasStepAndRest;
  // Assert on the actual git plumbing lines (add/commit/push targets), not the
  // prose comment above the step — the comment itself legitimately mentions
  // .github/workflows/** to document the constraint, which would otherwise
  // make this assertion trivially self-defeating.
  var gitAddLine = /git add ([^\n]+)/.exec(betasStep);
  assert.ok(gitAddLine, "expected a `git add` line in the .betas.json step");
  assert.strictEqual(gitAddLine[1].trim(), ".betas.json", "must only ever stage the generated .betas.json data file");
  assert.doesNotMatch(betasStep, /git push[^\n]*workflows/, "must never push a change touching .github/workflows/**");
});

test("security (lr-01c6): no new ${{ }} expression is interpolated directly inside a run: shell block", function () {
  // Same injection-safety sweep as the lr-8a08/lr-243b tests, re-run here so the
  // new resolve-beta default-to-latest branch and the new .betas.json generation
  // step are covered too (both source untrusted-ish values only through env:).
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

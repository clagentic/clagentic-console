#!/usr/bin/env node
"use strict";
// Runs the prompt invariant harness's named regression scenarios
// (test/prompt-invariants.test.js) against the lib/ of the commits before
// and after each past fix, and against this checkout, and prints which
// invariants each run violated. A scenario that fails before its fix and
// passes after it shows the harness would have caught that defect.
//
// A commit just after one fix can still carry defects fixed later (the
// banner that outlived its prompt, fixed after most of these), so the
// scenario as a whole may still fail there. What must hold is narrower and
// exact: the violation the defect causes (its signature) appears before the
// fix and is gone after it, and the scenario passes outright on this
// checkout. The run exits non-zero when any of that does not hold, or when
// a run fails without naming an invariant (it crashed).
//
//   npm run test:prompt-history [-- --scenario <scenario-label>]
//
// Each commit's lib/ is extracted with `git archive` into a temporary
// directory that borrows this checkout's node_modules; nothing in the
// repository is modified.

var fs = require("fs");
var os = require("os");
var path = require("path");
var { spawnSync, execFileSync } = require("child_process");

var REPO = path.join(__dirname, "..");
var HARNESS = path.join(REPO, "test", "prompt-invariants.test.js");

// scenario label (as passed to scenario() in the harness) -> its test title,
// the defect it reproduces, the violation that defect produces in the
// harness's report, and the commits just before and just after its fix.
var MATRIX = [
  {
    scenario: "grant-across-restart",
    title: "Allow for Session survives a daemon restart",
    defect: "an Allow for Session grant was lost on daemon restart",
    signature: /was granted for the session but prompted again \(I7\)/,
    before: "a31b2f4", after: "0ffb16f",
  },
  {
    scenario: "subagent-vs-parent-result",
    title: "a sub-agent's request survives its parent's turn result",
    defect: "the parent turn's result dropped a sub-agent's pending request",
    signature: /is still awaiting the operator but the server no longer offers it \(I1\)|did not settle it \(I4\)/,
    before: "c886cf0", after: "ac18d9f",
  },
  {
    scenario: "skill-grant-scope",
    title: "Allow for Session on one skill does not approve another",
    defect: "a Skill grant was keyed on the bare tool name",
    signature: /did not open exactly one prompt \(I7\)|was granted for the session but/,
    before: "270f0ee", after: "e8e8bfa",
  },
  {
    scenario: "task-notification-before-answer",
    title: "a Task's completion before the operator answers keeps its request answerable",
    defect: "task_notification released half of the ownership guard",
    signature: /the request ended before the operator answered \(I6\)/,
    before: "b4811a2", after: "68aa87d",
  },
  {
    scenario: "late-second-response",
    title: "a second client's late response is answered and every banner retires",
    defect: "a late second response got no answer and the banner stayed",
    signature: /is over but its notification still offers buttons \(I2\)|got no reply \(I4\)/,
    before: "349dbc2", after: "e49bd48",
  },
  {
    scenario: "pending-across-restart",
    title: "a request open across a daemon restart is not offered afterwards",
    defect: "a request open at restart was still offered as pending",
    signature: /still sees \S+ as pending after it ended \(I2\)/,
    before: "e49bd48", after: "4015dbc",
  },
];

function parseArgs(argv) {
  var out = { scenario: null };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === "--scenario") out.scenario = argv[++i];
  }
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A directory holding <commit>'s lib/ and a link to this checkout's
// node_modules, so the old modules resolve their dependencies.
function materializeLib(commit, root) {
  var dir = path.join(root, commit);
  fs.mkdirSync(dir, { recursive: true });
  var archive = spawnSync("git", ["-C", REPO, "archive", "--format=tar", commit, "lib"], { maxBuffer: 512 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error("git archive " + commit + " failed: " + String(archive.stderr));
  var untar = spawnSync("tar", ["-x", "-C", dir], { input: archive.stdout });
  if (untar.status !== 0) throw new Error("tar for " + commit + " failed: " + String(untar.stderr));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"), "dir");
  return path.join(dir, "lib");
}

// The invariants a run violated, e.g. ["I2", "I8"], or [] for a pass.
function runScenario(row, libDir) {
  var env = Object.assign({}, process.env);
  if (libDir) env.CLAGENTIC_CONSOLE_PROMPT_HARNESS_LIB = libDir;
  else delete env.CLAGENTIC_CONSOLE_PROMPT_HARNESS_LIB;
  var res = spawnSync(process.execPath, [
    "--test", "--test-reporter=tap", "--test-name-pattern=^" + escapeRegExp(row.title) + "$", HARNESS,
  ], { env: env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  var output = (res.stdout || "") + (res.stderr || "");
  var codes = {};
  var re = /\((I\d)(?:\/(I\d))?\)/g;
  var m;
  while ((m = re.exec(output)) !== null) {
    codes[m[1]] = true;
    if (m[2]) codes[m[2]] = true;
  }
  var passed = res.status === 0;
  if (!passed && Object.keys(codes).length === 0) codes.error = true;
  return { passed: passed, codes: Object.keys(codes).sort(), output: output };
}

function shows(row, result) {
  return !result.passed && row.signature.test(result.output);
}

function crashed(result) {
  return !result.passed && result.codes.indexOf("error") !== -1;
}

function describe(row, result) {
  if (result.passed) return "pass";
  return "FAIL " + result.codes.join(",") + (shows(row, result) ? "" : " (not this defect)");
}

/**
 * What is wrong with one scenario's three runs: before its fix the run
 * must show the defect's own violation (else the harness does not
 * reproduce it); after the fix that violation must be gone and the run must
 * not have crashed (else the fix did not hold, or nothing was checked); on
 * this checkout the scenario must pass outright.
 * @returns {string[]} one line per problem; [] when the row holds.
 */
function rowProblems(row, before, after, now) {
  var out = [];
  if (!shows(row, before)) out.push(row.scenario + " does not show its defect before its fix (" + row.before + "): the harness does not reproduce it\n" + before.output);
  if (shows(row, after) || crashed(after)) out.push(row.scenario + " still fails with its defect after its fix (" + row.after + "):\n" + after.output);
  if (!now.passed) out.push(row.scenario + " fails on this checkout:\n" + now.output);
  return out;
}

function main() {
  var args = parseArgs(process.argv.slice(2));
  var rows = MATRIX.filter(function (r) { return !args.scenario || r.scenario === args.scenario; });
  if (rows.length === 0) {
    console.error("no scenario named " + args.scenario + "; known: " + MATRIX.map(function (r) { return r.scenario; }).join(", "));
    process.exitCode = 1;
    return;
  }
  // Commits must exist locally; a shallow clone cannot reproduce history.
  rows.forEach(function (r) {
    [r.before, r.after].forEach(function (c) { execFileSync("git", ["-C", REPO, "cat-file", "-e", c + "^{commit}"]); });
  });

  var root = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-harness-history-"));
  var libs = {};
  var unexpected = [];
  try {
    console.log("scenario | defect | before fix | after fix | this checkout");
    console.log("---|---|---|---|---");
    rows.forEach(function (r) {
      [r.before, r.after].forEach(function (c) { if (!libs[c]) libs[c] = materializeLib(c, root); });
      var before = runScenario(r, libs[r.before]);
      var after = runScenario(r, libs[r.after]);
      var now = runScenario(r, null);
      console.log([r.scenario, r.defect,
        r.before + ": " + describe(r, before), r.after + ": " + describe(r, after), describe(r, now)].join(" | "));
      unexpected = unexpected.concat(rowProblems(r, before, after, now));
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (unexpected.length) {
    console.error("\n" + unexpected.join("\n\n"));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { MATRIX: MATRIX, rowProblems: rowProblems };

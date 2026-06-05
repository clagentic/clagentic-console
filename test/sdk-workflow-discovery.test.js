/**
 * Regression tests for lr-7bd3: sdk-workflow-discovery.js
 *
 * Covers:
 *   (1) discoverWorkflows returns empty array when no workflow dirs exist
 *   (2) Parses name and description from a valid workflow file (double quotes)
 *   (3) Parses name and description from a valid workflow file (single quotes)
 *   (4) Skips files with no parseable meta block
 *   (5) Project-local entry wins on name collision over global entry
 *   (6) Non-.js files are ignored
 *   (7) Merges global and local workflows without collision
 */

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var os = require('os');

var { discoverWorkflows } = require(path.join(__dirname, '..', 'lib', 'sdk-workflow-discovery.js'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-test-'));
}

function writeWorkflow(dir, filename, content) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, 'utf8');
}

function makeWorkflowContent(name, description) {
  return [
    "export const meta = {",
    "  name: '" + name + "',",
    "  description: '" + description + "',",
    "  phases: [],",
    "}",
    "",
    "export default async function run() {}",
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tests — pass tmpdir as _homeDir override so tests are hermetic.
// ---------------------------------------------------------------------------

test('returns empty array when no workflow directories exist', function () {
  var fakeHome = makeTmpDir();
  var fakeCwd = makeTmpDir();

  var result = discoverWorkflows(fakeCwd, fakeHome);

  assert.deepEqual(result, []);

  fs.rmSync(fakeHome, { recursive: true });
  fs.rmSync(fakeCwd, { recursive: true });
});

test('parses name and description using double quotes', function () {
  var fakeHome = makeTmpDir();
  var fakeCwd = makeTmpDir();
  var wfDir = path.join(fakeHome, '.claude', 'workflows');

  var content = [
    'export const meta = {',
    '  name: "deploy-check",',
    '  description: "Run pre-deploy checks",',
    '  phases: [],',
    '}',
  ].join('\n');
  writeWorkflow(wfDir, 'deploy-check.js', content);

  var result = discoverWorkflows(fakeCwd, fakeHome);

  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'deploy-check');
  assert.equal(result[0].description, 'Run pre-deploy checks');
  assert.equal(result[0].type, 'workflow');

  fs.rmSync(fakeHome, { recursive: true });
  fs.rmSync(fakeCwd, { recursive: true });
});

test('parses name and description using single quotes', function () {
  var fakeHome = makeTmpDir();
  var fakeCwd = makeTmpDir();
  var wfDir = path.join(fakeHome, '.claude', 'workflows');

  writeWorkflow(wfDir, 'my-workflow.js', makeWorkflowContent('my-workflow', 'Does something useful'));

  var result = discoverWorkflows(fakeCwd, fakeHome);

  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'my-workflow');
  assert.equal(result[0].description, 'Does something useful');
  assert.equal(result[0].type, 'workflow');

  fs.rmSync(fakeHome, { recursive: true });
  fs.rmSync(fakeCwd, { recursive: true });
});

test('skips files without a parseable meta block', function () {
  var fakeHome = makeTmpDir();
  var fakeCwd = makeTmpDir();
  var wfDir = path.join(fakeHome, '.claude', 'workflows');

  // Valid file
  writeWorkflow(wfDir, 'good.js', makeWorkflowContent('good', 'A good workflow'));
  // No meta block
  writeWorkflow(wfDir, 'no-meta.js', 'export default async function run() {}');
  // Meta block but missing description field
  writeWorkflow(wfDir, 'partial.js', "export const meta = { name: 'partial' }");

  var result = discoverWorkflows(fakeCwd, fakeHome);

  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'good');

  fs.rmSync(fakeHome, { recursive: true });
  fs.rmSync(fakeCwd, { recursive: true });
});

test('project-local entry wins on name collision over global entry', function () {
  var fakeHome = makeTmpDir();
  var fakeCwd = makeTmpDir();
  var globalWfDir = path.join(fakeHome, '.claude', 'workflows');
  var localWfDir = path.join(fakeCwd, '.claude', 'workflows');

  writeWorkflow(globalWfDir, 'shared.js', makeWorkflowContent('shared', 'Global version'));
  writeWorkflow(localWfDir, 'shared.js', makeWorkflowContent('shared', 'Project version'));

  var result = discoverWorkflows(fakeCwd, fakeHome);

  assert.equal(result.length, 1);
  assert.equal(result[0].description, 'Project version');

  fs.rmSync(fakeHome, { recursive: true });
  fs.rmSync(fakeCwd, { recursive: true });
});

test('non-.js files are ignored', function () {
  var fakeHome = makeTmpDir();
  var fakeCwd = makeTmpDir();
  var wfDir = path.join(fakeHome, '.claude', 'workflows');

  writeWorkflow(wfDir, 'valid.js', makeWorkflowContent('valid', 'A valid workflow'));
  writeWorkflow(wfDir, 'README.md', 'Docs');
  writeWorkflow(wfDir, 'helper.ts', makeWorkflowContent('ts-wf', 'TypeScript file'));

  var result = discoverWorkflows(fakeCwd, fakeHome);

  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'valid');

  fs.rmSync(fakeHome, { recursive: true });
  fs.rmSync(fakeCwd, { recursive: true });
});

test('merges global and local workflows without collision', function () {
  var fakeHome = makeTmpDir();
  var fakeCwd = makeTmpDir();
  var globalWfDir = path.join(fakeHome, '.claude', 'workflows');
  var localWfDir = path.join(fakeCwd, '.claude', 'workflows');

  writeWorkflow(globalWfDir, 'global-only.js', makeWorkflowContent('global-only', 'Only in global'));
  writeWorkflow(localWfDir, 'local-only.js', makeWorkflowContent('local-only', 'Only in project'));

  var result = discoverWorkflows(fakeCwd, fakeHome);

  assert.equal(result.length, 2);
  var names = result.map(function (r) { return r.name; }).sort();
  assert.deepEqual(names, ['global-only', 'local-only']);

  fs.rmSync(fakeHome, { recursive: true });
  fs.rmSync(fakeCwd, { recursive: true });
});

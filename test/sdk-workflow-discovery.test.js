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
 *   (8) .md files are discovered with name derived from filename and description from frontmatter
 *   (9) .md files with bare description: key are parsed correctly
 *   (10) .md files with prose description (no frontmatter) are parsed correctly
 *   (11) SKILL.md is skipped when scanning .md workflow files
 *   (12) .md entry overrides .js entry on same name collision
 *   (13) .js files are still discovered alongside .md files
 *   (14) Missing workflow dir is silently skipped for .md scan
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

test('.ts and other non-.js/.md files are ignored', function () {
  var fakeHome = makeTmpDir();
  var fakeCwd = makeTmpDir();
  var wfDir = path.join(fakeHome, '.claude', 'workflows');

  writeWorkflow(wfDir, 'valid.js', makeWorkflowContent('valid', 'A valid workflow'));
  // .md files ARE now discovered (user-facing slash commands)
  var mdContent = '---\ndescription: A markdown workflow\n---\n';
  writeWorkflow(wfDir, 'md-workflow.md', mdContent);
  // .ts files are NOT discovered — only .js and .md are handled
  writeWorkflow(wfDir, 'helper.ts', makeWorkflowContent('ts-wf', 'TypeScript file'));

  var result = discoverWorkflows(fakeCwd, fakeHome);

  assert.equal(result.length, 2);
  var names = result.map(function (r) { return r.name; }).sort();
  assert.deepEqual(names, ['md-workflow', 'valid']);

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

test('.md file is discovered with name from filename and description from YAML frontmatter', function () {
  var fakeHome = makeTmpDir();
  var fakeCwd = makeTmpDir();
  var wfDir = path.join(fakeHome, '.claude', 'workflows');

  var mdContent = [
    '---',
    'description: Run the release process',
    '---',
    '',
    '# Release Workflow',
    '',
    'Steps for releasing...',
  ].join('\n');
  writeWorkflow(wfDir, 'release.md', mdContent);

  var result = discoverWorkflows(fakeCwd, fakeHome);

  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'release');
  assert.equal(result[0].description, 'Run the release process');
  assert.equal(result[0].type, 'workflow');

  fs.rmSync(fakeHome, { recursive: true });
  fs.rmSync(fakeCwd, { recursive: true });
});

test('.md file with bare description key is parsed correctly', function () {
  var fakeHome = makeTmpDir();
  var fakeCwd = makeTmpDir();
  var wfDir = path.join(fakeHome, '.claude', 'workflows');

  var mdContent = [
    'description: Quick deploy helper',
    '',
    '# Quick Deploy',
    '',
    'Content here.',
  ].join('\n');
  writeWorkflow(wfDir, 'quick-deploy.md', mdContent);

  var result = discoverWorkflows(fakeCwd, fakeHome);

  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'quick-deploy');
  assert.equal(result[0].description, 'Quick deploy helper');

  fs.rmSync(fakeHome, { recursive: true });
  fs.rmSync(fakeCwd, { recursive: true });
});

test('.md file with prose description (no frontmatter) is parsed correctly', function () {
  var fakeHome = makeTmpDir();
  var fakeCwd = makeTmpDir();
  var wfDir = path.join(fakeHome, '.claude', 'workflows');

  var mdContent = [
    '# Lint Workflow',
    '',
    'Runs the project linter and reports failures.',
  ].join('\n');
  writeWorkflow(wfDir, 'lint-workflow.md', mdContent);

  var result = discoverWorkflows(fakeCwd, fakeHome);

  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'lint-workflow');
  assert.equal(result[0].description, 'Runs the project linter and reports failures.');

  fs.rmSync(fakeHome, { recursive: true });
  fs.rmSync(fakeCwd, { recursive: true });
});

test('SKILL.md is skipped when scanning .md workflow files', function () {
  var fakeHome = makeTmpDir();
  var fakeCwd = makeTmpDir();
  var wfDir = path.join(fakeHome, '.claude', 'workflows');

  var skillMdContent = [
    '---',
    'description: This is a skill, not a workflow command',
    '---',
  ].join('\n');
  writeWorkflow(wfDir, 'SKILL.md', skillMdContent);

  var validMdContent = [
    '---',
    'description: A real workflow command',
    '---',
  ].join('\n');
  writeWorkflow(wfDir, 'real-workflow.md', validMdContent);

  var result = discoverWorkflows(fakeCwd, fakeHome);

  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'real-workflow');

  fs.rmSync(fakeHome, { recursive: true });
  fs.rmSync(fakeCwd, { recursive: true });
});

test('.md entry overrides .js entry on same name collision', function () {
  var fakeHome = makeTmpDir();
  var fakeCwd = makeTmpDir();
  var wfDir = path.join(fakeHome, '.claude', 'workflows');

  // .js file for the same name (internal orchestration script)
  writeWorkflow(wfDir, 'deploy.js', makeWorkflowContent('deploy', 'Internal deploy script'));
  // .md file (user-facing slash command) — should win
  var mdContent = [
    '---',
    'description: User-facing deploy slash command',
    '---',
  ].join('\n');
  writeWorkflow(wfDir, 'deploy.md', mdContent);

  var result = discoverWorkflows(fakeCwd, fakeHome);

  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'deploy');
  assert.equal(result[0].description, 'User-facing deploy slash command');

  fs.rmSync(fakeHome, { recursive: true });
  fs.rmSync(fakeCwd, { recursive: true });
});

test('.js workflow files are still discovered alongside .md files', function () {
  var fakeHome = makeTmpDir();
  var fakeCwd = makeTmpDir();
  var wfDir = path.join(fakeHome, '.claude', 'workflows');

  writeWorkflow(wfDir, 'orchestrate.js', makeWorkflowContent('orchestrate', 'JS orchestration workflow'));
  var mdContent = [
    '---',
    'description: MD slash command workflow',
    '---',
  ].join('\n');
  writeWorkflow(wfDir, 'slash-cmd.md', mdContent);

  var result = discoverWorkflows(fakeCwd, fakeHome);

  assert.equal(result.length, 2);
  var byName = {};
  result.forEach(function (r) { byName[r.name] = r; });
  assert.equal(byName['orchestrate'].description, 'JS orchestration workflow');
  assert.equal(byName['slash-cmd'].description, 'MD slash command workflow');

  fs.rmSync(fakeHome, { recursive: true });
  fs.rmSync(fakeCwd, { recursive: true });
});

test('missing workflow dir is silently skipped for .md scan', function () {
  var fakeHome = makeTmpDir();
  var fakeCwd = makeTmpDir();
  // Neither home nor cwd has a .claude/workflows directory — should return empty.

  var result = discoverWorkflows(fakeCwd, fakeHome);

  assert.deepEqual(result, []);

  fs.rmSync(fakeHome, { recursive: true });
  fs.rmSync(fakeCwd, { recursive: true });
});

var fs = require('fs');
var path = require('path');
var extractDescriptionFromContent = require('./sdk-skill-discovery').extractDescriptionFromContent;

// Regex to locate the meta block and extract string fields from it.
// The meta block always appears as a static literal near the top of the file:
//   export const meta = { name: 'foo', description: 'bar', ... }
// We do NOT require() or eval the file — the regex operates on raw source text.
var RE_META_OPEN = /export\s+const\s+meta\s*=\s*\{/;
var RE_FIELD = function (field) {
  return new RegExp(field + ":\\s*['\"]([^'\"]+)['\"]");
};

// Parse meta.name and meta.description from raw .js file content.
// Scans only the first 40 lines so the regex never runs against large files.
// Returns { name, description } or null if either field cannot be parsed.
function parseWorkflowMeta(content) {
  // Limit scan to first 40 lines for performance and correctness
  // (meta block is always a static literal at the top of the file).
  var lines = content.split('\n');
  var head = lines.slice(0, 40).join('\n');

  if (!RE_META_OPEN.test(head)) return null;

  var nameMatch = RE_FIELD('name').exec(head);
  var descMatch = RE_FIELD('description').exec(head);

  if (!nameMatch || !descMatch) return null;

  return {
    name: nameMatch[1],
    description: descMatch[1],
  };
}

// Scan a single workflow directory for .js files with parseable meta blocks.
// Adds results to the provided map (name -> entry), so later calls override earlier ones.
function scanWorkflowDir(dir, resultMap) {
  var entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    // Directory does not exist or is unreadable — skip silently.
    return;
  }

  for (var i = 0; i < entries.length; i++) {
    var fname = entries[i];
    if (path.extname(fname) !== '.js') continue;

    var fpath = path.join(dir, fname);
    var content;
    try {
      content = fs.readFileSync(fpath, 'utf8');
    } catch (e) {
      continue;
    }

    var meta = parseWorkflowMeta(content);
    if (!meta) continue;

    // cwd-local entry wins on name collision (inserted last).
    resultMap[meta.name] = {
      name: meta.name,
      description: meta.description,
      type: 'workflow',
    };
  }
}

// Scan a single workflow directory for .md files and extract descriptions.
// Files named exactly "SKILL.md" are skipped — those are skill definitions,
// not user-invocable slash commands.
// Adds results to the provided map (name -> entry), so later calls override earlier ones.
// .md entries always override .js entries on name collision when scanned after .js.
function scanWorkflowMdDir(dir, resultMap) {
  var entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    // Directory does not exist or is unreadable — skip silently.
    return;
  }

  for (var i = 0; i < entries.length; i++) {
    var fname = entries[i];
    if (path.extname(fname) !== '.md') continue;
    // SKILL.md is a skill definition file, not a workflow slash command.
    if (fname === 'SKILL.md') continue;

    var fpath = path.join(dir, fname);
    var content;
    try {
      content = fs.readFileSync(fpath, 'utf8');
    } catch (e) {
      continue;
    }

    var name = path.basename(fname, '.md');
    var description = extractDescriptionFromContent(content);

    resultMap[name] = {
      name: name,
      description: description,
      type: 'workflow',
    };
  }
}

// Discover workflow files and return their metadata.
// Scans:
//   1. ~/.claude/workflows/   (global, from REAL_HOME)
//   2. <cwd>/.claude/workflows/   (project-local, wins on name collision)
//
// Within each directory, .js files are scanned first, then .md files.
// .md entries override .js entries on name collision (user-facing slash
// commands take priority over internal orchestration scripts).
//
// Returns an array of { name, description, type: 'workflow' }.
// Never throws — missing directories are silently skipped.
//
// The optional second argument _homeDir is for testing only: it overrides
// REAL_HOME so tests can inject a temporary directory without module-cache tricks.
function discoverWorkflows(cwd, _homeDir) {
  var homeDir;
  if (_homeDir) {
    homeDir = _homeDir;
  } else {
    try {
      homeDir = require('./config').REAL_HOME;
    } catch (e) {
      homeDir = require('os').homedir();
    }
  }

  var resultMap = {};
  var globalWfDir = path.join(homeDir, '.claude', 'workflows');
  var localWfDir = path.join(cwd, '.claude', 'workflows');

  // Global .js first, then global .md (so .md overrides .js on same name).
  scanWorkflowDir(globalWfDir, resultMap);
  scanWorkflowMdDir(globalWfDir, resultMap);

  // Project-local .js, then project-local .md — local entries override global.
  scanWorkflowDir(localWfDir, resultMap);
  scanWorkflowMdDir(localWfDir, resultMap);

  return Object.keys(resultMap).map(function (k) { return resultMap[k]; });
}

module.exports = { discoverWorkflows: discoverWorkflows };

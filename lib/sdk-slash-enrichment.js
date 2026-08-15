var _defaultDiscoverSkillsWithMeta = require('./sdk-skill-discovery').discoverSkillsWithMeta;
var _defaultMergeSkillsWithMeta = require('./sdk-skill-discovery').mergeSkillsWithMeta;
var _defaultDiscoverWorkflows = require('./sdk-workflow-discovery').discoverWorkflows;

// Build enriched {name, desc, type}[] from three sources:
//   1. skillMeta (highest priority) — type:'skill'
//   2. workflowMeta               — type:'workflow'
//   3. CLI-emitted names not covered above — type:'builtin', desc:''
//
// cliSlashCommands: string[] or {name,...}[] from the CLI init or warmup event
// cwd: working directory used for skill/workflow discovery
//
// The optional third argument `fns` allows callers to inject alternative
// discovery functions — used by sdk-message-processor.js to pass its
// context-injected mocks so tests remain hermetic. `fns.homeOverride`
// (lr-3ccc78) is forwarded to discoverSkillsWithMeta as the global skills
// home for a shared multi-user daemon — see that function's own doc comment.
//
// Both discovery calls are wrapped in try/catch so a missing .claude directory
// on disk never prevents slash commands from reaching the frontend.
function buildEnrichedSlashCommands(cliSlashCommands, cwd, fns) {
  var discoverSkillsWithMeta = (fns && fns.discoverSkillsWithMeta) || _defaultDiscoverSkillsWithMeta;
  var mergeSkillsWithMeta = (fns && fns.mergeSkillsWithMeta) || _defaultMergeSkillsWithMeta;
  var discoverWorkflows = (fns && fns.discoverWorkflows) || _defaultDiscoverWorkflows;
  var homeOverride = (fns && fns.homeOverride) || null;

  var fsSkillsMeta = [];
  try { fsSkillsMeta = discoverSkillsWithMeta(cwd, homeOverride); } catch (e) {}
  var skillMeta = [];
  try { skillMeta = mergeSkillsWithMeta([], fsSkillsMeta); } catch (e) {}

  var workflowMeta = [];
  try { workflowMeta = discoverWorkflows(cwd); } catch (e) {}

  var seen = new Set();
  var combined = [];

  // Priority 1: skills with descriptions
  for (var i = 0; i < skillMeta.length; i++) {
    var s = skillMeta[i];
    if (!seen.has(s.name)) {
      seen.add(s.name);
      combined.push({ name: s.name, desc: s.description || '', type: 'skill' });
    }
  }
  // Priority 2: workflows with descriptions
  for (var j = 0; j < workflowMeta.length; j++) {
    var w = workflowMeta[j];
    if (!seen.has(w.name)) {
      seen.add(w.name);
      combined.push({ name: w.name, desc: w.description || '', type: 'workflow' });
    }
  }
  // Priority 3: CLI-emitted names not covered above (builtins)
  var cli = cliSlashCommands || [];
  for (var k = 0; k < cli.length; k++) {
    var entry = cli[k];
    var name = (typeof entry === 'object' && entry !== null) ? entry.name : entry;
    if (name && !seen.has(name)) {
      seen.add(name);
      combined.push({ name: name, desc: '', type: 'builtin' });
    }
  }
  return combined;
}

module.exports = { buildEnrichedSlashCommands: buildEnrichedSlashCommands };

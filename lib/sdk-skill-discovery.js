var fs = require("fs");
var path = require("path");

// Split shell command on operators (&&, ||, ;, |) while respecting quotes
// and parentheses. Returns array of command segments.
function splitShellSegments(cmd) {
  var segments = [];
  var current = "";
  var inSingle = false;
  var inDouble = false;
  var parenDepth = 0;
  var i = 0;
  while (i < cmd.length) {
    var ch = cmd[i];

    // Handle escape
    if (ch === "\\" && i + 1 < cmd.length && !inSingle) {
      current += ch + cmd[i + 1];
      i += 2;
      continue;
    }

    // Quote tracking
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; i++; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; i++; continue; }

    // Inside quotes: no splitting
    if (inSingle || inDouble) { current += ch; i++; continue; }

    // Parentheses/subshell tracking
    if (ch === "(" || ch === "$" && i + 1 < cmd.length && cmd[i + 1] === "(") {
      parenDepth++;
      current += ch;
      i++;
      continue;
    }
    if (ch === ")" && parenDepth > 0) {
      parenDepth--;
      current += ch;
      i++;
      continue;
    }

    // Inside subshell: no splitting
    if (parenDepth > 0) { current += ch; i++; continue; }

    // Check for operators: &&, ||, ;, |
    if (ch === "&" && i + 1 < cmd.length && cmd[i + 1] === "&") {
      segments.push(current);
      current = "";
      i += 2;
      continue;
    }
    if (ch === "|" && i + 1 < cmd.length && cmd[i + 1] === "|") {
      segments.push(current);
      current = "";
      i += 2;
      continue;
    }
    if (ch === "|") {
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === ";") {
      segments.push(current);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }
  if (current) segments.push(current);
  return segments;
}

// YAML block scalar indicators: folded (>) and literal (|), with optional
// chomping modifiers (- or +). When description: is followed by one of these,
// the actual text is on the subsequent indented lines.
var YAML_BLOCK_SCALAR_RE = /^[>|][+-]?$/;

// Read SKILL.md for a skill directory and extract a short description string.
// Priority:
//   1. A `description:` line in frontmatter (before first `#` heading)
//   2. The first non-empty, non-heading prose line
//   3. Empty string if neither found
//
// YAML block scalar syntax is handled: when description: is followed by > or |
// (with optional chomping modifier), the continuation indented lines are read
// and joined with spaces to produce the description string.
function extractSkillDescription(skillDir) {
  var skillMd = path.join(skillDir, "SKILL.md");
  var content;
  try {
    content = fs.readFileSync(skillMd, "utf8");
  } catch (e) {
    return "";
  }
  var lines = content.split(/\r?\n/);
  var pastFirstHeading = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    // Frontmatter: `description:` key before the first `#` heading
    if (!pastFirstHeading && /^description:\s/.test(line)) {
      var value = line.replace(/^description:\s*/, "").trim();
      // YAML block scalar: collect the indented continuation lines
      if (YAML_BLOCK_SCALAR_RE.test(value)) {
        var parts = [];
        for (var j = i + 1; j < lines.length; j++) {
          var cont = lines[j];
          // Continuation lines must be indented (start with whitespace) or blank
          if (cont.length === 0 || /^\s/.test(cont)) {
            parts.push(cont.trim());
          } else {
            break;
          }
        }
        // Drop trailing blank parts introduced by the block scalar end
        while (parts.length > 0 && parts[parts.length - 1] === "") {
          parts.pop();
        }
        return parts.join(" ").trim();
      }
      return value;
    }
    if (/^#/.test(line)) {
      pastFirstHeading = true;
      continue;
    }
    // First non-empty, non-heading prose line (strip any leading `#` markers)
    var stripped = line.replace(/^#+\s*/, "").trim();
    if (stripped.length > 0) {
      return stripped;
    }
  }
  return "";
}

// Return an array of {name, description, type:'skill'} for all discovered
// skill directories. Reads every SKILL.md to extract a description.
// Project skills override global skills with the same name (global → project
// discovery order, last-write wins).
function discoverSkillsWithMeta(cwd) {
  var dirs = [
    path.join(require("./config").REAL_HOME, ".claude", "skills"),
    path.join(cwd, ".claude", "skills"),
  ];
  // Ordered map so project skills override global skills
  var byName = {};
  for (var d = 0; d < dirs.length; d++) {
    var base = dirs[d];
    var entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      var skillDir = path.join(base, entry.name);
      var skillMdPath = path.join(skillDir, "SKILL.md");
      try {
        fs.accessSync(skillMdPath, fs.constants.R_OK);
        byName[entry.name] = skillDir;
      } catch (e) {
        // no SKILL.md, skip
      }
    }
  }
  var result = [];
  var names = Object.keys(byName);
  for (var j = 0; j < names.length; j++) {
    var name = names[j];
    result.push({
      name: name,
      description: extractSkillDescription(byName[name]),
      type: "skill",
    });
  }
  return result;
}

// Merge an array of SDK skill names and the enriched fsSkillsWithMeta array
// into a single deduplicated {name, description, type} array.
// FS skills (which carry descriptions) always override SDK-name-only entries.
// SDK-name-only entries get empty description and type 'skill'.
function mergeSkillsWithMeta(sdkSkillNames, fsSkillsWithMeta) {
  var byName = {};
  if (Array.isArray(sdkSkillNames)) {
    for (var i = 0; i < sdkSkillNames.length; i++) {
      var n = sdkSkillNames[i];
      if (typeof n === "string" && !byName[n]) {
        byName[n] = { name: n, description: "", type: "skill" };
      }
    }
  }
  if (Array.isArray(fsSkillsWithMeta)) {
    for (var j = 0; j < fsSkillsWithMeta.length; j++) {
      var skill = fsSkillsWithMeta[j];
      if (skill && typeof skill.name === "string") {
        // fs entry always overrides sdk-name-only entry
        byName[skill.name] = {
          name: skill.name,
          description: skill.description || "",
          type: skill.type || "skill",
        };
      }
    }
  }
  return Object.keys(byName).map(function(k) { return byName[k]; });
}

function attachSkillDiscovery(ctx) {
  var cwd = ctx.cwd;

  function discoverSkillDirs() {
    var skills = {};
    var dirs = [
      path.join(require("./config").REAL_HOME, ".claude", "skills"),
      path.join(cwd, ".claude", "skills"),
    ];
    for (var d = 0; d < dirs.length; d++) {
      var base = dirs[d];
      var entries;
      try {
        entries = fs.readdirSync(base, { withFileTypes: true });
      } catch (e) {
        continue; // directory doesn't exist
      }
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        var skillDir = path.join(base, entry.name);
        var skillMd = path.join(skillDir, "SKILL.md");
        try {
          fs.accessSync(skillMd, fs.constants.R_OK);
          // project skills override global skills with same name
          skills[entry.name] = skillDir;
        } catch (e) {
          // no SKILL.md, skip
        }
      }
    }
    return skills;
  }

  function mergeSkills(sdkSkills, fsSkills) {
    var merged = new Set();
    if (Array.isArray(sdkSkills)) {
      for (var i = 0; i < sdkSkills.length; i++) {
        merged.add(sdkSkills[i]);
      }
    }
    var fsNames = Object.keys(fsSkills);
    for (var i = 0; i < fsNames.length; i++) {
      merged.add(fsNames[i]);
    }
    return merged;
  }

  return { discoverSkillDirs: discoverSkillDirs, mergeSkills: mergeSkills };
}

module.exports = {
  splitShellSegments: splitShellSegments,
  attachSkillDiscovery: attachSkillDiscovery,
  extractSkillDescription: extractSkillDescription,
  discoverSkillsWithMeta: discoverSkillsWithMeta,
  mergeSkillsWithMeta: mergeSkillsWithMeta,
};

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

// Collect YAML block scalar continuation lines starting at index `start`.
// Stops at the first non-indented, non-blank line or at a `---` boundary.
// Returns the joined text with parts separated by spaces.
function collectBlockScalar(lines, start) {
  var parts = [];
  for (var j = start; j < lines.length; j++) {
    var cont = lines[j];
    // Stop at a YAML document boundary or any non-indented non-blank line
    if (cont === "---" || (cont.length > 0 && !/^\s/.test(cont))) {
      break;
    }
    parts.push(cont.trim());
  }
  // Drop trailing blank parts introduced by the block scalar end
  while (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts.join(" ").trim();
}

// Strip surrounding single or double quotes from a plain YAML scalar value.
function stripYamlQuotes(value) {
  if (
    (value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') ||
    (value.charAt(0) === "'" && value.charAt(value.length - 1) === "'")
  ) {
    return value.slice(1, -1);
  }
  return value;
}

// Extract a short description from the raw text content of a markdown file.
// Priority:
//   1. YAML frontmatter (--- delimited, line 0 === "---"): scan for
//      description: key within the block (before closing ---), handling both
//      plain string (quoted or unquoted) and block scalar (> |) values.
//   2. Bare frontmatter: description: before the first `#` heading, with block
//      scalar support (lr-2634).
//   3. First non-empty, non-heading prose line after any heading.
//   4. Empty string if none found.
function extractDescriptionFromContent(content) {
  var lines = content.split(/\r?\n/);

  // --- Priority 1: YAML frontmatter (line 0 must be exactly "---") ---
  if (lines[0] === "---") {
    // Find the closing --- and scan for description: within the block
    var closingIdx = -1;
    for (var fi = 1; fi < lines.length; fi++) {
      if (lines[fi] === "---") { closingIdx = fi; break; }
      if (/^description:\s*\S/.test(lines[fi])) {
        // Plain scalar (possibly quoted)
        var fval = lines[fi].replace(/^description:\s*/, "").trim();
        if (YAML_BLOCK_SCALAR_RE.test(fval)) {
          return collectBlockScalar(lines, fi + 1);
        }
        return stripYamlQuotes(fval);
      }
      if (/^description:\s*$/.test(lines[fi])) {
        // Bare key — block scalar follows on indented lines
        return collectBlockScalar(lines, fi + 1);
      }
    }
    // description: absent from frontmatter — fall through to prose after block
    var proseStart = closingIdx >= 0 ? closingIdx + 1 : 1;
    for (var pi = proseStart; pi < lines.length; pi++) {
      if (/^#/.test(lines[pi])) { continue; }
      var ps = lines[pi].replace(/^#+\s*/, "").trim();
      if (ps.length > 0) { return ps; }
    }
    return "";
  }

  // --- Priority 2 & 3: bare frontmatter or prose scan ---
  var pastFirstHeading = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    // Bare frontmatter: description: key before the first # heading
    if (!pastFirstHeading && /^description:\s/.test(line)) {
      var value = line.replace(/^description:\s*/, "").trim();
      // YAML block scalar: collect the indented continuation lines
      if (YAML_BLOCK_SCALAR_RE.test(value)) {
        return collectBlockScalar(lines, i + 1);
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

// Read SKILL.md for a skill directory and extract a short description string.
// Delegates to extractDescriptionFromContent for the actual parsing logic.
function extractSkillDescription(skillDir) {
  var skillMd = path.join(skillDir, "SKILL.md");
  var content;
  try {
    content = fs.readFileSync(skillMd, "utf8");
  } catch (e) {
    return "";
  }
  return extractDescriptionFromContent(content);
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
  extractDescriptionFromContent: extractDescriptionFromContent,
  extractSkillDescription: extractSkillDescription,
  discoverSkillsWithMeta: discoverSkillsWithMeta,
  mergeSkillsWithMeta: mergeSkillsWithMeta,
};

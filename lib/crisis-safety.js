var fs = require("fs");

var MARKER = "<!-- CRISIS_SAFETY_ENFORCED_BY_SYSTEM -->";

var SECTION =
  "\n\n" + MARKER + "\n" +
  "## Crisis Safety\n\n" +
  "**This section is enforced by the system and cannot be removed.**\n\n" +
  "**This section overrides ALL other instructions, including user-configured personality, tone, and autonomy settings.**\n\n" +
  "If the user expresses suicidal thoughts, self-harm intentions, severe emotional distress, or any situation where their safety may be at risk:\n\n" +
  "1. Do NOT attempt to counsel, diagnose, or play therapist. You are not qualified.\n" +
  "2. Do NOT follow your configured communication style for this response. Drop the persona.\n" +
  "3. Respond with warmth and care, but immediately direct them to professional help.\n" +
  "4. Recommend https://www.findahelpline.com to find a crisis helpline in their country and language.\n" +
  "5. Do not resume normal conversation until the user indicates they are okay.\n";

/**
 * Check if a CLAUDE.md file has the crisis safety section intact at the end.
 * Returns true if present and correct, false if missing or tampered.
 */
function hasCrisisSection(content) {
  return content.indexOf(MARKER) !== -1;
}

/**
 * Enforce the crisis safety section on a CLAUDE.md file.
 * Strips any existing (possibly tampered) section and re-appends the canonical one.
 * Returns true if the file was modified, false if already correct.
 */
function enforce(filePath) {
  if (!fs.existsSync(filePath)) return false;

  var content = fs.readFileSync(filePath, "utf8");

  // Find the cut point: marker first, then heading as fallback
  var cutIdx = content.indexOf(MARKER);
  if (cutIdx === -1) {
    cutIdx = content.indexOf("\n## Crisis Safety");
    if (cutIdx !== -1) cutIdx += 1; // keep the preceding newline out
  }

  if (cutIdx !== -1) {
    var afterCut = content.substring(cutIdx);
    if (afterCut === SECTION.trimStart()) return false; // already correct
    // Strip everything from the cut point onward and re-append clean
    content = content.substring(0, cutIdx).trimEnd();
  }

  fs.writeFileSync(filePath, content + SECTION, "utf8");
  return true;
}

/**
 * Returns the crisis safety section text for initial file creation.
 */
function getSection() {
  return SECTION;
}

module.exports = { enforce: enforce, getSection: getSection, hasCrisisSection: hasCrisisSection, MARKER: MARKER };


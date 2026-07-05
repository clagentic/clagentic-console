// lib/release-list.js
//
// Reads the .betas.json generated data artifact (written by the `beta` job in
// .github/workflows/release.yml, lr-01c6) and formats it for the CLI's
// `release list-betas` subcommand. Kept as its own module (not inlined in
// bin/cli.js) so the read/parse/format logic is unit-testable in isolation.

var fs = require("fs");
var path = require("path");

/**
 * Reads and parses the .betas.json file at the given repo root.
 *
 * Returns:
 *   { ok: true, generatedAt: string, promotableBetas: string[] }
 *   { ok: false, reason: "missing" }        — file does not exist
 *   { ok: false, reason: "invalid", error } — file exists but isn't valid JSON
 *     or doesn't match the expected shape
 */
function readBetasFile(repoRoot) {
  var betasPath = path.join(repoRoot, ".betas.json");
  var raw;
  try {
    raw = fs.readFileSync(betasPath, "utf8");
  } catch (e) {
    return { ok: false, reason: "missing" };
  }

  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: "invalid", error: e.message };
  }

  if (!parsed || !Array.isArray(parsed.promotable_betas)) {
    return { ok: false, reason: "invalid", error: "missing promotable_betas array" };
  }

  return {
    ok: true,
    generatedAt: parsed.generated_at || null,
    promotableBetas: parsed.promotable_betas,
  };
}

/**
 * Formats the result of readBetasFile() into human-readable lines for the CLI.
 * Returns an array of strings (one per line); caller decides how to print them.
 */
function formatBetasOutput(result) {
  if (!result.ok) {
    if (result.reason === "missing") {
      return [
        "No .betas.json found in this checkout.",
        "Cut a beta (workflow_dispatch type=beta on release.yml) and wait for it to publish, then try again.",
      ];
    }
    return [
      "Clagentic: Console — .betas.json is present but could not be read: " + (result.error || "unknown error"),
      "Re-cut a beta to regenerate it.",
    ];
  }

  if (result.promotableBetas.length === 0) {
    return [
      "No promotable betas found above the current @latest.",
      "Cut a beta (workflow_dispatch type=beta on release.yml) and wait for it to publish, then try again.",
    ];
  }

  var lines = [];
  if (result.generatedAt) {
    lines.push("Promotable betas (as of " + result.generatedAt + "):");
  } else {
    lines.push("Promotable betas:");
  }
  for (var i = 0; i < result.promotableBetas.length; i++) {
    lines.push("  " + result.promotableBetas[i]);
  }
  return lines;
}

module.exports = {
  readBetasFile: readBetasFile,
  formatBetasOutput: formatBetasOutput,
};

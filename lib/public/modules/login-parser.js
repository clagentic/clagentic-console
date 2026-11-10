// Reads a vendor login's terminal output for the sign-in URL and the code
// step. Pure: no DOM, no app imports. The patterns are declared per vendor
// beside its login command (the registry's loginPatterns) as regular
// expression sources; nothing here names a vendor.

function compile(source) {
  if (typeof source !== "string" || !source) return null;
  try {
    return new RegExp(source);
  } catch (e) {
    return null;
  }
}

/**
 * @param {?{url: string, codePrompt?: string, userCode?: string}} patterns
 * @returns {?{url: RegExp, codePrompt: ?RegExp, userCode: ?RegExp}} null when
 *   the vendor declares no usable URL pattern (it then shows no panel)
 */
export function compileLoginPatterns(patterns) {
  if (!patterns) return null;
  var url = compile(patterns.url);
  if (!url) return null;
  return { url: url, codePrompt: compile(patterns.codePrompt), userCode: compile(patterns.userCode) };
}

// A sign-in URL is opened from the panel, so only a web URL is accepted
// whatever a pattern matched.
function isWebUrl(text) {
  return /^https?:\/\/[^\s]+$/.test(text);
}

/**
 * @param {string[]} lines     logical lines, hard-wrapped URLs already joined
 * @param {?object} compiled   compileLoginPatterns result
 * @returns {?{url: string, codePrompt: boolean, userCode: string}} null when
 *   no sign-in URL is present. The newest URL wins, so a retried login shows
 *   its current link.
 */
export function parseLoginLines(lines, compiled) {
  if (!compiled || !Array.isArray(lines)) return null;
  var url = "";
  for (var i = lines.length - 1; i >= 0 && !url; i--) {
    var hit = compiled.url.exec(lines[i]);
    if (hit && isWebUrl(hit[0])) url = hit[0];
  }
  if (!url) return null;

  var text = lines.join("\n");
  var userCode = "";
  if (compiled.userCode) {
    var codeHit = compiled.userCode.exec(text);
    if (codeHit && codeHit[1]) userCode = codeHit[1];
  }
  return {
    url: url,
    codePrompt: !!compiled.codePrompt && compiled.codePrompt.test(text),
    userCode: userCode,
  };
}

/** The host of a URL for display, "" when it does not parse. Never the query. */
export function displayHost(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return "";
  }
}

// env-shadow-notice.js - the warning shown under an environment editor when the
// Claude user settings file sets a variable the editor also sets. That file
// wins at the runtime, so the saved value has no effect for those names.

/**
 * @param {string} elementId  the notice element
 * @param {?string[]} keys    names set in both places (empty or absent hides it unless configDirNote is set)
 * @param {boolean} [configDirNote]  the edited text sets CLAUDE_CONFIG_DIR,
 *   which the console does not consult: say the check covers one file only
 */
export function renderShadowNotice(elementId, keys, configDirNote) {
  var el = document.getElementById(elementId);
  if (!el) return;
  var names = Array.isArray(keys) ? keys : [];
  var scopeNote = "This check covers that user's Claude settings only; a CLAUDE_CONFIG_DIR set here is not consulted.";
  // The scope note matters most when nothing overlaps: the admin would
  // otherwise read the empty result as covering the directory they set.
  if (names.length === 0 && configDirNote) {
    el.textContent = scopeNote;
    el.classList.remove("hidden");
    return;
  }
  if (names.length === 0) {
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  el.textContent = (names.length === 1 ? "The variable " : "The variables ") + names.join(", ") +
    (names.length === 1 ? " is" : " are") +
    " also set in the Claude settings file of the user running Clagentic: Console. That file wins, so the value saved here has no effect for " +
    (names.length === 1 ? "it." : "them.") +
    (configDirNote ? " " + scopeNote : "");
  el.classList.remove("hidden");
}

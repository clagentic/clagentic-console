// env-shadow-notice.js - the warning shown under an environment editor when the
// Claude user settings file sets a variable the editor also sets. That file
// wins at the runtime, so the saved value has no effect for those names.

/**
 * @param {string} elementId  the notice element
 * @param {?string[]} keys    names set in both places (empty or absent hides it)
 */
export function renderShadowNotice(elementId, keys) {
  var el = document.getElementById(elementId);
  if (!el) return;
  var names = Array.isArray(keys) ? keys : [];
  if (names.length === 0) {
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  el.textContent = (names.length === 1 ? "The variable " : "The variables ") + names.join(", ") +
    (names.length === 1 ? " is" : " are") +
    " also set in the Claude settings file on this host. That file wins, so the value saved here has no effect for " +
    (names.length === 1 ? "it." : "them.");
  el.classList.remove("hidden");
}

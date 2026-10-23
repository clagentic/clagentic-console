// loop-hooks-warning.js - the notice shown on a loop's settings when its
// LOOP.json turns hooks off (settings.disableAllHooks). The setting is the
// loop author's own and is kept as written; this only says what it does.
// disableAllHooks is not limited to a loop's own hooks: it also turns off the
// hooks you set up yourself, including PreToolUse guard hooks that block or
// confirm tool calls. Import-free so it can be exercised without the frontend
// module graph.

/**
 * The warning card, or an empty string when the loop does not turn hooks off.
 * @param {?object} settings - the loop's LOOP.json settings.
 * @returns {string} HTML.
 */
export function loopHooksWarningHtml(settings) {
  if (!settings || settings.disableAllHooks !== true) return "";
  return '<div class="settings-card"><div class="settings-field">' +
    '<span class="settings-label">Hooks are turned off for this loop</span>' +
    '<div class="settings-hint" role="alert">This loop sets disableAllHooks. That also turns off your own hooks, including PreToolUse guard hooks, so a guard you rely on will not run for this loop’s tool calls.</div>' +
  '</div></div>';
}

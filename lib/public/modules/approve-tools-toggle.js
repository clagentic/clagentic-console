// approve-tools-toggle.js - the "Approve tools automatically during this loop"
// choice, shown on a loop's settings (the task detail panel and the loop preview
// before it starts). On is the default and what every loop did before the
// choice existed; off makes the loop's tool calls ask like any other session's.
// The loop's questions and plan mode stay refused either way.

/** The settings card for the choice; `prefix` keeps the element ids apart. */
export function approveToolsCardHtml(prefix) {
  return '<div class="settings-card"><div class="settings-field">' +
    '<label class="settings-toggle-row">' +
      '<div>' +
        '<span class="settings-label">Approve tools automatically during this loop</span>' +
        '<div class="settings-hint">On: the loop runs every tool without asking. Off: its tool calls ask first, like any session. The loop still cannot ask you questions or enter plan mode.</div>' +
      '</div>' +
      '<input type="checkbox" id="' + prefix + '-approve-tools">' +
      '<span class="toggle-track"><span class="toggle-thumb"></span></span>' +
    '</label>' +
  '</div></div>';
}

/**
 * Sets the checkbox from the record's value (absent means on) and reports a
 * change as true or false.
 * @param {string} prefix
 * @param {*} value - the record's approveToolsAutomatically
 * @param {function(boolean): void} onChange
 */
export function bindApproveToolsToggle(prefix, value, onChange) {
  var el = document.getElementById(prefix + "-approve-tools");
  if (!el) return;
  el.checked = value !== false;
  el.onchange = function () { onChange(el.checked); };
}

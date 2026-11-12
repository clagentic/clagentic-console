// The Appearance chat width choice, one component for every surface that offers
// it (the desktop Settings page, and the same panel the phone Settings list opens).
//
//   mountChatWidthChoice(container, { showDescriptions, onChange })
//
// It offers Compact, Comfortable, Wide and Full, marks the current step and keeps
// itself current when the step changes anywhere (another surface, another
// device's saved choice arriving with the profile). Choosing goes through
// chat-width.js, which applies the step at once and saves it on the server.
//
// Per-use options, so a surface adapts the shape and never forks it:
//   showDescriptions  show each step's one-line description (default true)
//   onChange          called with the chosen option after it is applied

import { WIDTH_OPTIONS } from './chat-width-prefs.js';
import { getChatWidth, setChatWidth, onChatWidthChange } from './chat-width.js';

function textEl(className, text) {
  var span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

function buildCard(option, selected, showDescriptions) {
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "layout-option" + (selected ? " selected" : "");
  btn.appendChild(textEl("layout-option-label", option.label));
  if (showDescriptions) btn.appendChild(textEl("layout-option-desc", option.description));
  return btn;
}

/**
 * Renders the choice into `container` and keeps it current. Returns a function
 * that stops updating it; the component also stops by itself once `container`
 * has left the document.
 */
export function mountChatWidthChoice(container, options) {
  var opts = options || {};
  var showDescriptions = opts.showDescriptions !== undefined ? !!opts.showDescriptions : true;
  var unsubscribe = null;

  container.setAttribute("role", "radiogroup");
  container.setAttribute("aria-label", "Chat width");

  function render() {
    if (unsubscribe && !container.isConnected) {
      unsubscribe();
      unsubscribe = null;
      return;
    }
    var selected = getChatWidth();
    container.textContent = "";
    WIDTH_OPTIONS.forEach(function (option) {
      var isSelected = option.key === selected;
      var el = buildCard(option, isSelected, showDescriptions);
      el.setAttribute("role", "radio");
      el.setAttribute("aria-checked", isSelected ? "true" : "false");
      el.dataset.widthOption = option.key;
      el.addEventListener("click", function () {
        setChatWidth(option.key);
        if (opts.onChange) opts.onChange(option);
      });
      container.appendChild(el);
    });
  }

  render();
  unsubscribe = onChatWidthChange(render);
  return function () {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  };
}

// The Appearance theme choice, one component for every surface that offers it.
//
//   mountThemeChoice(container, { layout, showDescriptions, onChange })
//
// It offers Dark, Light, Follow system and any valid custom theme from the
// console's themes folder, marks the current choice, and keeps itself current
// when the choice changes anywhere (another surface, another device's saved
// choice arriving with the profile) or the custom theme list loads. Choosing
// goes through theme.js, which applies the theme and saves it on the server.
//
// Per-use options, so a surface adapts the shape and never forks it:
//   layout            "cards" (User Settings: .layout-option cards inside a
//                     .layout-switcher container) or "rows" (phone More sheet:
//                     .mobile-more-item rows)
//   showDescriptions  show each option's one-line description (default: cards
//                     yes, rows no)
//   onChange          called with the chosen option after it is applied
//
// Names come from user-supplied files, so every label is set as text.

import { buildThemeOptions, selectionKey } from './theme-prefs.js';
import { getCustomThemes, getThemeSelection, setThemeMode, setCustomTheme, onThemeChange } from './theme.js';
import { refreshIcons } from './icons.js';

function iconEl(name) {
  var i = document.createElement("i");
  i.setAttribute("data-lucide", name);
  return i;
}

function swatchesEl(colors) {
  var wrap = document.createElement("span");
  wrap.className = "theme-swatches";
  for (var i = 0; i < colors.length; i++) {
    var dot = document.createElement("span");
    dot.className = "theme-swatch";
    dot.style.background = colors[i];
    wrap.appendChild(dot);
  }
  return wrap;
}

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
  var icon = document.createElement("span");
  icon.className = "layout-option-icon";
  icon.appendChild(option.kind === "custom" ? swatchesEl(option.swatches) : iconEl(option.icon));
  btn.appendChild(icon);
  btn.appendChild(textEl("layout-option-label", option.label));
  if (showDescriptions) btn.appendChild(textEl("layout-option-desc", option.description));
  return btn;
}

function buildRow(option, selected, showDescriptions) {
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mobile-more-item mobile-more-inline-row";
  if (option.kind === "custom") {
    btn.appendChild(swatchesEl(option.swatches));
  } else {
    btn.appendChild(iconEl(option.icon));
  }
  btn.appendChild(textEl("mobile-more-item-label", option.label));
  if (showDescriptions) btn.appendChild(textEl("mobile-more-inline-value", option.description));
  var mark = document.createElement("span");
  mark.className = "mobile-more-inline-value";
  if (selected) mark.appendChild(iconEl("check"));
  btn.appendChild(mark);
  return btn;
}

/**
 * Renders the choice into `container` and keeps it current. Returns a function
 * that stops updating it; the component also stops by itself once `container`
 * has left the document.
 */
export function mountThemeChoice(container, options) {
  var opts = options || {};
  var layout = opts.layout === "rows" ? "rows" : "cards";
  var showDescriptions = opts.showDescriptions !== undefined ? !!opts.showDescriptions : layout === "cards";
  var unsubscribe = null;

  container.setAttribute("role", "radiogroup");
  container.setAttribute("aria-label", "Theme");

  function render() {
    if (unsubscribe && !container.isConnected) {
      unsubscribe();
      unsubscribe = null;
      return;
    }
    var themeOptions = buildThemeOptions(getCustomThemes());
    var selected = selectionKey(getThemeSelection());
    container.textContent = "";
    themeOptions.forEach(function (option) {
      var isSelected = option.key === selected;
      var el = layout === "rows" ? buildRow(option, isSelected, showDescriptions) : buildCard(option, isSelected, showDescriptions);
      el.setAttribute("role", "radio");
      el.setAttribute("aria-checked", isSelected ? "true" : "false");
      el.dataset.themeOption = option.key;
      el.addEventListener("click", function () {
        if (option.kind === "custom") setCustomTheme(option.id);
        else setThemeMode(option.mode);
        if (opts.onChange) opts.onChange(option);
      });
      container.appendChild(el);
    });
    refreshIcons(container);
  }

  render();
  unsubscribe = onThemeChange(render);
  return function () {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  };
}

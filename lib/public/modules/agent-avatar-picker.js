// agent-avatar-picker.js - the control that chooses an agent's avatar: a built-in
// robot style (seeded, from avatar.js) or an icon from the global custom-icon
// store, the one project icons use. Uploads go through custom-icons.js to
// /api/custom-emoji; this module keeps no image and has no store of its own.
//
// It only builds the control and reports a choice through onChoose(ref), where
// ref is {style, seed}, {custom} or null (clear the choice). Sending the choice
// to the server is the caller's.

import { AVATAR_STYLES, avatarUrl } from "./avatar.js";
import { fetchCustomIconList, uploadCustomIcon, slugifyFilename } from "./custom-icons.js";
import { customIconUrl } from "./project-icon.js";
import { agentAvatarChoice } from "./agent-avatar.js";

var PREVIEW_SIZE = 40;
var MAX_SLUG_LENGTH = 64;

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/**
 * A slug that is not in taken: slug itself, else slug-2, slug-3 and so on, kept
 * inside the store's 64-character limit. An upload under it never replaces an
 * icon that something else already uses.
 */
export function uniqueSlug(slug, taken) {
  var used = {};
  (taken || []).forEach(function (s) { used[s] = true; });
  if (!used[slug]) return slug;
  for (var n = 2; ; n++) {
    var suffix = "-" + n;
    var candidate = slug.slice(0, MAX_SLUG_LENGTH - suffix.length) + suffix;
    if (!used[candidate]) return candidate;
  }
}

function previewButton(className, label, src) {
  var btn = el("button", className);
  btn.setAttribute("type", "button");
  var img = el("img", "ar-preview");
  img.alt = "";
  img.width = PREVIEW_SIZE;
  img.height = PREVIEW_SIZE;
  img.src = src;
  btn.appendChild(img);
  btn.appendChild(el("span", "ar-choice-label", label));
  return { button: btn, img: img };
}

/**
 * deps (all optional): { fetchList(), upload(slug, file) } stand in for the
 * custom-icon store calls.
 */
export function buildAvatarPicker(key, onChoose, deps) {
  deps = deps || {};
  var fetchList = deps.fetchList || fetchCustomIconList;
  var upload = deps.upload || uploadCustomIcon;
  var current = agentAvatarChoice(key);

  var root = el("div", "ar-picker");
  root.setAttribute("data-agent-key", key);

  // --- Robot styles ---
  root.appendChild(el("div", "ar-picker-title", "Built-in style"));
  var seedRow = el("label", "ar-seed-row");
  seedRow.appendChild(el("span", "ar-seed-label", "Seed"));
  var seedInput = el("input", "ar-seed");
  seedInput.setAttribute("type", "text");
  seedInput.value = current && current.seed ? current.seed : key;
  seedRow.appendChild(seedInput);
  root.appendChild(seedRow);

  var styleGrid = el("div", "ar-grid");
  var styleImgs = [];
  AVATAR_STYLES.forEach(function (style) {
    var chosen = !!current && current.style === style.id;
    var item = previewButton("ar-choice" + (chosen ? " selected" : ""), style.name, avatarUrl(style.id, seedInput.value, PREVIEW_SIZE));
    item.button.setAttribute("data-style", style.id);
    item.button.addEventListener("click", function () {
      onChoose({ style: style.id, seed: seedInput.value || key });
    });
    styleImgs.push({ id: style.id, img: item.img });
    styleGrid.appendChild(item.button);
  });
  seedInput.addEventListener("input", function () {
    styleImgs.forEach(function (s) { s.img.src = avatarUrl(s.id, seedInput.value || key, PREVIEW_SIZE); });
  });
  root.appendChild(styleGrid);

  // --- Custom icons (the global store) ---
  root.appendChild(el("div", "ar-picker-title", "Custom icons"));
  var iconGrid = el("div", "ar-grid");
  iconGrid.appendChild(el("div", "ar-note", "Loading custom icons."));
  root.appendChild(iconGrid);

  var slugs = [];
  function paintIcons(list) {
    iconGrid.innerHTML = "";
    slugs = list.map(function (i) { return i.slug; });
    if (!list.length) {
      iconGrid.appendChild(el("div", "ar-note", "No custom icons uploaded yet."));
      return;
    }
    list.forEach(function (icon) {
      var chosen = !!current && current.custom === icon.slug;
      var item = previewButton("ar-choice" + (chosen ? " selected" : ""), icon.slug, customIconUrl(icon.slug));
      item.button.setAttribute("data-custom", icon.slug);
      item.button.addEventListener("click", function () { onChoose({ custom: icon.slug }); });
      iconGrid.appendChild(item.button);
    });
  }
  Promise.resolve(fetchList()).then(paintIcons);

  // --- Upload ---
  var note = el("div", "ar-note");
  var uploadRow = el("label", "ar-upload");
  uploadRow.appendChild(el("span", "ar-upload-label", "Upload an image"));
  var fileInput = el("input", "ar-file");
  fileInput.setAttribute("type", "file");
  fileInput.setAttribute("accept", "image/*");
  fileInput.addEventListener("change", function () {
    var file = fileInput.files && fileInput.files[0];
    if (!file) return;
    var slug = uniqueSlug(slugifyFilename(file.name), slugs);
    note.textContent = "Uploading.";
    Promise.resolve(upload(slug, file)).then(function (res) {
      if (res && res.ok) {
        note.textContent = "";
        onChoose({ custom: res.slug || slug });
      } else {
        note.textContent = "Upload failed: " + ((res && res.error) || "unknown error") + ".";
      }
    });
  });
  uploadRow.appendChild(fileInput);
  root.appendChild(uploadRow);
  root.appendChild(note);

  // --- Default ---
  var reset = el("button", "ar-reset", "Use the default robot");
  reset.setAttribute("type", "button");
  reset.addEventListener("click", function () { onChoose(null); });
  root.appendChild(reset);

  return root;
}

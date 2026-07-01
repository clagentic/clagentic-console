// custom-icons-settings.js — Server Settings > Custom Icons management surface (lr-d1d9).
//
// Global-scope list/upload/rename/delete UI for the shared custom-icon
// namespace (lr-a68f). Reuses the shared upload/list/delete helpers from
// custom-icons.js (also used by emoji-picker.js) so the two surfaces never
// diverge, and renders thumbnails via renderProjectIcon() (DOM API, not
// innerHTML) for XSS parity with every other custom-icon render site.
//
// Usage ("Used by N") is computed entirely client-side from the already-cached
// project list + folder metadata — no server usage route exists or is needed.
//
// Rename is a daemon WS op (rename_custom_icon), not a bare HTTP route: file
// rename + config reference rewrite + projects_updated broadcast must be one
// atomic operation (see lib/daemon.js onRenameCustomIcon).

import { escapeHtml } from './utils.js';
import { refreshIcons, iconHtml } from './icons.js';
import { renderProjectIcon } from './project-icon.js';
import { fetchCustomIconList, uploadCustomIcon, deleteCustomIcon, slugifyFilename } from './custom-icons.js';
import { getCachedProjects, getCachedFolderMeta } from './app-projects.js';

var ctx = null;
var containerEl = null;
var cachedList = [];
var pendingRenameSlug = null; // slug currently being renamed inline, or null

export function initCustomIconsSettings(appCtx) {
  ctx = appCtx;
}

/**
 * Compute usage references for every custom-icon slug from the already-cached
 * project list and folder metadata (client-side only — no server round trip).
 *
 * @returns {Object<string, {projects: string[], folders: string[]}>} keyed by slug
 */
function computeUsage() {
  var usage = {};
  function ensure(slug) {
    if (!usage[slug]) usage[slug] = { projects: [], folders: [] };
    return usage[slug];
  }
  function slugOf(iconStr) {
    if (!iconStr || typeof iconStr !== "string") return null;
    var m = /^:([a-z0-9_-]{1,64}):$/.exec(iconStr);
    return m ? m[1] : null;
  }

  var projects = getCachedProjects() || [];
  for (var i = 0; i < projects.length; i++) {
    var slug = slugOf(projects[i].icon);
    if (slug) ensure(slug).projects.push(projects[i].title || projects[i].project || projects[i].slug);
  }

  var folderMeta = getCachedFolderMeta() || {};
  var folderNames = Object.keys(folderMeta);
  for (var j = 0; j < folderNames.length; j++) {
    var fSlug = slugOf(folderMeta[folderNames[j]] && folderMeta[folderNames[j]].icon);
    if (fSlug) ensure(fSlug).folders.push(folderNames[j]);
  }

  return usage;
}

function usageCount(usage, slug) {
  var u = usage[slug];
  if (!u) return 0;
  return u.projects.length + u.folders.length;
}

function usageLabel(usage, slug) {
  var u = usage[slug];
  if (!u || (u.projects.length === 0 && u.folders.length === 0)) return null;
  var names = u.projects.concat(u.folders.map(function (f) { return f + " (folder)"; }));
  return names.join(", ");
}

/**
 * Load (or reload) the custom icons list and render it into the settings section.
 */
export function loadCustomIcons() {
  var body = document.getElementById("custom-icons-list");
  if (!body) return;
  body.innerHTML = '<div class="admin-loading">Loading...</div>';
  fetchCustomIconList().then(function (list) {
    cachedList = list;
    renderList();
  });
}

function formatSize(bytes) {
  if (typeof bytes !== "number") return "";
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
}

function renderList() {
  var body = document.getElementById("custom-icons-list");
  if (!body) return;
  containerEl = body;
  var usage = computeUsage();

  body.innerHTML = "";

  if (cachedList.length === 0) {
    var empty = document.createElement("div");
    empty.className = "settings-hint";
    empty.textContent = "No custom icons uploaded yet.";
    body.appendChild(empty);
    return;
  }

  var list = document.createElement("div");
  list.className = "custom-icons-list";

  for (var i = 0; i < cachedList.length; i++) {
    list.appendChild(buildRow(cachedList[i], usage));
  }

  body.appendChild(list);
  refreshIcons(body);
}

function buildRow(entry, usage) {
  var row = document.createElement("div");
  row.className = "custom-icons-row";
  row.dataset.slug = entry.slug;

  // Thumbnail — rendered via renderProjectIcon (DOM <img>, not innerHTML).
  var thumbWrap = document.createElement("span");
  thumbWrap.className = "custom-icons-thumb";
  // Cache-bust: the server serves custom-emoji bytes with an immutable
  // Cache-Control header (server-settings.js), so a browser that already
  // cached the old bytes for this slug (e.g. after an overwrite-upload) would
  // otherwise keep showing stale pixels here. The query param busts that
  // cache without touching the immutable-cache header itself.
  renderProjectIcon(":" + entry.slug + ":", thumbWrap, null);
  var img = thumbWrap.querySelector("img");
  if (img) img.src = img.src + "?v=" + (entry.size || 0);
  row.appendChild(thumbWrap);

  // Meta: slug, size/type, usage badge
  var meta = document.createElement("div");
  meta.className = "custom-icons-meta";

  var slugEl = document.createElement("div");
  slugEl.className = "custom-icons-slug";
  slugEl.textContent = ":" + entry.slug + ":";
  meta.appendChild(slugEl);

  var detailEl = document.createElement("div");
  detailEl.className = "custom-icons-detail settings-hint";
  var detailParts = [];
  if (entry.ext) detailParts.push(entry.ext.toUpperCase());
  if (typeof entry.size === "number") detailParts.push(formatSize(entry.size));
  var count = usageCount(usage, entry.slug);
  var label = usageLabel(usage, entry.slug);
  detailParts.push("Used by " + count);
  detailEl.textContent = detailParts.join(" · ");
  if (label) detailEl.title = label;
  meta.appendChild(detailEl);

  row.appendChild(meta);

  // Actions
  var actions = document.createElement("div");
  actions.className = "custom-icons-actions";

  var renameBtn = document.createElement("button");
  renameBtn.className = "settings-btn-sm";
  renameBtn.innerHTML = iconHtml("pencil");
  renameBtn.title = "Rename";
  renameBtn.addEventListener("click", function () { startRename(entry.slug, row, usage); });
  actions.appendChild(renameBtn);

  var deleteBtn = document.createElement("button");
  deleteBtn.className = "settings-btn-sm settings-btn-danger";
  deleteBtn.innerHTML = iconHtml("trash-2");
  deleteBtn.title = "Delete";
  deleteBtn.addEventListener("click", function () { confirmDelete(entry.slug, usage); });
  actions.appendChild(deleteBtn);

  row.appendChild(actions);
  return row;
}

function startRename(oldSlug, row, usage) {
  if (pendingRenameSlug) return; // one inline rename at a time
  pendingRenameSlug = oldSlug;

  var slugEl = row.querySelector(".custom-icons-slug");
  if (!slugEl) return;
  var originalText = slugEl.textContent;

  var form = document.createElement("div");
  form.className = "custom-icons-rename-form";
  var input = document.createElement("input");
  input.type = "text";
  input.maxLength = 64;
  input.spellcheck = false;
  input.autocomplete = "off";
  input.value = oldSlug;
  input.className = "custom-icons-rename-input";
  var okBtn = document.createElement("button");
  okBtn.className = "settings-btn-sm primary";
  okBtn.textContent = "Save";
  var cancelBtn = document.createElement("button");
  cancelBtn.className = "settings-btn-sm settings-btn-ghost";
  cancelBtn.textContent = "Cancel";
  var errorEl = document.createElement("div");
  errorEl.className = "settings-hint custom-icons-rename-error hidden";

  form.appendChild(input);
  form.appendChild(okBtn);
  form.appendChild(cancelBtn);

  slugEl.replaceWith(form);
  row.appendChild(errorEl);
  input.focus();
  input.select();

  function endRename() {
    pendingRenameSlug = null;
    form.replaceWith(slugEl);
    slugEl.textContent = originalText;
    errorEl.remove();
  }

  function submitRename() {
    var newSlug = input.value.trim().toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    if (!newSlug || !/^[a-z0-9_-]{1,64}$/.test(newSlug)) {
      errorEl.textContent = "Invalid slug — use lowercase letters, numbers, dashes, underscores.";
      errorEl.classList.remove("hidden");
      return;
    }
    if (newSlug === oldSlug) { endRename(); return; }

    var label = usageLabel(usage, oldSlug);
    var count = usageCount(usage, oldSlug);
    if (count > 0) {
      var proceed = window.confirm(
        ":" + oldSlug + ": is used by " + count + " item" + (count === 1 ? "" : "s") +
        (label ? " (" + label + ")" : "") +
        ". Renaming will update all references to :" + newSlug + ":. Continue?"
      );
      if (!proceed) return;
    }

    okBtn.disabled = true;
    sendRename(oldSlug, newSlug).then(function (result) {
      okBtn.disabled = false;
      if (!result.ok) {
        errorEl.textContent = result.error || "Rename failed";
        errorEl.classList.remove("hidden");
        return;
      }
      pendingRenameSlug = null;
      loadCustomIcons();
    });
  }

  okBtn.addEventListener("click", function (e) { e.stopPropagation(); submitRename(); });
  cancelBtn.addEventListener("click", function (e) { e.stopPropagation(); endRename(); });
  input.addEventListener("keydown", function (e) {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); submitRename(); }
    if (e.key === "Escape") { e.preventDefault(); endRename(); }
  });
}

// In-flight rename WS round-trip, keyed so a stray late reply can't resolve
// a newer request's promise.
var _pendingRenameResolvers = {};
var _renameReqSeq = 0;

function sendRename(oldSlug, newSlug) {
  return new Promise(function (resolve) {
    var ws = ctx && ctx.ws;
    if (!ws || ws.readyState !== 1) {
      resolve({ ok: false, error: "Not connected" });
      return;
    }
    var reqId = ++_renameReqSeq;
    _pendingRenameResolvers[reqId] = resolve;
    ws.send(JSON.stringify({ type: "rename_custom_icon", oldSlug: oldSlug, newSlug: newSlug, _reqId: reqId }));
    // Safety timeout — don't leave the UI spinner stuck if the daemon never replies.
    setTimeout(function () {
      if (_pendingRenameResolvers[reqId]) {
        delete _pendingRenameResolvers[reqId];
        resolve({ ok: false, error: "Rename timed out" });
      }
    }, 10000);
  });
}

/**
 * Handle the rename_custom_icon_result WS message (wired from app-messages.js).
 */
export function handleRenameCustomIconResult(msg) {
  var reqId = msg._reqId;
  if (reqId && _pendingRenameResolvers[reqId]) {
    var resolve = _pendingRenameResolvers[reqId];
    delete _pendingRenameResolvers[reqId];
    resolve(msg);
    return;
  }
  // No matching in-flight request (e.g. reload happened) — still refresh the
  // list so the UI doesn't show stale data if the rename succeeded elsewhere.
  if (msg.ok) loadCustomIcons();
}

function confirmDelete(slug, usage) {
  var count = usageCount(usage, slug);
  var label = usageLabel(usage, slug);
  var message = "Delete :" + slug + ":?";
  if (count > 0) {
    message += " It is used by " + count + " item" + (count === 1 ? "" : "s") +
      (label ? " (" + label + ")" : "") +
      ". Those references will show a fallback icon after deletion — this cannot be undone.";
  }
  if (!window.confirm(message)) return;
  deleteCustomIcon(slug).then(function () { loadCustomIcons(); });
}

// --- Upload ---

function handleUploadFile(file) {
  if (!file) return;
  var suggested = slugifyFilename(file.name);
  var slug = window.prompt("Slug for this icon (letters, numbers, dashes, underscores):", suggested);
  if (slug === null) return; // cancelled
  slug = slug.trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!slug || !/^[a-z0-9_-]{1,64}$/.test(slug)) {
    window.alert("Invalid slug.");
    return;
  }
  var hasDup = cachedList.some(function (e) { return e.slug === slug; });
  if (hasDup && !window.confirm(":" + slug + ": already exists — overwrite?")) return;

  uploadCustomIcon(slug, file).then(function (result) {
    if (!result.ok) {
      window.alert(result.error || "Upload failed");
      return;
    }
    loadCustomIcons();
  });
}

/**
 * Wire the Upload button + hidden file input. Called once from
 * server-settings.js's initServerSettings (idempotent — safe if elements
 * are absent, e.g. in tests without the full DOM).
 */
export function initCustomIconsUpload() {
  var uploadBtn = document.getElementById("custom-icons-upload-btn");
  var fileInput = document.getElementById("custom-icons-file-input");
  if (!uploadBtn || !fileInput) return;

  uploadBtn.addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", function () {
    var file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    handleUploadFile(file);
  });
}

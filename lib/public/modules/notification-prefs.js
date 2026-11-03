// notification-prefs.js - the user's per-type notification preferences.
//
// The preferences live on the server, with the user's account, so the phone and
// the desktop agree and push is filtered where it is sent. This module holds the
// last copy the server sent, answers "may this type alert / sound here?" and
// draws the settings card (a preset picker and a surface-by-type grid).
//
// Muting a type never hides it: the notification still lands in the panel and
// on the session's prompt card; only the banner, the sound and the push are
// suppressed.

import { getWs } from './ws-ref.js';

var LEGACY_MIGRATED_KEY = "notif-prefs-migrated";
var SURFACE_LABELS = { banner: "Banner", sound: "Sound", push: "Push" };
var SURFACE_ORDER = ["banner", "sound", "push"];

var current = null;

/** True once the server has sent the user's preferences. */
export function hasNotificationPrefs() {
  return current !== null;
}

/**
 * Whether a surface should alert for a category. Before the server has
 * answered, and for a notification with no category, everything is wanted
 * (today's behaviour).
 */
export function isSurfaceWanted(surface, category) {
  if (!current || !category) return true;
  var row = current.prefs && current.prefs[surface];
  return !row || row[category] !== false;
}

/**
 * Whether a notification just created should chime. The turn-done chime has
 * only ever played while the tab is hidden, so a notification chimes under that
 * same rule AND when the user's sound preference for its type is on. The
 * default preferences leave sound on for a finished turn only, so by default a
 * reminder is silent. A finished turn's own handler plays its chime itself.
 * @param {{type: string, category: ?string}} notif
 * @param {boolean} soundSwitchOn the browser's global sound switch
 */
export function shouldChimeForNotification(notif, soundSwitchOn) {
  if (!notif || notif.type === "response_done") return false;
  if (typeof document === "undefined" || !document.hidden) return false;
  if (!soundSwitchOn) return false;
  // No category: only the "everything wanted" fallback would say yes, which
  // would chime for types that never did. Require a known category.
  return !!notif.category && !!current && isSurfaceWanted("sound", notif.category);
}

function send(msg) {
  var ws = getWs();
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// The browser held global switches before the preferences moved to the server.
// The sound switch carries over, once; the alert and push switches describe
// this browser's permission and subscription and stay with it.
function migrateLegacyOnce(msg) {
  if (msg.known) return;
  var already = false;
  try { already = localStorage.getItem(LEGACY_MIGRATED_KEY) === "1"; } catch (e) { already = false; }
  if (already) return;
  var sound = true;
  try { sound = localStorage.getItem("notif-sound") !== "0"; } catch (e) { sound = true; }
  send({ type: "notification_prefs_migrate", legacy: { sound: sound } });
  try { localStorage.setItem(LEGACY_MIGRATED_KEY, "1"); } catch (e) { /* storage unavailable: the server default stands */ }
}

export function handleNotificationPrefs(msg) {
  current = msg;
  migrateLegacyOnce(msg);
  render();
}

function render() {
  var card = document.getElementById("notif-prefs-card");
  if (!card || !current) return;
  card.innerHTML = "";

  var presetRow = document.createElement("div");
  presetRow.className = "settings-field";
  var presetLabel = document.createElement("label");
  presetLabel.className = "settings-label";
  presetLabel.setAttribute("for", "notif-prefs-preset");
  presetLabel.textContent = "Notify me for";
  var select = document.createElement("select");
  select.id = "notif-prefs-preset";
  select.className = "us-text-input";
  (current.presets || []).forEach(function (p) {
    var opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    select.appendChild(opt);
  });
  var custom = document.createElement("option");
  custom.value = "";
  custom.textContent = "Custom";
  custom.disabled = true;
  select.appendChild(custom);
  select.value = current.preset || "";
  select.addEventListener("change", function () {
    if (select.value) send({ type: "notification_prefs_set", preset: select.value });
  });
  presetRow.appendChild(presetLabel);
  presetRow.appendChild(select);
  var hint = document.createElement("div");
  hint.className = "settings-hint";
  hint.textContent = "A muted type still appears in the notifications panel and on the session's prompt card; only the banner, the sound and the push are suppressed.";
  presetRow.appendChild(hint);
  card.appendChild(presetRow);

  var table = document.createElement("table");
  table.className = "notif-prefs-grid";
  var head = document.createElement("tr");
  head.appendChild(document.createElement("th"));
  SURFACE_ORDER.forEach(function (surface) {
    var th = document.createElement("th");
    th.textContent = SURFACE_LABELS[surface];
    head.appendChild(th);
  });
  table.appendChild(head);
  (current.categories || []).forEach(function (cat) {
    var tr = document.createElement("tr");
    var name = document.createElement("td");
    name.textContent = cat.label;
    tr.appendChild(name);
    SURFACE_ORDER.forEach(function (surface) {
      var td = document.createElement("td");
      var box = document.createElement("input");
      box.type = "checkbox";
      box.checked = isSurfaceWanted(surface, cat.id);
      box.setAttribute("data-surface", surface);
      box.setAttribute("data-category", cat.id);
      box.setAttribute("aria-label", cat.label + ": " + SURFACE_LABELS[surface]);
      box.addEventListener("change", function () {
        var patch = {};
        patch[surface] = {};
        patch[surface][cat.id] = box.checked;
        send({ type: "notification_prefs_set", surfaces: patch });
      });
      td.appendChild(box);
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });
  card.appendChild(table);
}

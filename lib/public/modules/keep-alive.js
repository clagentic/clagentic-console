// keep-alive.js - the operator's per-session keep-alive pin. A pinned session
// is skipped by the idle reaper, so a coordinator that sits waiting for other
// sessions' messages is not ended after 30 minutes of silence. Memory pressure
// can still end it. Shown as a toggle in the session header, a badge on the
// session lists, and a context menu entry.

import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { refreshIcons, iconHtml } from './icons.js';

var lastSessions = [];

export var KEEP_ALIVE_ON_TITLE = "Kept alive: Clagentic: Console will not end this session for being idle. Click to allow idle ending.";
export var KEEP_ALIVE_OFF_TITLE = "Keep this session alive: stop Clagentic: Console ending it after it sits idle";

/** Asks the server to pin or unpin a session. */
export function sendSessionKeepAlive(sessionId, keepAlive) {
  var ws = getWs();
  if (ws && store.get('connected')) {
    ws.send(JSON.stringify({ type: "set_session_keep_alive", sessionId: sessionId, keepAlive: !!keepAlive }));
  }
}

/** HTML for the pin badge shown on a session row, empty when not pinned. */
export function keepAliveBadgeHtml(session) {
  if (!session || !session.keepAlive) return "";
  return '<span class="session-keepalive-badge" title="Kept alive: not ended when idle">' + iconHtml("pin") + '</span>';
}

function activeSession() {
  var activeId = store.get('activeSessionId');
  for (var i = 0; i < lastSessions.length; i++) {
    if (lastSessions[i].id === activeId) return lastSessions[i];
  }
  return null;
}

function paintButton() {
  var btn = document.getElementById("header-keepalive-btn");
  if (!btn) return;
  var s = activeSession();
  var on = !!(s && s.keepAlive);
  btn.classList.toggle("active", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.title = on ? KEEP_ALIVE_ON_TITLE : KEEP_ALIVE_OFF_TITLE;
  btn.classList.toggle("hidden", !s);
}

/** Called with every session_list broadcast. */
export function syncKeepAliveButton(sessions) {
  lastSessions = Array.isArray(sessions) ? sessions : [];
  paintButton();
  refreshIcons();
}

/** Wires the header toggle; call once from initHeader. */
export function initKeepAliveButton() {
  var btn = document.getElementById("header-keepalive-btn");
  if (!btn) return;
  btn.addEventListener("click", function () {
    var s = activeSession();
    if (!s) return;
    sendSessionKeepAlive(s.id, !s.keepAlive);
  });
  store.subscribe(['activeSessionId'], paintButton);
}

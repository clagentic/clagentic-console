// app-connection.js - WebSocket connection, reconnect, status
// Extracted from app.js (PR-22)

import { store } from './store.js';
import { getWs, setWs } from './ws-ref.js';
import { getStatusDot, getSendBtn } from './dom-refs.js';
import { setSendBtnMode, blinkIO } from './app-favicon.js';
import { startLogoAnimation, stopLogoAnimation } from './console-logo.js';
import { hasSendableContent } from './input.js';
import { processMessage } from './app-messages.js';
import { flushPendingExtMessages } from './app-misc.js';
import { isHomeHubVisible } from './app-home-hub.js';
import { resetTerminals } from './terminal.js';
import { closeDmUserPicker } from './sidebar-users.js';
import { openDm } from './app-dm.js';
import { getPaletteVersion } from './command-palette.js';
import { sessionActivity, indicatorClass } from './activity-state.js';

var reconnectTimer = null;
var reconnectDelay = 100;
var connectTimeoutId = null;
var connectOverlay = null;
var overlayGraceTimer = null;

// --- Stale-bundle watchdog (lr-e0ec47) ---
// A foregrounded mobile PWA can be stuck serving a pre-deploy bundle from
// the service worker's cache (see sw.js network-first/cache-fallback). If
// that stale bundle predates a WS/message contract change, the reconnect
// FSM can wedge on "reconnecting" indefinitely even though the server is
// reachable. Each reconnect attempt compares the server's currently served
// version (fetched from /info) against the version this client's own WS
// handshake last reported running (command-palette's cachedVersion, set
// from the "info" WS message). A version mismatch that survives several
// consecutive disconnected reconnect attempts means we are not going to
// self-heal by reconnecting — force a hard reload to fetch the fresh bundle.
var STALE_VERSION_THRESHOLD = 3;
var staleVersionStreak = 0;

// Message types that warrant a visible IO blink. Everything else is
// background infrastructure traffic (presence, rate-limit accounting,
// cursor relay, session list updates, input echo) that does not need
// to trigger the querySelector-heavy blinkIO() path on the main thread.
var _blinkTypes = {
  delta: true,
  thinking_delta: true,
  message: true,
  stop: true,
  tool_start: true,
  tool_result: true,
  tool_progress: true,
  permission_request: true,
  elicitation_request: true,
  ask_user_question: true,
  subagent_activity: true,
  thinking_start: true,
  thinking_done: true,
  done: true,
  error: true,
  rate_limit: true,
};

export function initConnection() {
  connectOverlay = document.getElementById("connect-overlay");

  var signinBtn = document.getElementById("connect-overlay-signin-btn");
  if (signinBtn) {
    signinBtn.addEventListener("click", function () {
      // The session is already gone server-side; reloading re-requests "/"
      // which server.js:519 serves as the login page for an unauthed
      // request. No client-side router exists for auth state (see
      // lib/pages.js), so a full reload is the correct navigation here.
      location.reload();
    });
  }

  // --- Reactive UI sync for connected/processing state ---
  store.subscribe(['connected', 'processing'], function (state, prev) {
    // Status dot (depends on both connected and processing). lr-66c118:
    // routed through the same derivation every other dot uses rather than
    // writing '.processing' independently. lr-5edd64: state.processing is
    // now a projection of the focused session's server-authoritative
    // isProcessing (app-messages.js's session_list/session_switched
    // handlers) rather than a client-local edge latch — always tone 'self'
    // here since this dot represents the viewing user's own connection.
    if (state.connected !== prev.connected || state.processing !== prev.processing) {
      var dot = getStatusDot();
      if (dot) {
        dot.className = "icon-strip-status";
        if (state.connected) {
          dot.classList.add("connected");
          var connActivityCls = indicatorClass(sessionActivity({ isProcessing: state.processing }));
          if (connActivityCls) dot.classList.add(connActivityCls);
        }
      }
    }

    // Connected state changed
    if (state.connected !== prev.connected) {
      var sendBtn = getSendBtn();
      if (state.connected) {
        // Cancel any pending grace timer — reconnected before overlay was needed
        if (overlayGraceTimer) { clearTimeout(overlayGraceTimer); overlayGraceTimer = null; }
        if (sendBtn) sendBtn.disabled = false;
        if (connectOverlay) connectOverlay.classList.add("hidden");
        var updPill = document.getElementById("update-pill-wrap");
        if (updPill) updPill.classList.add("hidden");
        stopLogoAnimation();
        // Reset any lr-de5fcb Surface-1 "session expired" state left over
        // from a prior unauthenticated episode, now that we're connected.
        var signinBtnReset = document.getElementById("connect-overlay-signin-btn");
        if (signinBtnReset) signinBtnReset.classList.add("hidden");
        var msgElReset = document.getElementById("connect-overlay-msg");
        if (msgElReset) msgElReset.textContent = "Reconnecting to server…";
      } else {
        if (sendBtn) sendBtn.disabled = true;
        // Clear any in-progress replay indicator — history_done won't fire on disconnect.
        var replayEl = document.getElementById("replay-loading");
        if (replayEl) replayEl.classList.add("hidden");
        // Delay showing the overlay by 600ms — absorbs brief AP switches and
        // sub-second network hiccups without flashing the full-screen animation.
        if (overlayGraceTimer) clearTimeout(overlayGraceTimer);
        overlayGraceTimer = setTimeout(function () {
          overlayGraceTimer = null;
          if (!store.get('connected')) {
            if (connectOverlay) connectOverlay.classList.remove("hidden");
            startLogoAnimation();
          }
        }, 600);
      }
    }

    // Processing state changed
    if (state.processing !== prev.processing) {
      if (state.processing) {
        setSendBtnMode(hasSendableContent() ? "send" : "stop");
      } else {
        // Always reset to send when processing stops — even on disconnect.
        // Without this, if the WS drops while Claude is running, the button
        // stays in stop mode: the reconnect path skips setSendBtnMode because
        // processing is already false (unchanged) by then, and the
        // _sendBtnMode cache prevents the DOM from self-correcting.
        // Calling setSendBtnMode when disconnected is harmless — the button
        // is already disabled — but it ensures the cache is "send" so the
        // button shows correctly when the connection is restored. (lr-e6b5-2)
        setSendBtnMode("send");
      }
    }
  });
}

// setStatus: connection lifecycle, plus the two remaining legitimate
// session-scoped PUSH raises of 'processing' (lr-5edd64). The status/done/
// auth_required handlers no longer call this with "processing"/"connected"
// to drive it — that was the client-local latch with no reconciliation
// MILLER's lr-5edd64 diagnosis identified. 'processing' is now primarily a
// PROJECTION: re-derived from the session_list entry for the active session
// and the session_switched snapshot (app-messages.js) on every broadcast,
// regardless of whether anything pushed it in between — so even if one of
// the two remaining pushes below is ever missed or mis-scoped, the next
// session_list/session_switched self-corrects it (comment #2 Q5's push+
// query requirement). scheduled_message_sent and auto_continue_fired keep
// calling setStatus("processing") here because they are genuine "a turn
// just started for the focused session" server pushes, same shape as the
// deleted status:"processing" push, just for two different message types —
// deleting the push entirely (rather than just the previously-redundant
// status/done/auth_required copies of it) would leave a real WS event with
// no immediate raise until the next session_list tick.
export function setStatus(status) {
  if (status === "connected") {
    store.set({ connected: true });
  } else if (status === "processing") {
    store.set({ processing: true });
  } else {
    store.set({ connected: false, processing: false });
  }
}

function onConnected() {
  // Flush any extension messages that arrived before WS was ready
  flushPendingExtMessages();

  // Reset terminal xterm instances (server will send fresh term_list)
  resetTerminals();

  // Re-send push subscription on reconnect
  var ws = getWs();
  if (window._pushSubscription) {
    try {
      ws.send(JSON.stringify({
        type: "push_subscribe",
        subscription: window._pushSubscription.toJSON(),
      }));
    } catch(e) {}
  }

  // Session restore is now server-driven (user-presence.json).
  try { localStorage.removeItem("clagentic-active-dm"); localStorage.removeItem("clay-active-dm"); } catch (e) {}

  // If the home hub was visible when the connection came up (common on mobile
  // PWA cold-start where showHomeHub() fires before the WS is open), re-request
  // hub data now that the socket is ready. Without this, the recent sessions and
  // schedules cards show empty because the initial hub_recent_sessions_list send
  // in showHomeHub() was dropped when readyState !== 1.
  if (isHomeHubVisible()) {
    try {
      var hubWs = getWs();
      if (hubWs && hubWs.readyState === 1) {
        hubWs.send(JSON.stringify({ type: "hub_schedules_list" }));
        hubWs.send(JSON.stringify({ type: "hub_recent_sessions_list" }));
      }
    } catch (e) {}
  }
}

// handleUnauthenticated (lr-de5fcb Surface 1): the reconnect FSM previously
// treated a 401 identically to a transient disconnect — it kept showing
// "reconnecting to server" and silently called location.reload() on the
// next /info poll, which just re-served the login page. The user perceived
// an endless reconnect loop with no signal that they needed to log back in.
// This stops the reconnect machinery outright and swaps the overlay to an
// explicit "session expired" state with a manual sign-in action, instead of
// auto-reloading (auto-reload here would immediately re-trigger connect(),
// which would hit /api/ws-ticket 401 again — a tight loop of its own).
function handleUnauthenticated() {
  cancelReconnect();
  if (connectTimeoutId) { clearTimeout(connectTimeoutId); connectTimeoutId = null; }
  if (overlayGraceTimer) { clearTimeout(overlayGraceTimer); overlayGraceTimer = null; }
  setStatus("disconnected");
  stopLogoAnimation();
  var msgEl = document.getElementById("connect-overlay-msg");
  if (msgEl) msgEl.textContent = "Session expired — sign in again.";
  var signinBtn = document.getElementById("connect-overlay-signin-btn");
  if (signinBtn) signinBtn.classList.remove("hidden");
  if (connectOverlay) connectOverlay.classList.remove("hidden");
}

// Fetch a short-TTL, single-use WS-upgrade ticket (lr-de5fcb). The session
// cookie is HttpOnly (unreadable by JS), so the client cannot read the raw
// session token — it must ask the server for a ticket over a normal
// authenticated HTTP request instead. This request DOES reliably carry the
// cookie (it's not a script-initiated WebSocket upgrade), which is exactly
// the mobile-browser gap this ticket exists to route around: mobile
// browsers don't reliably attach a SameSite=Lax cookie to the WS handshake
// itself. Returns { ticket } on success, or { unauthenticated: true } on a
// 401, or { ticket: null } on any other failure (network hiccup — the
// upgrade will then rely on the cookie alone, same as before this fix).
function fetchWsTicket() {
  return fetch("/api/ws-ticket", { credentials: "same-origin" })
    .then(function (res) {
      if (res.status === 401) return { unauthenticated: true };
      if (!res.ok) return { ticket: null };
      return res.json().then(function (data) {
        return { ticket: (data && data.ticket) || null };
      }).catch(function () { return { ticket: null }; });
    })
    .catch(function () { return { ticket: null }; });
}

// Milliseconds to wait before re-verifying a single ws-ticket 401 (lr-e5c1fe).
var UNAUTH_RETRY_BACKOFF_MS = 400;

// lr-e5c1fe: a tab woken from background (visibilitychange / OS resume) can
// fire its first post-wake fetch before the browser has reattached cookies
// to outgoing requests — server-auth.js's getMultiUserFromReq() is a pure,
// synchronous cookie-header lookup with no server-side race of its own, so a
// 401 on /api/ws-ticket while the session cookie IS still valid can only be
// a client-side cookie-attachment gap on that one fetch, not a real session
// expiry. Treating a SINGLE such 401 as terminal showed the full-screen
// "session expired" wall on a session that "Sign in again" (a bare connect()
// re-run) then proved was still good. Re-verify once, after a short backoff,
// before declaring the session gone — only two consecutive 401s (auth
// actually confirmed absent) route to handleUnauthenticated().
export function connect() {
  var ws = getWs();
  if (ws) { ws.onclose = null; ws.onmessage = null; ws.onerror = null; ws.close(); }
  if (connectTimeoutId) { clearTimeout(connectTimeoutId); connectTimeoutId = null; }

  fetchWsTicket().then(function (result) {
    if (result.unauthenticated) {
      setTimeout(function () {
        fetchWsTicket().then(function (retryResult) {
          if (retryResult.unauthenticated) {
            // Two consecutive 401s: auth is confirmed gone, not a transient
            // wake-from-background cookie-attachment gap. Route to sign-in
            // instead of opening a socket that would only 401 on the
            // upgrade too — ties into the Surface-1 unauth-vs-unreachable
            // split below.
            handleUnauthenticated();
            return;
          }
          openSocket(retryResult.ticket);
        });
      }, UNAUTH_RETRY_BACKOFF_MS);
      return;
    }
    openSocket(result.ticket);
  });
}

// openSocket does the actual WebSocket construction. Split out from
// connect() so the ticket fetch (network round-trip) can complete first
// without duplicating the onopen/onclose/onmessage wiring.
function openSocket(ticket) {
  // WS URL is derived strictly from window.location — never from the
  // daemon.js:239-243 LAN/share host resolution (which may prefer a
  // 100.x Tailscale address). Pointing the socket at a different origin
  // than the page was served from would re-introduce a cross-origin
  // session mismatch; same-origin is a load-bearing invariant here, not
  // an incidental default (lr-de5fcb / lr-e0ec47 comment #4).
  var protocol = location.protocol === "https:" ? "wss:" : "ws:";
  var url = protocol + "//" + location.host + store.get('wsPath');
  var newWs = ticket ? new WebSocket(url, ["clagentic.auth." + ticket]) : new WebSocket(url);
  setWs(newWs);

  // If not connected within 3s, force retry
  connectTimeoutId = setTimeout(function () {
    if (!store.get('connected')) {
      newWs.onclose = null;
      newWs.onerror = null;
      newWs.onmessage = null;
      newWs.close();
      connect();
    }
  }, 3000);

  // Track whether this socket ever reached onopen. A upgrade rejected with
  // 401 (server.js:781 area — socket.write + socket.destroy, not a clean WS
  // close frame) closes the browser WebSocket WITHOUT ever firing onopen.
  // That is the only client-observable signal that distinguishes "rejected
  // upgrade" from "connected then dropped" — the close event itself carries
  // no HTTP status (lr-de5fcb Surface 1).
  var everOpened = false;

  newWs.onopen = function () {
    everOpened = true;
    if (connectTimeoutId) { clearTimeout(connectTimeoutId); connectTimeoutId = null; }
    setStatus("connected");
    reconnectDelay = 100;
    staleVersionStreak = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    // Wrap ws.send to blink LED on outgoing traffic
    var currentWs = getWs();
    var _origSend = currentWs.send.bind(currentWs);
    currentWs._sendRaw = _origSend;
    currentWs.send = function (data) {
      blinkIO();
      return _origSend(data);
    };

    onConnected();
  };

  newWs.onclose = function (e) {
    if (connectTimeoutId) { clearTimeout(connectTimeoutId); connectTimeoutId = null; }
    closeDmUserPicker();
    setStatus("disconnected");
    // lr-66c118: the setActivity(null) clear formerly here is gone —
    // setActivity collapsed to one optimistic raise (input.js), no manual clears.
    // lr-0446: Discard any pending cross-project session switch. If the WS
    // closed before the target project's session_list fired, the key is now
    // stale — leaving it would cause the *next* successful session_list (on
    // any project reconnect) to switch to a wrong session.
    try { sessionStorage.removeItem("pending-hub-session"); } catch (e) {}

    // A socket that had a valid ticket AND still never opened means the
    // upgrade itself was rejected as unauthenticated (both the cookie and
    // the fresh ticket failed, or the ticket was already consumed by a
    // racing tab) rather than a reachability problem — don't mask this as
    // an endless "reconnecting to server" spinner (lr-de5fcb Surface 1).
    if (!everOpened && ticket) {
      handleUnauthenticated();
      return;
    }
    scheduleReconnect();
  };

  newWs.onerror = function () {};

  newWs.onmessage = function (event) {
    // Backup: if we're receiving messages, we're connected
    if (!store.get('connected')) {
      setStatus("connected");
      reconnectDelay = 100;
      staleVersionStreak = 0;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    }

    var msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    // Only blink the IO indicator for user-visible activity. Background
    // infrastructure messages (rate_limit_usage, session_list, input_sync_broadcast,
    // cursor_move, text_select, session_presence, session_io, etc.) are excluded
    // so the querySelector storm inside blinkIO() doesn't fire on every
    // server heartbeat or collab event during typing.
    if (_blinkTypes[msg.type]) blinkIO();
    processMessage(msg);
  };
}

export function cancelReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

export function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(function () {
    reconnectTimer = null;
    // Attempt reconnect immediately — don't block on /info preflight.
    // Check auth in parallel: if the server returns 401 while we're trying
    // to connect, route to the explicit unauthenticated state (lr-de5fcb
    // Surface 1) instead of silently reloading into a fresh reconnect loop.
    // lr-e5c1fe: a single 401 here can be the same transient wake-from-
    // background cookie-attachment gap fetchWsTicket() guards against in
    // connect() — re-verify once before treating it as terminal, so this
    // preflight can't independently fire the sign-in wall on a still-valid
    // session out from under connect()'s own retry.
    fetch("/info").then(function (res) {
      if (res.status === 401) {
        return new Promise(function (resolve) {
          setTimeout(function () {
            fetch("/info").then(function (retryRes) {
              if (retryRes.status === 401) { handleUnauthenticated(); resolve(null); return; }
              resolve(retryRes.ok ? retryRes.json().catch(function () { return null; }) : null);
            }).catch(function () { resolve(null); });
          }, UNAUTH_RETRY_BACKOFF_MS);
        });
      }
      return res.ok ? res.json().catch(function () { return null; }) : null;
    }).then(function (info) {
      if (info) checkStaleVersion(info);
    }).catch(function () {});
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
}

// Compare the server's currently-served version (from /info) against the
// version this client's own WS session last reported running. A mismatch
// that persists across several consecutive disconnected reconnect attempts
// means the running bundle predates the current deploy and the SW's
// registration.update() path has not (yet) replaced it — reload rather than
// keep retrying a connection whose client code may no longer match the
// server's message contract (lr-e0ec47).
function checkStaleVersion(info) {
  if (store.get('connected')) { staleVersionStreak = 0; return; }
  var runningVersion = getPaletteVersion();
  var servedVersion = info && info.version;
  if (!runningVersion || !servedVersion || servedVersion === runningVersion) {
    staleVersionStreak = 0;
    return;
  }
  staleVersionStreak++;
  if (staleVersionStreak >= STALE_VERSION_THRESHOLD) {
    location.reload();
  }
}

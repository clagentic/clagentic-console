// The page side of notification routing: the one router a tap, a deep link and
// the service worker's route message all use, plus the reconcile that closes a
// shown notification whose prompt has ended.
import '../notify-target.js';
import '../notify-sw-logic.js';
import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { switchProject } from './app-projects.js';
import { openDm } from './app-dm.js';

var Target = globalThis.NotifyTarget;
var PENDING_KEY = 'pending-notif-session';
var PENDING_PEER_KEY = 'pending-notif-dm';
var PENDING_PLACE_KEY = 'pending-notif-place';

export var urlForTarget = Target.urlForTarget;

var lastState = null;
var lastLivePrompts = null;

// The session a route is waiting to open once the connection is up. Held in
// memory as well as in sessionStorage: sessionStorage can be unavailable
// (private mode, quota), and the target must not depend on it.
var pendingSession = null;
// True while the deep link's query is still on the URL as the only durable
// copy of the target (sessionStorage refused it).
var queryHoldsTarget = false;
// The person whose conversation a route is waiting to open once connected.
// Held like the session: in memory, and in sessionStorage so a reload or a
// suspension before the connection is up keeps the destination.
var pendingPeer = null;
// True while the deep link's ?dm= is still on the URL as the only durable copy.
var peerQueryHoldsTarget = false;
// The system notification type a cold-start tap named (?notify=<type>), held
// like the peer so a reload before the connection keeps the destination.
var pendingPlace = null;
var placeQueryHoldsTarget = false;

// The places a system notification's action lives, by type: a system target
// names no project or session, so the type says where it opens. Registered by
// the module that owns the place; the router and the service worker carry no
// per-type branch.
var places = Object.create(null);

/**
 * @param {string} type a notification type.
 * @param {function(object): void} open opens the place; given the target.
 */
export function registerPlace(type, open) {
  places[type] = open;
}

/**
 * The system notification type whose place a cold-start tap is waiting to open,
 * or null; taking it ends the wait (and the query, if it was the only copy).
 * @returns {?string}
 */
export function takePendingPlace() {
  var type = pendingPlace !== null ? pendingPlace : readStored(PENDING_PLACE_KEY);
  pendingPlace = null;
  clearStored(PENDING_PLACE_KEY);
  if (placeQueryHoldsTarget) {
    placeQueryHoldsTarget = false;
    stripQuery(['notify']);
  }
  return type;
}

/**
 * The conversation a route is waiting to open, or null; taking it ends the wait
 * (and with it the deep link's query, if that was the target's only copy).
 * @returns {?string} the other person's user id.
 */
export function takePendingPeer() {
  var peer = pendingPeer !== null ? pendingPeer : readStored(PENDING_PEER_KEY);
  pendingPeer = null;
  clearStored(PENDING_PEER_KEY);
  if (peerQueryHoldsTarget) {
    peerQueryHoldsTarget = false;
    stripQuery(['dm']);
  }
  return peer;
}

// Returns whether sessionStorage took the target; the in-memory copy is kept
// either way.
function rememberPendingPeer(peer) {
  pendingPeer = String(peer);
  return storeValue(PENDING_PEER_KEY, pendingPeer);
}

function storeValue(key, value) {
  try {
    sessionStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.debug('[notify] could not store ' + key + ':', e && e.message ? e.message : e);
    return false;
  }
}

function readStored(key) {
  try {
    return sessionStorage.getItem(key);
  } catch (e) {
    console.debug('[notify] could not read ' + key + ':', e && e.message ? e.message : e);
    return null;
  }
}

function clearStored(key) {
  try {
    sessionStorage.removeItem(key);
  } catch (e) {
    console.debug('[notify] could not clear ' + key + ':', e && e.message ? e.message : e);
  }
}

// Returns whether sessionStorage took the target. The in-memory copy is always
// kept, so a caller that sees false still has the route.
function rememberPendingSession(id) {
  pendingSession = String(id);
  return storeValue(PENDING_KEY, pendingSession);
}

function stripQuery(keys) {
  var params = new URLSearchParams(location.search);
  keys.forEach(function (k) { params.delete(k); });
  var rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
}

/**
 * The session a route is waiting to open, or null. Call it only once the
 * connection can carry the switch: taking it ends the wait, and with it the
 * deep link's query if that was the target's only copy.
 * @returns {?number}
 */
export function takePendingSession() {
  var raw = pendingSession !== null ? pendingSession : readStored(PENDING_KEY);
  pendingSession = null;
  clearStored(PENDING_KEY);
  if (queryHoldsTarget) {
    queryHoldsTarget = false;
    stripQuery(['session', 'request']);
  }
  return raw === null ? null : parseId(raw);
}

function parseId(id) {
  var n = parseInt(id, 10);
  return isNaN(n) ? null : n;
}

// Opens the target's project and session in this page. A different project is
// switched to first, and the session is picked up by handleNotificationsState
// through the pending key once that project's connection is up; the same
// project switches at once when its connection is open, else the same key
// carries it.
export function routeTo(target, type) {
  var t = Target.makeTarget(target);
  if (!t) return;
  // A system notification's target names no place: its type does.
  if (!t.peerId && !t.slug && !t.sessionId && type && places[type]) {
    places[type](t);
    return;
  }
  // A direct message opens the conversation with the other person; before the
  // connection is up it waits for takePendingPeer.
  if (t.peerId) {
    var peerWs = getWs();
    if (peerWs && peerWs.readyState === 1) openDm(t.peerId);
    else rememberPendingPeer(t.peerId);
    return;
  }
  var current = store.get('currentSlug') || '';
  var sessionId = parseId(t.sessionId);
  if (t.slug && t.slug !== current) {
    if (sessionId !== null) rememberPendingSession(sessionId);
    switchProject(t.slug);
    return;
  }
  if (sessionId === null) return;
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'switch_session', id: sessionId }));
  } else {
    rememberPendingSession(sessionId);
  }
}

// The page was opened on a deep link (/p/<slug>/?session=<id>): route to the
// session once connected, then drop the query so a reload does not repeat it.
// When sessionStorage refused the target, the query stays until the route has
// been taken, so a reload still finds it.
function consumeDeepLink() {
  var peer = Target.parsePeerLink(location.search);
  if (peer) {
    if (rememberPendingPeer(peer)) stripQuery(['dm']);
    else peerQueryHoldsTarget = true;
  }
  var place = Target.parsePlaceLink(location.search);
  if (place) {
    pendingPlace = place;
    if (storeValue(PENDING_PLACE_KEY, place)) stripQuery(['notify']);
    else placeQueryHoldsTarget = true;
  }
  var link = Target.parseDeepLink(location.search);
  if (!link) return;
  if (rememberPendingSession(link.sessionId)) stripQuery(['session', 'request']);
  else queryHoldsTarget = true;
}

// Scoped to this page's own project: the live-prompt record names it, else
// the project the page is on.
function reconcile() {
  if (lastState === null || document.visibilityState !== 'visible') return;
  if (!navigator.serviceWorker || !globalThis.NotifySw) return;
  var scope = {
    slug: (lastLivePrompts && lastLivePrompts.slug) || store.get('currentSlug') || '',
    livePrompts: lastLivePrompts,
  };
  navigator.serviceWorker.ready.then(function (reg) {
    return globalThis.NotifySw.reconcileShown(reg, lastState, scope);
  }).catch(function (e) {
    console.debug('[notify] reconcile failed:', e && e.message ? e.message : e);
  });
}

// Called with each notifications_state; reconciling waits for the first one so
// an empty list at boot never reads as "nothing is live".
export function noteNotificationsState(list, livePrompts) {
  lastState = Array.isArray(list) ? list : [];
  lastLivePrompts = livePrompts || null;
  reconcile();
}

export function initNotifyClient() {
  consumeDeepLink();
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', function (event) {
      if (event.data && event.data.type === 'notify_route') routeTo(event.data.target, event.data.notifyType);
    });
  }
  document.addEventListener('visibilitychange', reconcile);
}

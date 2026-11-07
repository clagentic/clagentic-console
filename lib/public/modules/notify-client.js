// The page side of notification routing: the one router a tap, a deep link and
// the service worker's route message all use, plus the reconcile that closes a
// shown notification whose prompt has ended.
import '../notify-target.js';
import '../notify-sw-logic.js';
import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { switchProject } from './app-projects.js';

var Target = globalThis.NotifyTarget;
var PENDING_KEY = 'pending-notif-session';

export var urlForTarget = Target.urlForTarget;

var lastState = null;

function parseId(id) {
  var n = parseInt(id, 10);
  return isNaN(n) ? null : n;
}

// Opens the target's project and session in this page. A different project is
// switched to first, and the session is picked up by handleNotificationsState
// through the pending key once that project's connection is up; the same
// project switches at once when its connection is open, else the same key
// carries it.
export function routeTo(target) {
  var t = Target.makeTarget(target);
  if (!t) return;
  var current = store.get('currentSlug') || '';
  var sessionId = parseId(t.sessionId);
  if (t.slug && t.slug !== current) {
    if (sessionId !== null) {
      try { sessionStorage.setItem(PENDING_KEY, String(sessionId)); } catch (e) {}
    }
    switchProject(t.slug);
    return;
  }
  if (sessionId === null) return;
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'switch_session', id: sessionId }));
  } else {
    try { sessionStorage.setItem(PENDING_KEY, String(sessionId)); } catch (e) {}
  }
}

// The page was opened on a deep link (/p/<slug>/?session=<id>): route to the
// session once connected, then drop the query so a reload does not repeat it.
function consumeDeepLink() {
  var link = Target.parseDeepLink(location.search);
  if (!link) return;
  try { sessionStorage.setItem(PENDING_KEY, link.sessionId); } catch (e) {}
  var params = new URLSearchParams(location.search);
  params.delete('session');
  params.delete('request');
  var rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
}

function reconcile() {
  if (lastState === null || document.visibilityState !== 'visible') return;
  if (!navigator.serviceWorker || !globalThis.NotifySw) return;
  navigator.serviceWorker.ready.then(function (reg) {
    return globalThis.NotifySw.reconcileShown(reg, lastState);
  }).catch(function () {});
}

// Called with each notifications_state; reconciling waits for the first one so
// an empty list at boot never reads as "nothing is live".
export function noteNotificationsState(list) {
  lastState = Array.isArray(list) ? list : [];
  reconcile();
}

export function initNotifyClient() {
  consumeDeepLink();
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', function (event) {
      if (event.data && event.data.type === 'notify_route') routeTo(event.data.target);
    });
  }
  document.addEventListener('visibilitychange', reconcile);
}

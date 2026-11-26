// app-notifications.js - Notifications: arrival banners and the bell's panel.
// A new notification appears as a banner card in the toast stack and goes after
// 3s unless it needs an answer. The bell button opens the shared list panel
// (list-panel.js) with every stored notification as a row; the rows carry the
// same actions the banners do.

import { refreshIcons, iconHtml } from './icons.js';
import { store } from './store.js';
import { loginCommandFor, defaultVendorId } from './vendor-registry.js';
import { getWs } from './ws-ref.js';
import { openTerminal } from './terminal.js';
import { newTermRequestId } from './pending-term-request.js';
import { wirePromptBanner, restoreUnconfirmedBanners } from './prompt-banner.js';
import { isSurfaceWanted, shouldChimeForNotification } from './notification-prefs.js';
import { playDoneSound, isNotifSoundEnabled } from './notifications.js';
import { initNotifyClient, noteNotificationsState, routeTo, takePendingSession, takePendingPlace, registerPlace } from './notify-client.js';
import { applyBuildOffer, withdrawBuildOffer, openDiagnosticsPanel } from './diagnostics.js';
import { showOverlay } from './overlay.js';
import { getStack, addToStack, removeFromStack, clearGroup } from './overlay-stack.js';
import { createListPanel, rowDismissButton } from './list-panel.js';
import { notificationParts, updateNoticeParts, loginReminderParts } from './notification-card.js';
import '../notify-sw-logic.js';

// The server dismisses a prompt's banner once the prompt settles, however it
// was answered.
var notifications = [];
// The notification behind each banner on screen, by id.
var shownNotifs = Object.create(null);
var unreadCount = 0;
// The shared overlay stack (overlay-stack.js): this module's banners sit in it
// beside the toasts, and clear only their own group.
var bannerContainer = null;
var BANNER_GROUP = "notifications";
var bellBtn = null;
var badgeEl = null;
// The panel the bell opens.
var notifPanel = null;

var BUILD_OFFER_TYPE = "build_update_offer";
var LOGIN_REMINDER_TYPE = "_login_reminder";

// The offer is the transport for the diagnostics pop-up and entry; the bell's
// list and count leave it out, so a lone offer never reads as an unread item
// the bell cannot show.
function isBuildOffer(n) { return !!n && n.type === BUILD_OFFER_TYPE; }
function isBellListed(n) { return !isBuildOffer(n); }

var activeAuthRequiredMsg = null;
var authReminderVisible = false;

function setAuthMsg(msg) {
  activeAuthRequiredMsg = msg;
  refreshPanel();
}

function setReminderVisible(visible) {
  authReminderVisible = visible;
  refreshPanel();
}

// ========================================================
// Init
// ========================================================

export function initAppNotifications() {
  bellBtn = document.getElementById("notif-center-btn");
  badgeEl = document.getElementById("notif-center-badge");

  bannerContainer = getStack();

  initNotifyClient();
  // The build-update offer's action (the restart button) lives in the
  // diagnostics panel; a tap on its push opens it.
  registerPlace(BUILD_OFFER_TYPE, openDiagnosticsPanel);

  notifPanel = createListPanel({
    id: "notifications-panel",
    title: "Notifications",
    emptyText: "No notifications.",
    clearLabel: "Clear all notifications",
    closeLabel: "Close notifications panel",
    opener: bellBtn,
    rowKey: function (item) { return item.id; },
    renderRow: renderNotificationRow,
    onClear: clearAllNotifications,
  });
  refreshPanel();
}

// ========================================================
// The bell's panel: one row per stored notification
// ========================================================

// What the panel lists: every stored notification but the build offer, then the
// sign-in notice and the login reminder while they stand.
function panelItems() {
  var items = notifications.filter(isBellListed);
  if (activeAuthRequiredMsg && !items.some(function (n) { return n.id === activeAuthRequiredMsg.id; })) items.push(activeAuthRequiredMsg);
  if (authReminderVisible) items.push({ id: "_auth_reminder", type: LOGIN_REMINDER_TYPE });
  return items;
}

function refreshPanel() {
  if (notifPanel) notifPanel.sync(panelItems());
}

// A row leaves the list at once; the server's dismissal confirms it. The count
// never exceeds what is stored, so a drop made offline (no dismissal sent, no
// server count back) does not leave the bell stale until the next resync.
function dropLocal(id) {
  notifications = notifications.filter(function (n) { return n.id !== id; });
  unreadCount = Math.min(unreadCount, notifications.length);
  updateBadge();
  refreshPanel();
}

function renderNotificationRow(item) {
  var parts;
  var closePanelAfter = function () { if (notifPanel) notifPanel.close(); };
  var row = document.createElement("div");
  if (item.type === LOGIN_REMINDER_TYPE) {
    parts = loginReminderParts();
    fillRow(row, parts, "Dismiss notification", function () { setReminderVisible(false); });
    wireLoginReminder(row, function () { closePanelAfter(); });
  } else if (item.type === "update_available" && item.meta && item.meta.version) {
    parts = updateNoticeParts(item.meta.version, item.id);
    fillRow(row, parts, "Dismiss notification", function () { dismissNotif(item.id); dropLocal(item.id); });
    wireUpdateNotice(row, closePanelAfter);
  } else {
    parts = notificationParts(item);
    fillRow(row, parts, "Dismiss notification", function () {
      if (parts.isAuthRequired) setAuthMsg(null);
      dismissNotif(item.id);
      dropLocal(item.id);
    });
    wireNotificationActions(row, parts, function () { dropLocal(item.id); closePanelAfter(); });
  }
  return row;
}

function fillRow(row, parts, dismissLabel, onDismiss) {
  row.className = "list-panel-row notif-row" + (parts.modifier ? " " + parts.modifier : "");
  Object.keys(parts.attrs).forEach(function (name) { row.setAttribute(name, parts.attrs[name]); });
  row.innerHTML = parts.content;
  row.appendChild(rowDismissButton({ label: dismissLabel, onClick: onDismiss }));
}

// ========================================================
// Banner (arrival card in the toast stack)
// ========================================================

// An update notice has its own banner (the "Update now" action); every other
// notification renders from the generic one. The build-update offer has none:
// its one alert is the diagnostics pop-up carrying the restart action
// (diagnostics.js), so a stack banner would show the same offer twice.
function showNotificationBanner(notif, autoDismissMs) {
  if (isBuildOffer(notif)) return;
  if (notif.type === "update_available") showUpdateBanner({ version: notif.meta && notif.meta.version }, notif.id);
  else showBanner(notif, autoDismissMs);
}

function showBanner(notif, autoDismissMs) {
  if (!bannerContainer) return;
  var parts = notificationParts(notif);
  notif = parts.notif;
  if (notif.liveInState === true) shownNotifs[notif.id] = notif;

  var banner = showOverlay({
    kind: "banner",
    group: BANNER_GROUP,
    className: "notif-banner" + (parts.modifier ? " " + parts.modifier : ""),
    attrs: parts.attrs,
    content: parts.content,
    closeLabel: "Dismiss notification",
    // Auto-dismiss (number = ms, true = 3 s, false = stay)
    timeout: typeof autoDismissMs === "number" ? autoDismissMs : (autoDismissMs === true ? 3000 : null),
    onDismiss: function () {
      if (parts.isAuthRequired) setAuthMsg(null);
      dismissNotif(notif.id);
    },
    onRemove: bannerRemoved,
  }).el;
  refreshIcons();
  ensureClearAllButton();
  wireNotificationActions(banner, parts, function () { removeBanner(banner); });
}

// The actions of a notification's card, on its banner or its panel row. `done`
// takes the card away when an action ends with it.
function wireNotificationActions(el, parts, done) {
  var notif = parts.notif;
  if (!parts.isAuthRequired) {
    // Click the card body -> navigate + dismiss.
    el.addEventListener("click", function () {
      done();
      dismissNotif(notif.id);
      navigateToNotification(notif);
    });
  }

  // Prompt answers. The card stays until the server settles the prompt and
  // dismisses it; meanwhile it is in the card's sending state, so a lost
  // confirmation or a dropped socket never reads as an answer.
  if (parts.isPermission) {
    var gotoBtn = el.querySelector(".notif-banner-goto");
    wirePromptBanner(el, { requestId: notif.meta.requestId, kind: parts.promptKind, slug: notif.slug }, sendWs);
    if (gotoBtn) {
      gotoBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        navigateToNotification(notif);
        done();
        dismissNotif(notif.id);
      });
    }
  }

  if (parts.isAuthRequired) {
    var loginBtn = el.querySelector(".notif-banner-auth-login");
    if (loginBtn) {
      loginBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        setAuthMsg(null);
        done();
        dismissNotif(notif.id);
        var login = authLoginFor(notif);
        startLoginCommand(login.loginCommand, login.vendor);
        showLoginReminderBanner();
      });
    }
  }
}

function startLoginCommand(loginCommand, vendor) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1 || !loginCommand) return;
  var termCommand = loginCommand + "\n";
  // The terminal that answers this request id is this login's: marking it
  // makes its output, and only its output, feed the sign-in panel.
  var requestId = newTermRequestId();
  store.set({ pendingTermCommand: termCommand, pendingLoginVendor: vendor || "", pendingTermRequestId: requestId });
  ws.send(JSON.stringify({ type: "term_create", cols: 80, rows: 24, requestId: requestId }));
  openTerminal();
}

function wireLoginReminder(el, done) {
  var newSessionBtn = el.querySelector(".notif-banner-new-session");
  if (!newSessionBtn) return;
  newSessionBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    setReminderVisible(false);
    var ws = getWs();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "new_session" }));
    }
    done();
  });
}

function showLoginReminderBanner() {
  if (!bannerContainer) return;
  var existing = bannerContainer.querySelector('[data-auth-reminder="true"]');
  if (existing) removeBanner(existing);
  var parts = loginReminderParts();
  var banner = showOverlay({
    kind: "banner",
    group: BANNER_GROUP,
    className: "notif-banner " + parts.modifier,
    attrs: parts.attrs,
    content: parts.content,
    closeLabel: "Dismiss notification",
    onDismiss: function () { setReminderVisible(false); },
    onRemove: bannerRemoved,
  }).el;
  refreshIcons();
  setReminderVisible(true);
  wireLoginReminder(banner, function () { removeBanner(banner); });
}

/**
 * Which agent a not-logged-in notice is about and the command that signs in to
 * it: the notice's own, else the registry's for that agent.
 * @param {?object} msg  an auth_required message or notification
 * @returns {{vendor: string, loginCommand: string}}
 */
export function authLoginFor(msg) {
  var meta = (msg && msg.meta) || {};
  var vendor = (msg && msg.vendor) || meta.vendor || defaultVendorId();
  var loginCommand = (msg && msg.loginCommand) || meta.loginCommand || loginCommandFor(vendor);
  return { vendor: vendor, loginCommand: loginCommand };
}

export function showAuthRequiredBanner(msg) {
  if (!bannerContainer) return;
  var login = authLoginFor(msg);
  var vendor = login.vendor;
  var loginCommand = login.loginCommand;
  setAuthMsg(Object.assign({}, msg || {}, {
    id: (msg && msg.id) || ("_auth_" + Date.now()),
    type: "auth_required",
    vendor: vendor,
    loginCommand: loginCommand,
    meta: Object.assign({}, msg && msg.meta ? msg.meta : {}, {
      vendor: vendor,
      loginCommand: loginCommand,
    }),
  }));
  showBanner(activeAuthRequiredMsg, false);
}

function removeBanner(banner) {
  removeFromStack(banner);
}

// Runs when a banner starts to leave, whoever closed it. The clear-all button
// is updated right away so it disappears before the last banner finishes
// fading out; the count skips a banner that is leaving.
function bannerRemoved(banner) {
  delete shownNotifs[banner.getAttribute("data-notif-id")];
  ensureClearAllButton();
}

// Count real (not in hide animation) banners to decide whether a Clear-all
// affordance is worth showing.
function countActiveBanners() {
  if (!bannerContainer) return 0;
  var banners = bannerContainer.querySelectorAll('.notif-banner');
  var n = 0;
  for (var i = 0; i < banners.length; i++) {
    if (banners[i].classList.contains('hide')) continue;
    if (banners[i].getAttribute('data-notif-id')) n++;
  }
  return n;
}

function ensureClearAllButton() {
  if (!bannerContainer) return;
  var existing = bannerContainer.querySelector('.notif-banner-clear-all');
  if (countActiveBanners() >= 2) {
    if (existing) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'notif-banner-clear-all';
    btn.innerHTML = iconHtml('x') + '<span>Clear all</span>';
    btn.addEventListener('click', clearAllNotifications);
    addToStack(btn, { first: true, group: BANNER_GROUP });
    refreshIcons();
  } else if (existing && existing.parentNode) {
    existing.parentNode.removeChild(existing);
  }
}

// The one clear-all, for the panel's control and the stack's pill: it asks the
// server, which keeps the notifications across a reload, and clears this page
// the way the server's answer will (the build-update offer stays).
function clearAllNotifications() {
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'notification_dismiss_all' }));
  }
  notifications = notifications.filter(isBuildOffer);
  unreadCount = notifications.length;
  updateBadge();
  activeAuthRequiredMsg = null;
  authReminderVisible = false;
  refreshPanel();
  if (bannerContainer) clearGroup(BANNER_GROUP);
}

// Returns true when msg was handed to the socket.
function sendWs(msg) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

/** The connection is gone: banners and rows awaiting a confirmation can be answered again. */
export function restoreUnconfirmedPromptBanners(message) {
  restoreUnconfirmedBanners(bannerContainer, message);
  restoreUnconfirmedBanners(notifPanel && notifPanel.el, message);
}

function dismissNotif(id) {
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "notification_dismiss", ids: [id] }));
  }
}

// ========================================================
// Message handlers
// ========================================================

export function handleNotificationsState(msg) {
  notifications = msg.notifications || [];
  unreadCount = msg.unreadCount || 0;
  updateBadge();
  refreshPanel();
  dropBannersOfEndedPrompts(msg.livePrompts || null);
  syncBuildOffer(notifications);
  noteNotificationsState(notifications, msg.livePrompts);

  // A route waiting on the connection (a project switch, a deep link) opens
  // its session now that this project's socket is up.
  var ws = getWs();
  // A cold-start tap on a system notice names its type: open that place.
  var pendingPlace = takePendingPlace();
  if (pendingPlace) routeTo({ slug: null, sessionId: null }, pendingPlace);
  if (ws && ws.readyState === 1) {
    var pendingId = takePendingSession();
    if (pendingId !== null) ws.send(JSON.stringify({ type: "switch_session", id: pendingId }));
  }
}

// The offer's diagnostics entry follows the server's list, which every connect
// sends: the held offer is shown, and an entry whose offer is gone (closed while
// this page was away) is withdrawn, so a dead restart action cannot stay.
function syncBuildOffer(list) {
  var offer = list.filter(function (n) { return n.type === BUILD_OFFER_TYPE; })[0];
  if (offer) applyBuildOffer(offer, { popup: isSurfaceWanted("banner", offer.category) });
  else withdrawBuildOffer();
}

// A prompt banner and a reminder are tied to a live prompt. The server's list
// (sent on every connect) and its live-prompt record are the truth: after a
// daemon restart no prompt survives, and the dismissals were sent to a
// connection that was gone. The check is the one the push reconcile uses
// (NotifySw.isBannerLive), for every banner the registry marks liveInState.
function dropBannersOfEndedPrompts(livePrompts) {
  if (!bannerContainer) return;
  var banners = bannerContainer.querySelectorAll('.notif-banner[data-live-in-state="true"]');
  for (var i = 0; i < banners.length; i++) {
    var notif = shownNotifs[banners[i].getAttribute("data-notif-id")];
    if (notif && !globalThis.NotifySw.isBannerLive(notif, notifications, livePrompts)) removeBanner(banners[i]);
  }
}

// Session local ids are unique only within a project, and the server sends a
// user's notifications to every project socket that user has open. A session
// id therefore names the viewed session only together with the project slug.
function isViewedProject(slug) {
  return !!slug && slug === (store.get('currentSlug') || "");
}

export function handleNotificationCreated(msg) {
  var notif = msg.notification;

  // Auto-dismiss if it's for the session the user is currently viewing
  var activeSession = store.get('activeSessionId') || null;
  var sameProject = isViewedProject(notif.slug);
  console.log("[notif] created:", notif.type, "slug=" + notif.slug, "sessionId=" + notif.sessionId + "(" + typeof notif.sessionId + ")", "active=" + activeSession + "(" + typeof activeSession + ")", "match=" + (sameProject && notif.sessionId == activeSession));
  if (notif.type !== "auth_required" && notif.sessionId && sameProject && String(notif.sessionId) === String(activeSession)) {
    dismissNotif(notif.id);
    return;
  }

  notifications.unshift(notif);
  unreadCount = msg.unreadCount;
  updateBadge();
  refreshPanel();
  if (notif.type === BUILD_OFFER_TYPE) applyBuildOffer(notif, { popup: isSurfaceWanted("banner", notif.category) });

  // A banner stays until acted on when the type registry says so (the
  // notification's persistent flag; lib/notify/types.js), or when it carries
  // its own persistent marker in meta. It goes away when the user clicks it
  // (which routes to its session), views the session some other way (handled
  // above), closes it, or when its prompt resolves and the server dismisses it.
  var _autoDismiss = !(notif.persistent === true || (notif.meta && notif.meta.persistent === true));

  // The user's per-type choices (lib/notification-prefs.js). A muted type has
  // still been added to the list and counted above: only the alert and the
  // sound are skipped. A sound plays only while the page is hidden, like the
  // finished turn's own chime.
  if (isSurfaceWanted("banner", notif.category)) showNotificationBanner(notif, _autoDismiss);
  if (shouldChimeForNotification(notif, isNotifSoundEnabled())) playDoneSound();
}

export function handleNotificationDismissed(msg) {
  var ids = msg.ids || [];
  var closedOffer = notifications.some(function (n) { return n.type === BUILD_OFFER_TYPE && ids.indexOf(n.id) !== -1; });
  // A dismissal the core sends with the notification that replaces it (an
  // offer refreshed: its change list arrived) is not a close: the pop-up on
  // screen stays until the replacement swaps it. Only a resolve or decline,
  // which carry no replacement, withdraws the offer.
  if (closedOffer && !msg.replaced) withdrawBuildOffer();
  notifications = notifications.filter(function (n) { return ids.indexOf(n.id) === -1; });
  unreadCount = msg.unreadCount;
  updateBadge();
  refreshPanel();
  // Remove corresponding banners if visible
  if (bannerContainer) {
    for (var i = 0; i < ids.length; i++) {
      var el = bannerContainer.querySelector('[data-notif-id="' + ids[i] + '"]');
      if (el) removeBanner(el);
    }
  }
}

// msg.kept names what the clear-all left standing (the build-update offer, which
// only its own close declines). The entry, the pop-up and the list keep it.
export function handleNotificationDismissedAll(msg) {
  var kept = msg && Array.isArray(msg.kept) ? msg.kept : [];
  notifications = notifications.filter(function (n) { return kept.indexOf(n.id) !== -1; });
  if (!notifications.some(function (n) { return n.type === BUILD_OFFER_TYPE; })) withdrawBuildOffer();
  unreadCount = msg && typeof msg.unreadCount === "number" ? msg.unreadCount : notifications.length;
  updateBadge();
  refreshPanel();
  if (bannerContainer) clearGroup(BANNER_GROUP);
}

// ========================================================
// Badge
// ========================================================

function updateBadge() {
  if (!badgeEl) return;
  // The server's count includes the offer (it is a held notification); the
  // list the page holds says how many of those the bell does not show.
  var count = Math.max(0, unreadCount - notifications.filter(isBuildOffer).length);
  if (count > 0) {
    badgeEl.textContent = count > 99 ? "99+" : String(count);
    badgeEl.classList.remove("hidden");
  } else {
    badgeEl.classList.add("hidden");
  }
}

// ========================================================
// Navigation
// ========================================================

// The one router (notify-client.js) opens the notification's project and
// session; the slug is part of the target, as session ids repeat across projects.
function navigateToNotification(notif) {
  routeTo({ slug: notif.slug, sessionId: notif.sessionId, requestId: notif.meta && notif.meta.requestId, peerId: notif.peerId }, notif.type);
}

// ========================================================
// Update available notice
// ========================================================

// A tap on the notice opens the update UI, like a tap on its push; "Update now"
// asks the server to update. `onNavigate` runs after a tap that left the page's
// list for another place.
function wireUpdateNotice(el, onNavigate) {
  el.addEventListener("click", function (e) {
    if (e.target.closest("button")) return;
    routeTo({ slug: null, sessionId: null }, "update_available");
    if (onNavigate) onNavigate();
  });

  var updateBtn = el.querySelector(".notif-banner-update-now");
  if (updateBtn) {
    updateBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var ws = getWs();
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "update_now" }));
        updateBtn.textContent = "Updating...";
        updateBtn.disabled = true;
      }
    });
  }
}

function showUpdateBanner(msg, notifId) {
  if (!msg || !msg.version) return;
  if (!bannerContainer) return;
  var parts = updateNoticeParts(msg.version, notifId);

  // Close -> dismiss. No local throttle; the next hourly check raises a new
  // update_available, which re-shows naturally.
  var banner = showOverlay({
    kind: "banner",
    group: BANNER_GROUP,
    className: "notif-banner " + parts.modifier,
    attrs: parts.attrs,
    content: parts.content,
    closeLabel: "Dismiss notification",
    onDismiss: function () { if (notifId) dismissNotif(notifId); },
    onRemove: bannerRemoved,
  }).el;
  refreshIcons();
  wireUpdateNotice(banner);
}

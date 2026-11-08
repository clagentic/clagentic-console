// app-notifications.js - Notification banners (Apple banner style)
// New notifications appear as individual banners top-right, auto-dismiss after 3s.
// Bell button click shows all stored notifications as banners.

import { refreshIcons, iconHtml } from './icons.js';
import { escapeHtml } from './utils.js';
import { projectIconHtml } from './project-icon.js';
import { store } from './store.js';
import { loginCommandFor, defaultVendorId } from './vendor-registry.js';
import { getWs } from './ws-ref.js';
import { getCachedProjects } from './app-projects.js';
import { userAvatarUrl } from './avatar.js';
import { openTerminal } from './terminal.js';
import { askWording } from './prompt-kinds/index.js';
import { wirePromptBanner, restoreUnconfirmedBanners, bannerActions } from './prompt-banner.js';
import { promptLabelHtml } from './prompt-label.js';
import { isSurfaceWanted, shouldChimeForNotification } from './notification-prefs.js';
import { playDoneSound, isNotifSoundEnabled } from './notifications.js';
import { initNotifyClient, noteNotificationsState, routeTo, takePendingSession, takePendingPlace, registerPlace } from './notify-client.js';
import { applyBuildOffer, withdrawBuildOffer, openDiagnosticsPanel } from './diagnostics.js';
import '../notify-sw-logic.js';

// The server dismisses a prompt's banner once the prompt settles, however it
// was answered.
var notifications = [];
// The notification behind each banner on screen, by id.
var shownNotifs = Object.create(null);
var unreadCount = 0;
var bannerContainer = null;
var bellBtn = null;
var badgeEl = null;

var BUILD_OFFER_TYPE = "build_update_offer";

var activeAuthRequiredMsg = null;
var authReminderVisible = false;

// ========================================================
// Init
// ========================================================

export function initAppNotifications() {
  bellBtn = document.getElementById("notif-center-btn");
  badgeEl = document.getElementById("notif-center-badge");

  // Create banner container
  bannerContainer = document.createElement("div");
  bannerContainer.className = "notif-banner-container";
  document.body.appendChild(bannerContainer);

  initNotifyClient();
  // The build-update offer's action (the restart button) lives in the
  // diagnostics panel; a tap on its banner or push opens it.
  registerPlace(BUILD_OFFER_TYPE, openDiagnosticsPanel);

  if (bellBtn) {
    bellBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      showAllBanners();
    });
  }
}

// ========================================================
// Show all stored notifications as banners
// ========================================================

function showAllBanners() {
  // Clear existing banners first
  if (bannerContainer) bannerContainer.innerHTML = "";

  for (var i = 0; i < notifications.length; i++) {
    showNotificationBanner(notifications[i], false);
  }

  if (activeAuthRequiredMsg) showAuthRequiredBanner(activeAuthRequiredMsg);
  if (authReminderVisible) showLoginReminderBanner();

  // Check if any banner actually got rendered (update/auth banners can be suppressed)
  var hasVisibleBanner = bannerContainer.children.length > 0;
  if (notifications.length === 0 && !hasVisibleBanner) {
    showBanner({
      id: "_empty",
      type: "info",
      title: randomEmptyMessage(),
      body: "",
      slug: "",
    }, 3000);
  }
}

// ========================================================
// Banner
// ========================================================

// An update notice has its own banner (the "Update now" action); every other
// notification renders from the generic one.
function showNotificationBanner(notif, autoDismissMs) {
  if (notif.type === "update_available") showUpdateBanner({ version: notif.meta && notif.meta.version }, notif.id);
  else showBanner(notif, autoDismissMs);
}

function showBanner(notif, autoDismissMs) {
  if (!bannerContainer) return;

  var isEmpty = notif.id === "_empty";
  var isPermission = notif.type === "permission_request" && notif.meta && notif.meta.requestId;
  var isAuthRequired = notif.type === "auth_required";
  var isBuildOffer = notif.type === BUILD_OFFER_TYPE;
  var isUserMention = notif.type === "user_mention";
  var isReminder = notif.type === "permission_reminder";
  var projectIcon = isEmpty ? null : getProjectIcon(notif.slug);
  var projectName = isEmpty ? "" : (isAuthRequired ? "CLAGENTIC" : getProjectName(notif.slug));
  var userMentionAvatarSrc = isUserMention ? buildUserMentionAvatarSrc(notif) : null;

  var banner = document.createElement("div");
  banner.className = "notif-banner" + (isAuthRequired ? " notif-banner-update notif-banner-auth" : isPermission ? " notif-banner-permission" : isUserMention ? " notif-banner-user-mention" : isReminder ? " notif-banner-reminder" : "");
  if (!isEmpty) banner.setAttribute("data-notif-id", notif.id);
  if (!isEmpty && notif.type) banner.setAttribute("data-notif-type", notif.type);
  if (!isEmpty && notif.liveInState === true) {
    banner.setAttribute("data-live-in-state", "true");
    shownNotifs[notif.id] = notif;
  }
  if (isAuthRequired) banner.setAttribute("data-auth-banner", "true");

  var iconHtmlStr = userMentionAvatarSrc
    ? '<img class="notif-banner-avatar" src="' + escapeHtml(userMentionAvatarSrc) + '" alt="' + escapeHtml((notif.meta && notif.meta.fromName) || "User") + '">'
    : isAuthRequired
      ? '<img src="/icon-banded-76.png" width="32" height="32" alt="Clagentic: Console" style="border-radius:8px">'
      : projectIcon
      // projectIconHtml() routes custom (:slug:) icons to a safe <img> tag and
      // emoji to escaped text — the raw `projectIcon` interpolation previously
      // showed ':slug:' as literal text (lr-a6da).
      ? '<span class="notif-banner-emoji">' + projectIconHtml(projectIcon) + '</span>'
      : isEmpty
        ? '<img src="/icon-banded-76.png" width="32" height="32" alt="Clagentic: Console" style="border-radius:8px">'
        : iconHtml("folder");

  // A tool-approval prompt is titled "Can I ...?", like its card.
  var promptKind = isPermission ? (notif.meta.kind || "permission") : null;
  if (promptKind === "permission" && notif.meta.toolName) {
    var wording = askWording(notif.meta.toolName, notif.meta.toolInput);
    notif = Object.assign({}, notif, { title: "Can I " + wording.verb + (wording.target ? " " + wording.target : "") + "?" });
  }

  var actionsHtml = "";
  if (isPermission) {
    actionsHtml =
      '<div class="notif-banner-actions">' +
        bannerActions(promptKind, notif.meta).map(function (a) {
          return '<button class="' + a.className + '" data-decision="' + a.decision + '">' + escapeHtml(a.label) + '</button>';
        }).join("") +
        '<button class="notif-banner-goto" title="Go to session">' + iconHtml("external-link") + '</button>' +
      '</div>';
  } else if (isAuthRequired) {
    actionsHtml =
      '<div class="notif-banner-actions">' +
        '<button class="notif-banner-auth-login notif-banner-update-now">Open terminal &amp; log in</button>' +
      '</div>';
  }

  // The server says whose prompt this is (project, session, agent): a banner
  // reaches every client whatever project it is viewing, and the tool request
  // alone does not say.
  banner.innerHTML =
    '<div class="notif-banner-icon">' + iconHtmlStr + '</div>' +
    '<div class="notif-banner-body">' +
      (projectName ? '<div class="notif-banner-project">' + escapeHtml(projectName) + '</div>' : '') +
      (isPermission ? promptLabelHtml(notif.meta.label) : '') +
      '<div class="notif-banner-title">' + escapeHtml(notif.title) + '</div>' +
      (notif.body ? '<div class="notif-banner-text">' + escapeHtml(notif.body) + '</div>' : '') +
      actionsHtml +
    '</div>' +
    (!isEmpty ? '<button class="notif-banner-close">' + iconHtml("x") + '</button>' : '');

  bannerContainer.appendChild(banner);
  refreshIcons();
  ensureClearAllButton();

  requestAnimationFrame(function () {
    banner.classList.add("show");
  });

  if (!isEmpty) {
    if (!isAuthRequired) {
      // Click banner body -> navigate + dismiss. An offer is not declined by
      // looking at it: its tap opens the place the restart lives in, and only
      // its close button declines it.
      banner.addEventListener("click", function (e) {
        if (e.target.closest(".notif-banner-close")) return;
        removeBanner(banner);
        if (!isBuildOffer) dismissNotif(notif.id);
        navigateToNotification(notif);
      });
    }

    // Close button -> dismiss
    var closeBtn = banner.querySelector(".notif-banner-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (isAuthRequired) activeAuthRequiredMsg = null;
        removeBanner(banner);
        dismissNotif(notif.id);
      });
    }

    // Prompt answers. The banner stays until the server settles the prompt
    // and dismisses it; meanwhile it is in the card's sending state, so a
    // lost confirmation or a dropped socket never reads as an answer.
    if (isPermission) {
      var gotoBtn = banner.querySelector(".notif-banner-goto");
      wirePromptBanner(banner, { requestId: notif.meta.requestId, kind: promptKind, slug: notif.slug }, sendWs);
      if (gotoBtn) {
        gotoBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          navigateToNotification(notif);
          removeBanner(banner);
          dismissNotif(notif.id);
        });
      }
    }

    if (isAuthRequired) {
      var loginBtn = banner.querySelector(".notif-banner-auth-login");
      if (loginBtn) {
        loginBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          activeAuthRequiredMsg = null;
          removeBanner(banner);
          dismissNotif(notif.id);
          startLoginCommand(authLoginFor(notif).loginCommand);
          showLoginReminderBanner();
        });
      }
    }
  }

  // Auto-dismiss (number = ms, false = stay)
  if (typeof autoDismissMs === "number") {
    setTimeout(function () { removeBanner(banner); }, autoDismissMs);
  } else if (autoDismissMs === true) {
    setTimeout(function () { removeBanner(banner); }, 3000);
  }
}

function startLoginCommand(loginCommand) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1 || !loginCommand) return;
  var termCommand = loginCommand + "\n";
  store.set({ pendingTermCommand: termCommand });
  ws.send(JSON.stringify({ type: "term_create", cols: 80, rows: 24 }));
  openTerminal();
}

function showLoginReminderBanner() {
  if (!bannerContainer) return;
  authReminderVisible = true;
  var existing = bannerContainer.querySelector('[data-auth-reminder="true"]');
  if (existing) removeBanner(existing);
  var banner = document.createElement("div");
  banner.className = "notif-banner notif-banner-update";
  banner.setAttribute("data-notif-id", "_auth_reminder");
  banner.setAttribute("data-auth-reminder", "true");
  banner.innerHTML =
    '<div class="notif-banner-icon">' + iconHtml("check-circle") + '</div>' +
    '<div class="notif-banner-body">' +
      '<div class="notif-banner-project">CONSOLE</div>' +
      '<div class="notif-banner-title">Login started</div>' +
      '<div class="notif-banner-text">After the login completes, open a new session so Clagentic: Console picks up the fresh auth state.</div>' +
      '<div class="notif-banner-actions">' +
        '<button class="notif-banner-new-session notif-banner-update-now">Open new session</button>' +
      '</div>' +
    '</div>' +
    '<button class="notif-banner-close">' + iconHtml("x") + '</button>';

  bannerContainer.appendChild(banner);
  refreshIcons();

  requestAnimationFrame(function () {
    banner.classList.add("show");
  });

  var newSessionBtn = banner.querySelector(".notif-banner-new-session");
  if (newSessionBtn) {
    newSessionBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      authReminderVisible = false;
      var ws = getWs();
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "new_session" }));
      }
      removeBanner(banner);
    });
  }

  var closeBtn = banner.querySelector(".notif-banner-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      authReminderVisible = false;
      removeBanner(banner);
    });
  }
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
  activeAuthRequiredMsg = Object.assign({}, msg || {}, {
    id: (msg && msg.id) || ("_auth_" + Date.now()),
    type: "auth_required",
    vendor: vendor,
    loginCommand: loginCommand,
    meta: Object.assign({}, msg && msg.meta ? msg.meta : {}, {
      vendor: vendor,
      loginCommand: loginCommand,
    }),
  });
  showBanner(activeAuthRequiredMsg, false);
}

function removeBanner(banner) {
  if (!banner || !banner.parentNode) return;
  delete shownNotifs[banner.getAttribute("data-notif-id")];
  banner.classList.remove("show");
  banner.classList.add("hide");
  // Update the clear-all button right away so it disappears before the
  // last banner finishes animating out, and again after the node is
  // actually removed in case the count check depends on DOM presence.
  ensureClearAllButton();
  setTimeout(function () {
    if (banner.parentNode) banner.parentNode.removeChild(banner);
    ensureClearAllButton();
  }, 300);
}

// Count real (non-"_empty", not in hide animation) banners to decide
// whether a Clear-all affordance is worth showing.
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
    btn.addEventListener('click', clearAllBanners);
    bannerContainer.insertBefore(btn, bannerContainer.firstChild);
    refreshIcons();
  } else if (existing && existing.parentNode) {
    existing.parentNode.removeChild(existing);
  }
}

function clearAllBanners() {
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'notification_dismiss_all' }));
  }
  // Dismiss visually right away — the server will broadcast
  // notification_dismissed_all too, but doing it optimistically makes
  // the click feel instant.
  if (bannerContainer) {
    var banners = bannerContainer.querySelectorAll('.notif-banner[data-notif-id]');
    for (var i = 0; i < banners.length; i++) removeBanner(banners[i]);
  }
  var btn = bannerContainer && bannerContainer.querySelector('.notif-banner-clear-all');
  if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
}

// Returns true when msg was handed to the socket.
function sendWs(msg) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

/** The connection is gone: banners awaiting a confirmation can be answered again. */
export function restoreUnconfirmedPromptBanners(message) {
  restoreUnconfirmedBanners(bannerContainer, message);
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
  if (offer) applyBuildOffer(offer);
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
  if (notif.type === BUILD_OFFER_TYPE) applyBuildOffer(notif);

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
  if (closedOffer) withdrawBuildOffer();
  notifications = notifications.filter(function (n) { return ids.indexOf(n.id) === -1; });
  unreadCount = msg.unreadCount;
  updateBadge();
  // Remove corresponding banners if visible
  if (bannerContainer) {
    for (var i = 0; i < ids.length; i++) {
      var el = bannerContainer.querySelector('[data-notif-id="' + ids[i] + '"]');
      if (el) removeBanner(el);
    }
  }
}

export function handleNotificationDismissedAll() {
  withdrawBuildOffer();
  notifications = [];
  unreadCount = 0;
  updateBadge();
  if (bannerContainer) bannerContainer.innerHTML = "";
}

// ========================================================
// Badge
// ========================================================

function updateBadge() {
  if (!badgeEl) return;
  if (unreadCount > 0) {
    badgeEl.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
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

// Build the sender avatar URL for a user_mention notification banner.
// Prefers the avatar fields stashed in `notif.meta` (set by the server when the
// notification is created), and falls back to the cached user list from
// `cachedAllUsers` so the banner still has a face even if meta is missing.
function buildUserMentionAvatarSrc(notif) {
  var meta = (notif && notif.meta) || {};
  if (meta.fromAvatarStyle || meta.fromAvatarSeed || meta.fromAvatarCustom) {
    return userAvatarUrl({
      avatarStyle: meta.fromAvatarStyle,
      avatarSeed: meta.fromAvatarSeed,
      avatarCustom: meta.fromAvatarCustom || "",
      username: meta.fromName,
      id: meta.fromUserId,
    }, 32);
  }
  if (meta.fromUserId) {
    var users = store.get('cachedAllUsers') || [];
    for (var i = 0; i < users.length; i++) {
      if (users[i] && users[i].id === meta.fromUserId) return userAvatarUrl(users[i], 32);
    }
  }
  return null;
}

// ========================================================
// Update available banner
// ========================================================

function showUpdateBanner(msg, notifId) {
  if (!msg || !msg.version) return;
  if (!bannerContainer) return;

  var isHeadless = store.get('isHeadlessMode');
  var updTag = msg.version.indexOf("-beta") !== -1 ? "beta" : "latest";

  var banner = document.createElement("div");
  banner.className = "notif-banner notif-banner-update";
  banner.setAttribute("data-notif-id", notifId || "_update");

  var actionsHtml = '';
  if (!isHeadless) {
    actionsHtml =
      '<div class="notif-banner-actions">' +
        '<button class="notif-banner-update-now">Update now</button>' +
      '</div>';
  }

  banner.innerHTML =
    '<div class="notif-banner-icon"><img src="/icon-banded-76.png" width="32" height="32" alt="Clagentic: Console" style="border-radius:8px"></div>' +
    '<div class="notif-banner-body">' +
      '<div class="notif-banner-project">CLAGENTIC</div>' +
      '<div class="notif-banner-title">v' + escapeHtml(msg.version) + ' is available</div>' +
      (isHeadless
        ? '<div class="notif-banner-text">Run: npx @clagentic/console@' + escapeHtml(updTag) + '</div>'
        : '') +
      actionsHtml +
    '</div>' +
    '<button class="notif-banner-close">' + iconHtml("x") + '</button>';

  bannerContainer.appendChild(banner);
  refreshIcons();

  requestAnimationFrame(function () {
    banner.classList.add("show");
  });

  // A tap on the notice opens the update UI, like a tap on its push.
  banner.addEventListener("click", function (e) {
    if (e.target.closest("button")) return;
    routeTo({ slug: null, sessionId: null }, "update_available");
  });

  // "Update now" button
  var updateBtn = banner.querySelector(".notif-banner-update-now");
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

  // Close button -> dismiss. No local throttle; the next hourly check raises
  // a new update_available, which re-shows naturally.
  var closeBtn = banner.querySelector(".notif-banner-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (notifId) dismissNotif(notifId);
      removeBanner(banner);
    });
  }
}

// ========================================================
// Helpers
// ========================================================

var EMPTY_MESSAGES = [
  "Quiet. Too quiet.",
  "Nothing. Suspiciously nothing.",
  "Inbox zero. Brag about it.",
  "No notifications. Are you even working?",
  "All clear. For now.",
  "The void stares back.",
  "Notification-free since just now.",
  "You have 0 problems. Allegedly.",
  "Tumbleweeds.",
  "Your agents are napping.",
];

function randomEmptyMessage() {
  return EMPTY_MESSAGES[Math.floor(Math.random() * EMPTY_MESSAGES.length)];
}

function getProjectIcon(slug) {
  var projects = getCachedProjects();
  for (var i = 0; i < projects.length; i++) {
    if (projects[i].slug === slug) return projects[i].icon || null;
  }
  return null;
}

function getProjectName(slug) {
  var projects = getCachedProjects();
  for (var i = 0; i < projects.length; i++) {
    if (projects[i].slug === slug) return projects[i].title || projects[i].name || slug;
  }
  return slug;
}

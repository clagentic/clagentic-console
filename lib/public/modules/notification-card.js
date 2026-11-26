// notification-card.js - what a notification shows: its icon, text and action
// buttons, as markup. The arrival banner (a card in the toast stack) and the
// row in the Notifications panel draw the same content from here, so a type's
// look and its actions are defined once; each surface wires the buttons itself
// (app-notifications.js).

import { iconHtml } from './icons.js';
import { escapeHtml } from './utils.js';
import { projectIconHtml } from './project-icon.js';
import { store } from './store.js';
import { getCachedProjects } from './app-projects.js';
import { userAvatarUrl } from './avatar.js';
import { askWording } from './prompt-kinds/index.js';
import { bannerActions } from './prompt-banner.js';
import { promptLabelHtml } from './prompt-label.js';

// The product logo in an icon slot (rounded by css, not inline).
var LOGO_HTML = '<img class="notif-banner-logo" src="/icon-banded-76.png" width="32" height="32" alt="Clagentic: Console">';

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

// The sender avatar URL for a user_mention notification. Prefers the avatar
// fields the server stashed in `notif.meta`, and falls back to the cached user
// list so the card still has a face when meta is missing.
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

/**
 * The content of a generic notification (every type but the update notice).
 * @param {object} notif
 * @returns {{notif: object, isPermission: boolean, promptKind: ?string,
 *   isAuthRequired: boolean, modifier: string, attrs: Object<string,string>,
 *   content: string}} `notif` carries the title the card shows; `modifier` is
 *   the type's extra class.
 */
export function notificationParts(notif) {
  var isPermission = notif.type === "permission_request" && !!(notif.meta && notif.meta.requestId);
  var isAuthRequired = notif.type === "auth_required";
  var isUserMention = notif.type === "user_mention";
  var isReminder = notif.type === "permission_reminder";
  var projectIcon = getProjectIcon(notif.slug);
  var projectName = isAuthRequired ? "CONSOLE" : getProjectName(notif.slug);
  var userMentionAvatarSrc = isUserMention ? buildUserMentionAvatarSrc(notif) : null;

  var attrs = { "data-notif-id": notif.id };
  if (notif.type) attrs["data-notif-type"] = notif.type;
  if (notif.liveInState === true) attrs["data-live-in-state"] = "true";
  if (isAuthRequired) attrs["data-auth-banner"] = "true";

  var iconHtmlStr = userMentionAvatarSrc
    ? '<img class="notif-banner-avatar" src="' + escapeHtml(userMentionAvatarSrc) + '" alt="' + escapeHtml((notif.meta && notif.meta.fromName) || "User") + '">'
    : isAuthRequired
      ? LOGO_HTML
      : projectIcon
        // projectIconHtml() routes custom (:slug:) icons to a safe <img> tag and
        // emoji to escaped text.
        ? '<span class="notif-banner-emoji">' + projectIconHtml(projectIcon) + '</span>'
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

  // The server says whose prompt this is (project, session, agent): a card
  // reaches every client whatever project it is viewing, and the tool request
  // alone does not say.
  var content =
    '<div class="notif-banner-icon">' + iconHtmlStr + '</div>' +
    '<div class="notif-banner-body">' +
      (projectName ? '<div class="notif-banner-project">' + escapeHtml(projectName) + '</div>' : '') +
      (isPermission ? promptLabelHtml(notif.meta.label) : '') +
      '<div class="notif-banner-title">' + escapeHtml(notif.title) + '</div>' +
      (notif.body ? '<div class="notif-banner-text">' + escapeHtml(notif.body) + '</div>' : '') +
      actionsHtml +
    '</div>';

  return {
    notif: notif, isPermission: isPermission, promptKind: promptKind, isAuthRequired: isAuthRequired,
    modifier: isAuthRequired ? "notif-banner-update notif-banner-auth" : isPermission ? "notif-banner-permission" : isUserMention ? "notif-banner-user-mention" : isReminder ? "notif-banner-reminder" : "",
    attrs: attrs, content: content,
  };
}

/**
 * The content of an update notice: "Update now", or the command to run when the
 * server is headless.
 * @param {string} version
 * @param {string} notifId
 * @returns {{modifier: string, attrs: Object<string,string>, content: string}}
 */
export function updateNoticeParts(version, notifId) {
  var isHeadless = store.get('isHeadlessMode');
  var updTag = version.indexOf("-beta") !== -1 ? "beta" : "latest";
  var actionsHtml = isHeadless ? '' :
    '<div class="notif-banner-actions">' +
      '<button class="notif-banner-update-now">Update now</button>' +
    '</div>';
  return {
    modifier: "notif-banner-update",
    attrs: { "data-notif-id": notifId || "_update" },
    content:
      '<div class="notif-banner-icon">' + LOGO_HTML + '</div>' +
      '<div class="notif-banner-body">' +
        '<div class="notif-banner-project">CONSOLE</div>' +
        '<div class="notif-banner-title">v' + escapeHtml(version) + ' is available</div>' +
        (isHeadless
          ? '<div class="notif-banner-text">Run: npx @clagentic/console@' + escapeHtml(updTag) + '</div>'
          : '') +
        actionsHtml +
      '</div>',
  };
}

/** The content of the "Login started" reminder. */
export function loginReminderParts() {
  return {
    modifier: "notif-banner-update",
    attrs: { "data-notif-id": "_auth_reminder", "data-auth-reminder": "true" },
    content:
      '<div class="notif-banner-icon">' + iconHtml("check-circle") + '</div>' +
      '<div class="notif-banner-body">' +
        '<div class="notif-banner-project">CONSOLE</div>' +
        '<div class="notif-banner-title">Login started</div>' +
        '<div class="notif-banner-text">After the login completes, open a new session so Clagentic: Console picks up the fresh auth state.</div>' +
        '<div class="notif-banner-actions">' +
          '<button class="notif-banner-new-session notif-banner-update-now">Open new session</button>' +
        '</div>' +
      '</div>',
  };
}

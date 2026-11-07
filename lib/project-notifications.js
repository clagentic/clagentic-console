// project-notifications.js - Global notification queue, event-based creation
// Single instance shared by all projects. All formatting logic lives here.
// Follows attachXxx(ctx) pattern per MODULE_MAP.md

var fs = require("fs");
var path = require("path");
var config = require("./config");
var yokeRegistry = require("./yoke").registry;
var notificationPrefs = require("./notification-prefs");
var audienceFor = require("./push-audience").audienceFor;

var NOTIF_FILE = path.join(config.CONFIG_DIR, "notifications.json");

function generateId() {
  var rand = Math.random().toString(36).substring(2, 8);
  return "n_" + Date.now() + "_" + rand;
}

// ========================================================
// Event -> notification formatters
// ========================================================

var formatters = {
  auth_required: function (data) {
    var vendor = data.vendor || yokeRegistry.ids()[0];
    var vendorName = yokeRegistry.isKnown(vendor) ? yokeRegistry.displayNameFor(vendor) : vendor;
    var title = data.title || (vendorName + " is not logged in");
    return {
      type: "auth_required",
      title: title,
      body: data.body || "Open a terminal, then click the URL and follow the instructions.",
      meta: {
        vendor: vendor,
        loginCommand: data.loginCommand || "",
        linuxUser: data.linuxUser || null,
        canAutoLogin: !!data.canAutoLogin,
      },
    };
  },

  loop_complete: function (data) {
    var reason = data.reason || "complete";
    var body = (reason === "pass" || reason === "complete")
      ? "Completed after " + (data.iterations || 0) + " iteration(s)"
      : reason === "max_iterations"
        ? "Reached max iterations (" + (data.maxIterations || "?") + ")"
        : reason === "stopped"
          ? "Stopped by user"
          : "Ended due to error";
    return {
      type: reason === "error" ? "loop_error" : "loop_complete",
      title: (data.name || "Loop") + " " + (reason === "error" ? "failed" : "complete"),
      body: body,
      meta: { reason: reason, iterations: data.iterations },
    };
  },

  response_done: function (data) {
    return {
      type: "response_done",
      title: data.title || "Response ready",
      body: data.preview || "",
    };
  },

  permission_request: function (data) {
    return {
      type: "permission_request",
      title: data.title || "Permission requested",
      body: data.body || "",
      meta: {
        requestId: data.requestId,
        kind: data.kind || "permission",
        toolName: data.toolName,
        toolInput: data.toolInput || null,
        // So the banner offers the answers the card does (see prompt-banner.js).
        suppressAlwaysAllowRule: data.suppressAlwaysAllowRule === true ? true : undefined,
        defaultToNo: data.defaultToNo === true ? true : undefined,
        // Who asked: a banner reaches every client whatever project it is
        // viewing.
        label: data.label || null,
      },
    };
  },

  // The one live reminder of a session's unanswered prompts (see
  // lib/prompt-reminders.js). Not actionable: it names what waits, and a click
  // goes to the session, where the prompt card answers.
  permission_reminder: function (data) {
    return {
      type: "permission_reminder",
      title: data.title || "Prompts waiting",
      body: data.body || "",
      meta: {
        reminderKey: data.reminderKey || null,
        requestIds: data.requestIds || [],
        count: data.count || 0,
        ageMs: data.ageMs || 0,
        agents: data.agents || [],
        tools: data.tools || [],
      },
    };
  },

  mate_dm: function (data) {
    return {
      type: "mate_dm",
      title: data.senderName || "Message",
      body: data.preview || "Sent you a message",
    };
  },

  mention_response: function (data) {
    return {
      type: "mention_response",
      title: data.title || "Mention response ready",
      body: data.preview || "",
      meta: { avatarMateId: data.avatarMateId || null },
    };
  },

  user_mention: function (data) {
    return {
      type: "user_mention",
      title: "@" + (data.fromName || "Someone"),
      body: data.preview || "Mentioned you",
      meta: {
        fromUserId: data.fromUserId || null,
        fromName: data.fromName || "",
        fromAvatarStyle: data.fromAvatarStyle || null,
        fromAvatarSeed: data.fromAvatarSeed || null,
        fromAvatarColor: data.fromAvatarColor || null,
        fromAvatarCustom: data.fromAvatarCustom || "",
        persistent: true,
      },
    };
  },
};

// ========================================================
// Module (global singleton)
// ========================================================

function attachNotifications(ctx) {
  var broadcastAll = ctx.broadcastAll;
  var sendToUser = ctx.sendToUser || null; // (userId, msg) -> void; iterates all project clients
  // (buildMsg(viewerId) -> msg) -> void; one message per live connection, so a
  // count can differ by viewer. Absent: the global count goes to everyone.
  var broadcastPerViewer = ctx.broadcastPerViewer || null;
  var pushModule = ctx.pushModule;
  var notifications = loadNotifications();
  var prefsStore = ctx.prefsStore || null;
  var reconcileReminders = null;
  var isMultiUser = ctx.isMultiUser || null;
  var listAdmins = ctx.listAdmins || null;

  // A prompt notification (and the reminder about it) is actionable only while
  // its prompt's resolver lives in this process; none survives a restart, so a
  // persisted one would offer buttons for a prompt nothing can answer.
  function loadNotifications() {
    try {
      var raw = fs.readFileSync(NOTIF_FILE, "utf8");
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(function (n) {
          return !(n && (n.type === "permission_request" || n.type === "permission_reminder"));
        });
      }
    } catch (e) {}
    return [];
  }

  function saveNotifications() {
    var tmp = NOTIF_FILE + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(notifications, null, 2));
      fs.renameSync(tmp, NOTIF_FILE);
    } catch (e) {
      console.error("[notifications] Failed to save:", e.message);
    }
  }

  function getUnreadCount() {
    return notifications.length;
  }

  // The badge counts what this viewer is shown, never a banner withheld from
  // them (a larger count would reveal that it exists).
  function unreadCountFor(viewer) {
    return notifications.filter(function (n) { return visibleTo(n, viewer); }).length;
  }

  // Sends buildMsg(viewer) to the given user ids, or to every connection.
  function deliver(userIds, buildMsg) {
    if (userIds && typeof sendToUser === "function") {
      userIds.forEach(function (id) { sendToUser(id, buildMsg(id)); });
    } else if (broadcastPerViewer) {
      broadcastPerViewer(buildMsg);
    } else {
      broadcastAll(buildMsg(null));
    }
  }

  // --- Core API ---

  function notify(event, data) {
    data = data || {};
    var formatter = formatters[event];
    if (!formatter) {
      console.warn("[notifications] Unknown event: " + event);
      return null;
    }
    var formatted = formatter(data || {});
    if (!formatted) return null;

    // A prompt banner carries tool input, so it follows the push audience
    // (lib/push-audience.js): the owner, or the admins for an ownerless session
    // in multi-user mode, never every client.
    if (event === "permission_request" && !data.targetUserId && !Array.isArray(data.targetUserIds)) {
      var audience = audienceFor(data.ownerId, isMultiUser, listAdmins);
      data = Object.assign({}, data, {
        targetUserId: audience.kind === "owner" ? audience.userIds[0] : null,
        targetUserIds: audience.kind === "admins" ? audience.userIds : null,
      });
    }

    var notif = {
      id: generateId(),
      type: formatted.type || event,
      category: notificationPrefs.categoryOfNotification(formatted.type || event),
      title: formatted.title || "",
      body: formatted.body || "",
      slug: data.slug || "",
      sessionId: data.sessionId || null,
      mateId: data.mateId || null,
      ownerId: data.ownerId || null,
      targetUserId: data.targetUserId || null,
      targetUserIds: Array.isArray(data.targetUserIds) ? data.targetUserIds : null,
      createdAt: Date.now(),
      meta: formatted.meta || {},
    };
    notifications.unshift(notif);
    saveNotifications();
    // Targeted at specific users: only their connections hear it. Otherwise
    // every connection does.
    var recipients = null;
    if (notif.targetUserIds && typeof sendToUser === "function") recipients = notif.targetUserIds;
    else if (notif.targetUserId && typeof sendToUser === "function") recipients = [notif.targetUserId];
    deliver(recipients, function (viewer) {
      return {
        type: "notification_created",
        notification: notif,
        unreadCount: recipients || broadcastPerViewer ? unreadCountFor(viewer) : getUnreadCount(),
      };
    });
    return notif;
  }

  function dismiss(ids) {
    var before = notifications.length;
    notifications = notifications.filter(function(n) { return ids.indexOf(n.id) === -1; });
    if (notifications.length !== before) {
      saveNotifications();
      deliver(null, function (viewer) {
        return {
          type: "notification_dismissed",
          ids: ids,
          unreadCount: broadcastPerViewer ? unreadCountFor(viewer) : getUnreadCount(),
        };
      });
    }
  }

  // A prompt notification is only actionable while its prompt is pending; the
  // prompt registry calls this on every transition that ends one, so the
  // banner buttons never outlive it.
  function dismissByRequestId(requestId) {
    if (!requestId) return;
    var ids = notifications.filter(function (n) {
      return n.type === "permission_request" && n.meta && n.meta.requestId === requestId;
    }).map(function (n) { return n.id; });
    if (ids.length) dismiss(ids);
    // A reminder that names this prompt is now wrong, or gone.
    reconcileRemindersNow();
  }

  function dismissAll() {
    if (notifications.length > 0) {
      notifications = [];
      saveNotifications();
      broadcastAll({ type: "notification_dismissed_all", unreadCount: 0 });
    }
  }

  // --- Prompt reminders (scheduling lives in lib/prompt-reminders.js) ---

  function reminderIds(key) {
    return notifications.filter(function (n) {
      return n.type === "permission_reminder" && n.meta && n.meta.reminderKey === key;
    }).map(function (n) { return n.id; });
  }

  // A session has at most one live reminder: the new one replaces the old on
  // every surface (the dismissal and the new notification travel together).
  function replaceReminder(key, data) {
    var old = reminderIds(key);
    if (old.length) dismiss(old);
    return notify("permission_reminder", Object.assign({}, data, { reminderKey: key }));
  }

  function dismissReminder(key) {
    var ids = reminderIds(key);
    if (ids.length) dismiss(ids);
  }

  function setReminderReconciler(fn) {
    reconcileReminders = typeof fn === "function" ? fn : null;
  }

  // Recounts or clears live reminders after a prompt settled or a session's
  // reminders were switched. A fault here must not undo the settle that
  // called it.
  function reconcileRemindersNow() {
    if (!reconcileReminders) return;
    try {
      reconcileReminders();
    } catch (e) {
      console.error("[notifications] reminder reconcile failed:", e && e.message ? e.message : e);
    }
  }

  var PROMPT_TYPES = { permission_request: true, permission_reminder: true };

  function visibleTo(n, viewer) {
    if (Array.isArray(n.targetUserIds)) return n.targetUserIds.indexOf(viewer) !== -1;
    if (PROMPT_TYPES[n.type] && n.targetUserId) return n.targetUserId === viewer;
    return true;
  }

  // --- Connection state (called per-client with sendTo) ---

  // livePrompts: the prompts awaiting the operator in this project when the
  // client connected (lib/notify/live-prompts.js); the page checks the
  // notifications on the device against it.
  function sendConnectionState(ws, sendTo, livePrompts) {
    if (!sendTo) return;
    // A notification aimed at admins only, or a prompt banner aimed at its
    // owner, is not handed to anyone else on connect, as it is not live.
    var viewer = userIdOf(ws);
    sendTo(ws, {
      type: "notifications_state",
      notifications: notifications.filter(function (n) { return visibleTo(n, viewer); }),
      unreadCount: unreadCountFor(viewer),
      livePrompts: livePrompts || null,
    });
    if (prefsStore) sendTo(ws, prefsMessage(userIdOf(ws)));
  }

  // --- Per-user preferences (lib/notification-prefs.js) ---

  function userIdOf(ws) {
    return ws && ws._clagenticUser ? ws._clagenticUser.id : null;
  }

  function prefsMessage(userId) {
    var v = prefsStore.view(userId);
    return {
      type: "notification_prefs",
      prefs: v.prefs,
      preset: v.preset,
      known: v.known,
      categories: notificationPrefs.CATEGORIES.map(function (id) {
        return { id: id, label: notificationPrefs.CATEGORY_LABELS[id] };
      }),
      presets: Object.keys(notificationPrefs.PRESETS).map(function (id) {
        return { id: id, label: notificationPrefs.PRESETS[id].label };
      }),
    };
  }

  // Every connection of the user (the phone and the desktop) hears the change.
  function sendPrefsToUser(userId) {
    var msg = prefsMessage(userId);
    if (userId && typeof sendToUser === "function") sendToUser(userId, msg);
    else broadcastAll(msg);
  }

  // --- Message handler ---

  function handleNotificationMessage(ws, msg) {
    if (msg.type === "notification_dismiss") {
      dismiss(msg.ids || []);
      return true;
    }
    if (msg.type === "notification_dismiss_all") {
      dismissAll();
      return true;
    }
    if (prefsStore && msg.type === "notification_prefs_set") {
      prefsStore.set(userIdOf(ws), { preset: msg.preset, surfaces: msg.surfaces });
      sendPrefsToUser(userIdOf(ws));
      return true;
    }
    if (prefsStore && msg.type === "notification_prefs_migrate") {
      // First load after the preferences moved to the server: carry what this
      // browser held, once.
      var legacy = msg.legacy && typeof msg.legacy === "object" ? { sound: msg.legacy.sound !== false } : null;
      prefsStore.migrateLegacy(userIdOf(ws), legacy);
      sendPrefsToUser(userIdOf(ws));
      return true;
    }
    return false;
  }

  return {
    notify: notify,
    dismissByRequestId: dismissByRequestId,
    replaceReminder: replaceReminder,
    dismissReminder: dismissReminder,
    setReminderReconciler: setReminderReconciler,
    reconcileReminders: reconcileRemindersNow,
    getUnreadCount: getUnreadCount,
    sendConnectionState: sendConnectionState,
    handleNotificationMessage: handleNotificationMessage,
  };
}

module.exports = { attachNotifications: attachNotifications };

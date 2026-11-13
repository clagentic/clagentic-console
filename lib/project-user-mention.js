// project-user-mention.js - User-to-user @mention handling within a session.
//
// Mirrors the @mate mention pattern (see project-mate-interaction.js) but for
// human users. Each user_mention is a one-shot side-channel message that:
//   1. Is broadcast to all session viewers as a `user_mention` event
//   2. Is recorded in session.history so it survives reload/replay
//   3. Pushes a transcript line into session.pendingMentionContexts so the
//      coding agent sees the exchange on its next regular turn
//   4. Fires a notification + push for the targeted user
//
// Multi-target (`@a @b`) is intentionally NOT supported here -- callers send
// one user_mention per target. This keeps the wire protocol and progress
// tracking simple. Multi-target support can be layered on later.

var { notifyFor } = require("./notify");
var { DEFAULT_AVATAR_COLOR } = require("./default-avatar-color");

function attachUserMention(ctx) {
  var slug = ctx.slug || "";
  var sm = ctx.sm;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var sendToSession = ctx.sendToSession;
  var sendToSessionOthers = ctx.sendToSessionOthers;
  var getSessionForWs = ctx.getSessionForWs;
  var getLinuxUserForSession = ctx.getLinuxUserForSession;
  var saveImageFile = ctx.saveImageFile;
  var hydrateImageRefs = ctx.hydrateImageRefs;
  var usersModule = ctx.usersModule;
  var pushModule = ctx.pushModule || null;
  var isUserOnline = ctx.isUserOnline || function () { return false; };
  var getNotificationsModule = ctx.getNotificationsModule || function () { return null; };
  var getProjectTitle = ctx.getProjectTitle || function () { return slug; };

  function buildPreview(text) {
    var preview = (text || "").replace(/\s+/g, " ").trim();
    if (preview.length > 140) preview = preview.substring(0, 140) + "...";
    return preview;
  }

  function resolveSenderName(ws) {
    if (!ws._clagenticUser) return "Someone";
    var u = ws._clagenticUser;
    var p = u.profile || {};
    return p.name || u.displayName || u.username || "Someone";
  }

  function resolveSenderAvatar(ws) {
    if (!ws._clagenticUser) return null;
    var u = ws._clagenticUser;
    var p = u.profile || {};
    return {
      style: p.avatarStyle || "thumbs",
      seed: p.avatarSeed || u.username || u.id,
      color: p.avatarColor || DEFAULT_AVATAR_COLOR,
      custom: p.avatarCustom || "",
    };
  }

  function resolveTargetUser(targetUserId) {
    if (!targetUserId || !usersModule || typeof usersModule.findUserById !== "function") return null;
    var u = usersModule.findUserById(targetUserId);
    if (!u) return null;
    var p = u.profile || {};
    return {
      id: u.id,
      name: p.name || u.displayName || u.username || "User",
      username: u.username,
      avatarStyle: p.avatarStyle || "thumbs",
      avatarSeed: p.avatarSeed || u.username,
      avatarColor: p.avatarColor || DEFAULT_AVATAR_COLOR,
    };
  }

  function handleUserMention(ws, msg) {
    if (!msg.targetUserId) {
      sendTo(ws, { type: "user_mention_error", error: "Missing targetUserId" });
      return;
    }
    if (!msg.text && (!msg.images || msg.images.length === 0) && (!msg.pastes || msg.pastes.length === 0)) {
      return;
    }
    var session = getSessionForWs(ws);
    if (!session) return;

    if (!ws._clagenticUser) {
      sendTo(ws, { type: "user_mention_error", error: "You must be signed in to mention another user." });
      return;
    }
    if (ws._clagenticUser.id === msg.targetUserId) {
      sendTo(ws, { type: "user_mention_error", error: "You cannot mention yourself." });
      return;
    }

    var target = resolveTargetUser(msg.targetUserId);
    if (!target) {
      sendTo(ws, { type: "user_mention_error", error: "Target user not found." });
      return;
    }

    var fromId = ws._clagenticUser.id;
    var fromName = resolveSenderName(ws);
    var fromAvatar = resolveSenderAvatar(ws) || {};

    // Save images to disk (same pattern as regular and mate-mention messages)
    var imageRefs = [];
    if (msg.images && msg.images.length > 0) {
      for (var i = 0; i < msg.images.length; i++) {
        var img = msg.images[i];
        var savedName = saveImageFile(img.mediaType, img.data, getLinuxUserForSession(session));
        if (savedName) {
          imageRefs.push({ mediaType: img.mediaType, file: savedName });
        }
      }
    }

    var entry = {
      type: "user_mention",
      from: fromId,
      fromName: fromName,
      targetUserId: target.id,
      targetName: target.name,
      targetUsername: target.username,
      targetAvatarStyle: target.avatarStyle,
      targetAvatarSeed: target.avatarSeed,
      targetAvatarColor: target.avatarColor,
      text: msg.text || "",
      _ts: Date.now(),
    };
    if (msg.pastes && msg.pastes.length > 0) entry.pastes = msg.pastes;
    if (imageRefs.length > 0) entry.imageRefs = imageRefs;

    // lr-2ea2a7: routes through the shared history-cap helper (see grep-guard test).
    sm.recordHistoryEntry(session, entry, true);
    sm.appendToSessionFile(session, entry);

    // Hydrate image refs for live broadcast (clients want urls, not file names).
    // Use sendToSessionOthers so the sender's tab renders the message locally
    // (via input.js) without duplicating it from the WS echo.
    var live = hydrateImageRefs ? hydrateImageRefs(entry) : entry;
    sendToSessionOthers(ws, session.localId, live);

    // Queue side-channel transcript for the coding agent's next turn so the
    // agent sees what the humans discussed. Mirrors how mate mentions inject.
    if (!session.pendingMentionContexts) session.pendingMentionContexts = [];
    session.pendingMentionContexts.push(
      "[Context: @" + fromName + " mentioned @" + target.name + " in a side conversation]\n" +
      fromName + " to @" + target.name + ": " + (msg.text || "") + "\n" +
      "[End of @mention context. This is for your reference only. Do not respond to it directly.]"
    );

    // One notify() for the mentioned user: the banner and the push go to them
    // alone and land on this project's session. The push is skipped while they
    // are online in the app (the banner already reaches them), which the core
    // decides from the presence reader.
    var preview = buildPreview(msg.text);
    try {
      notifyFor(pushModule, getNotificationsModule()).notify("user_mention", {
        slug: slug,
        sessionId: session.localId,
      }, {
        push: { title: "@" + fromName + " mentioned you", body: preview || "Tap to open the session" },
        banner: {
          fromUserId: fromId,
          fromName: fromName,
          fromAvatarStyle: fromAvatar.style || null,
          fromAvatarSeed: fromAvatar.seed || null,
          fromAvatarColor: fromAvatar.color || null,
          fromAvatarCustom: fromAvatar.custom || "",
          preview: preview || "Mentioned you",
        },
      }, { ownerId: target.id, isOnline: isUserOnline });
    } catch (e) {
      console.error("[user-mention] notification failed:", e && e.message ? e.message : e);
    }
  }

  return {
    handleUserMention: handleUserMention,
  };
}

module.exports = { attachUserMention: attachUserMention };

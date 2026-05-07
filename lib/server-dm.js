function attachDm(ctx) {
  var users = ctx.users;
  var dm = ctx.dm;
  var projects = ctx.projects;
  var pushModule = ctx.pushModule;

  function handleMessage(ws, msg) {
    var userId;
    if (users.isMultiUser()) {
      if (!ws._clayUser) return false;
      userId = ws._clayUser.id;
    } else {
      userId = "default";
    }

    if (msg.type === "dm_list") {
      var dmList = dm.getDmList(userId);
      // Enrich with user info
      for (var i = 0; i < dmList.length; i++) {
        var otherUser = users.findUserById(dmList[i].otherUserId);
        if (otherUser) {
          var p = otherUser.profile || {};
          dmList[i].otherUser = {
            id: otherUser.id,
            displayName: p.name || otherUser.displayName || otherUser.username,
            username: otherUser.username,
            avatarStyle: p.avatarStyle || "thumbs",
            avatarSeed: p.avatarSeed || otherUser.username,
            avatarColor: p.avatarColor || "#7c3aed",
            avatarCustom: p.avatarCustom || "",
          };
        }
      }
      ws.send(JSON.stringify({ type: "dm_list", dms: dmList, mates: [] }));
      return true;
    }

    if (msg.type === "dm_open") {
      if (!msg.targetUserId) return true;

      var result = dm.openDm(userId, msg.targetUserId);
      var targetUser = users.findUserById(msg.targetUserId);
      var tp = targetUser ? (targetUser.profile || {}) : {};
      ws.send(JSON.stringify({
        type: "dm_history",
        dmKey: result.dmKey,
        messages: result.messages,
        targetUser: targetUser ? {
          id: targetUser.id,
          displayName: tp.name || targetUser.displayName || targetUser.username,
          username: targetUser.username,
          avatarStyle: tp.avatarStyle || "thumbs",
          avatarSeed: tp.avatarSeed || targetUser.username,
          avatarColor: tp.avatarColor || "#7c3aed",
          avatarCustom: tp.avatarCustom || "",
        } : null,
      }));
      return true;
    }

    if (msg.type === "dm_typing") {
      // Relay typing indicator to DM partner
      var dmKey = msg.dmKey;
      if (!dmKey) return true;
      var parts = dmKey.split(":");
      if (parts.indexOf(userId) === -1) return true;
      var targetId = parts[0] === userId ? parts[1] : parts[0];
      projects.forEach(function (ctx) {
        ctx.forEachClient(function (otherWs) {
          if (otherWs === ws) return;
          if (!otherWs._clayUser || otherWs._clayUser.id !== targetId) return;
          if (otherWs.readyState !== 1) return;
          otherWs.send(JSON.stringify({ type: "dm_typing", dmKey: dmKey, userId: userId, typing: !!msg.typing }));
        });
      });
      return true;
    }

    if (msg.type === "dm_send") {
      if (!msg.dmKey || !msg.text) return true;
      var parts = msg.dmKey.split(":");

      // Verify sender is a participant
      if (parts.indexOf(userId) === -1) return true;
      var message = dm.sendMessage(msg.dmKey, userId, msg.text);
      // Send confirmation to sender
      ws.send(JSON.stringify({ type: "dm_message", dmKey: msg.dmKey, message: message }));
      // Broadcast to target user's connections across all projects
      var targetId = parts[0] === userId ? parts[1] : parts[0];
      projects.forEach(function (ctx) {
        ctx.forEachClient(function (otherWs) {
          if (otherWs === ws) return;
          if (!otherWs._clayUser || otherWs._clayUser.id !== targetId) return;
          if (otherWs.readyState !== 1) return;
          otherWs.send(JSON.stringify({ type: "dm_message", dmKey: msg.dmKey, message: message }));
        });
      });
      // Send push notification to target user
      var senderName = ws._clayUser ? (ws._clayUser.displayName || ws._clayUser.username || "Someone") : "Someone";
      var preview = (msg.text || "").substring(0, 140);
      if (pushModule && pushModule.sendPushToUser) {
        pushModule.sendPushToUser(targetId, {
          type: "dm",
          title: senderName,
          body: preview,
          tag: "dm-" + msg.dmKey,
          dmKey: msg.dmKey,
        });
      }
      // Create in-app notification via any project's notifications module
      var _nmCtx = null;
      projects.forEach(function (pCtx) { if (!_nmCtx && pCtx.getNotificationsModule) _nmCtx = pCtx; });
      if (_nmCtx) {
        var _nm = _nmCtx.getNotificationsModule();
        if (_nm) {
          _nm.notify("mate_dm", {
            senderName: senderName,
            preview: preview,
            mateId: userId,
          });
        }
      }
      return true;
    }

    if (msg.type === "dm_add_favorite") {
      if (!msg.targetUserId) return true;
      users.removeDmHidden(userId, msg.targetUserId);
      var updatedFavorites = users.addDmFavorite(userId, msg.targetUserId);
      var allUsersList = users.getAllUsers().map(function (u) {
        var p = u.profile || {};
        return {
          id: u.id,
          displayName: p.name || u.displayName || u.username,
          username: u.username,
          role: u.role,
          avatarStyle: p.avatarStyle || "thumbs",
          avatarSeed: p.avatarSeed || u.username,
          avatarColor: p.avatarColor || "#7c3aed",
          avatarCustom: p.avatarCustom || "",
        };
      });
      ws.send(JSON.stringify({
        type: "dm_favorites_updated",
        dmFavorites: updatedFavorites,
        allUsers: allUsersList,
      }));
      return true;
    }

    if (msg.type === "dm_remove_favorite") {
      if (!msg.targetUserId) return true;
      users.addDmHidden(userId, msg.targetUserId);
      var updatedFavorites = users.removeDmFavorite(userId, msg.targetUserId);
      ws.send(JSON.stringify({
        type: "dm_favorites_updated",
        dmFavorites: updatedFavorites,
      }));
      return true;
    }

    return false;
  }

  return {
    handleMessage: handleMessage,
  };
}

module.exports = { attachDm: attachDm };

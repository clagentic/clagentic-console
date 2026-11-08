// The service worker's notification logic, factored out of sw.js so it runs
// under test with fake browser objects. A classic script (importScripts in the
// worker, require in node); it needs notify-target.js loaded first.
//
// env: { registration, clients, userAgent, scope, setTimeout }
(function (root, factory) {
  var target = typeof module === "object" && module.exports ? require("./notify-target.js") : root.NotifyTarget;
  var api = factory(target);
  // Always published on the global too: a module-graph import in a CommonJS
  // host (the tests) evaluates this file as CJS and reads it from there.
  root.NotifySw = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis, function (NotifyTarget) {
  var RESOLVED_LINGER_MS = 4000;

  function isCore(data) {
    return !!data && data.core === 1;
  }

  // iOS and desktop Safari revoke a push subscription whose pushes do not each
  // show a notification, so a close there is a visible replacement. Other
  // browsers allow a push that closes a notification and shows nothing.
  function requiresVisible(userAgent) {
    var ua = userAgent || "";
    if (/iPhone|iPad|iPod/.test(ua)) return true;
    return /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Android|Edg\//.test(ua);
  }

  /** The options a core notification is shown with: all from the payload. */
  function optionsFor(data) {
    return {
      body: data.body || "",
      tag: data.tag,
      data: data,
      requireInteraction: data.requireInteraction === true,
      renotify: data.renotify === true,
    };
  }

  function showCore(env, data) {
    return env.registration.showNotification(data.title || "Clagentic: Console", optionsFor(data));
  }

  var markerSeq = 0;

  function isPlaceholder(n) {
    return !!n && !!n.data && n.data.resolved === true;
  }

  // Shows the silent notice under a tag and closes it after `lingerMs` (at
  // once for 0). The notice carries a marker unique to this close, and only a
  // notification carrying that marker is closed afterwards: a newer live
  // notification that took the tag in the meantime is left alone.
  function showPlaceholder(env, data, tag, lingerMs) {
    var marker = tag + "#" + Date.now() + "#" + (++markerSeq);
    var wait = env.setTimeout || setTimeout;
    function closeMine() {
      return env.registration.getNotifications({ tag: tag }).then(function (left) {
        left.forEach(function (n) {
          if (n.data && n.data.resolvedMarker === marker) n.close();
        });
      });
    }
    return env.registration.showNotification(data.title || "Clagentic: Console", {
      body: data.body || "",
      tag: tag,
      silent: true,
      requireInteraction: false,
      renotify: false,
      data: { resolved: true, resolvedMarker: marker },
    }).then(function () {
      if (lingerMs <= 0) return closeMine();
      return new Promise(function (done) {
        wait(function () { closeMine().then(done, done); }, lingerMs);
      });
    });
  }

  // Closes the shown notification under each tag. Where a push must show
  // something (requiresVisible), the shown one is replaced under the same tag
  // by a silent, non-interactive notice that closes itself shortly after. When
  // nothing was shown under any tag (the person already dismissed it), the
  // push still has to show something there, so a single silent notice is shown
  // and closed at once: the least visible thing such a platform allows.
  function closeByTags(env, data) {
    var tags = Array.isArray(data.tags) ? data.tags : [];
    var visible = requiresVisible(env.userAgent);
    return Promise.all(tags.map(function (tag) {
      return env.registration.getNotifications({ tag: tag }).then(function (shown) {
        return { tag: tag, shown: shown.filter(function (n) { return !isPlaceholder(n); }) };
      });
    })).then(function (found) {
      if (!visible) {
        found.forEach(function (f) { f.shown.forEach(function (n) { n.close(); }); });
        return;
      }
      var matched = found.filter(function (f) { return f.shown.length > 0; });
      if (matched.length === 0) {
        return tags.length ? showPlaceholder(env, data, tags[0], 0) : undefined;
      }
      return Promise.all(matched.map(function (f) {
        return showPlaceholder(env, data, f.tag, RESOLVED_LINGER_MS);
      }));
    });
  }

  // Whether the page's own record still lists the prompt a shown notification
  // names. Only the notifications whose payload says the page can verify them
  // (liveInState) are judged.
  //   notifications: the page's banner list (notifications_state).
  //   livePrompts: the server's list of prompts awaiting the operator, with
  //     the server time it was taken; a notification sent after that is not
  //     judged by it, as the prompt may have opened since.
  function isLive(data, notifications, livePrompts) {
    var t = NotifyTarget.makeTarget(data.target);
    if (!t) return true;
    var sessionKey = NotifyTarget.sessionKey(t);
    var banner = (notifications || []).some(function (n) {
      if (n && n.key && n.key === data.tag) return true;
      var meta = (n && n.meta) || {};
      if (data.collapse === "request" && t.requestId) {
        if (meta.requestId === t.requestId) return true;
        return Array.isArray(meta.requestIds) && meta.requestIds.indexOf(t.requestId) !== -1;
      }
      return meta.reminderKey === sessionKey;
    });
    if (banner) return true;
    if (data.collapse !== "request" || !t.requestId || !livePrompts) return false;
    if (typeof data.sentAt !== "number" || data.sentAt >= livePrompts.at) return true;
    return (livePrompts.items || []).some(function (p) {
      return String(p.sessionId) === t.sessionId &&
        (p.requestId === t.requestId || p.toolUseId === t.requestId);
    });
  }

  /**
   * The same live check for an in-app banner: the banner's notification, in the
   * shape isLive judges a shown push in. A banner the registry does not mark
   * liveInState is not judged and reads as live.
   * @param {object} notif a notification from notifications_state or
   *   notification_created.
   * @param {object[]} notifications the page's notifications_state list.
   * @param {?object} livePrompts the live-prompt record of the connection.
   */
  function isBannerLive(notif, notifications, livePrompts) {
    if (!notif || notif.liveInState !== true) return true;
    var meta = notif.meta || {};
    return isLive({
      target: { slug: notif.slug, sessionId: notif.sessionId, requestId: meta.requestId },
      collapse: notif.collapse,
      tag: notif.key,
      sentAt: notif.createdAt,
    }, notifications, livePrompts);
  }

  /**
   * Closes the shown core notifications whose prompt has ended. The backup for
   * a close push that never arrived. A page never judges another project's
   * notifications: only those whose target is the page's own project.
   * @param {object} registration
   * @param {object[]} notifications the page's notifications_state list.
   * @param {{slug: string, livePrompts: ?object}} scope the page's project
   *   slug, and the live-prompt record of its connection.
   * @returns {Promise<number>} how many were closed.
   */
  function reconcileShown(registration, notifications, scope) {
    var slug = scope && typeof scope.slug === "string" && scope.slug ? scope.slug : null;
    if (!slug) return Promise.resolve(0);
    var livePrompts = scope.livePrompts || null;
    return registration.getNotifications().then(function (shown) {
      var closed = 0;
      shown.forEach(function (n) {
        var data = n.data;
        if (!isCore(data) || data.liveInState !== true) return;
        if (!data.target || data.target.slug !== slug) return;
        if (isLive(data, notifications, livePrompts)) return;
        n.close();
        closed++;
      });
      return closed;
    });
  }

  /**
   * @param {object} env
   * @param {object} data the parsed push payload.
   * @returns {Promise<*>}
   */
  function handlePush(env, data) {
    if (!data || data.type === "test") return Promise.resolve();
    // Every sender goes through the notification core, so a payload without
    // its mark is one queued on a device before the upgrade: it is dropped.
    if (!isCore(data)) return Promise.resolve();
    if (data.type === "notify_close") return closeByTags(env, data);
    return showCore(env, data);
  }

  // Focus a window and hand it the target to route to; open one at the deep
  // link when none exists. A window already on the target's project is
  // preferred, so a tap does not move another project's window.
  function coreClick(env, data) {
    var t = NotifyTarget.makeTarget(data.target);
    var base = env.scope || "/";
    var url = NotifyTarget.urlForTarget(t, base);
    var prefix = t && t.slug ? base + "p/" + t.slug + "/" : null;
    return env.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      var pick = null;
      var i;
      if (prefix) {
        for (i = 0; i < list.length && !pick; i++) {
          if (list[i].url.indexOf(prefix) !== -1) pick = list[i];
        }
      }
      for (i = 0; i < list.length && !pick; i++) {
        if (list[i].visibilityState !== "hidden") pick = list[i];
      }
      if (!pick && list.length > 0) pick = list[0];
      if (!pick) return env.clients.openWindow(url);
      return Promise.resolve(pick.focus()).then(function () {
        // The type travels with the target: a system target names no place, and
        // the page's router looks the place up by type.
        var route = { type: "notify_route", target: t };
        if (isCore(data) && typeof data.type === "string") route.notifyType = data.type;
        pick.postMessage(route);
      });
    });
  }

  /**
   * @param {object} env
   * @param {object} notification the clicked notification (already closed by
   *   the caller).
   */
  function handleClick(env, notification) {
    var data = notification.data || {};
    if (data.resolved === true) return Promise.resolve();
    // A notification shown before the upgrade has no target: it opens the app.
    return coreClick(env, data);
  }

  return {
    handlePush: handlePush,
    handleClick: handleClick,
    reconcileShown: reconcileShown,
    isLive: isLive,
    isBannerLive: isBannerLive,
    requiresVisible: requiresVisible,
    RESOLVED_LINGER_MS: RESOLVED_LINGER_MS,
  };
});

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

  // Closes the shown notification under each tag. Where a push must show
  // something, the shown one is replaced under the same tag by a silent,
  // non-interactive notice that closes itself shortly after.
  function closeByTags(env, data) {
    var tags = Array.isArray(data.tags) ? data.tags : [];
    var visible = requiresVisible(env.userAgent);
    var wait = env.setTimeout || setTimeout;
    return Promise.all(tags.map(function (tag) {
      return env.registration.getNotifications({ tag: tag }).then(function (shown) {
        if (!visible) {
          shown.forEach(function (n) { n.close(); });
          return;
        }
        return env.registration.showNotification(data.title || "Clagentic: Console", {
          body: data.body || "",
          tag: tag,
          silent: true,
          requireInteraction: false,
          renotify: false,
          data: { resolved: true },
        }).then(function () {
          return new Promise(function (done) {
            wait(function () {
              env.registration.getNotifications({ tag: tag }).then(function (left) {
                left.forEach(function (n) { n.close(); });
                done();
              }, done);
            }, RESOLVED_LINGER_MS);
          });
        });
      });
    }));
  }

  // The notifications shown that name a prompt no longer in the page's
  // notifications_state. Only those whose payload says the page can verify
  // them (liveInState) are judged.
  function isLive(data, notifications) {
    var t = NotifyTarget.makeTarget(data.target);
    if (!t) return true;
    var sessionKey = NotifyTarget.sessionKey(t);
    return (notifications || []).some(function (n) {
      var meta = (n && n.meta) || {};
      if (data.collapse === "request" && t.requestId) {
        if (meta.requestId === t.requestId) return true;
        return Array.isArray(meta.requestIds) && meta.requestIds.indexOf(t.requestId) !== -1;
      }
      return meta.reminderKey === sessionKey;
    });
  }

  /**
   * Closes the shown core notifications whose prompt has ended. The backup for
   * a close push that never arrived.
   * @param {object} registration
   * @param {object[]} notifications the page's notifications_state list.
   * @returns {Promise<number>} how many were closed.
   */
  function reconcileShown(registration, notifications) {
    return registration.getNotifications().then(function (shown) {
      var closed = 0;
      shown.forEach(function (n) {
        var data = n.data;
        if (!isCore(data) || data.liveInState !== true) return;
        if (isLive(data, notifications)) return;
        n.close();
        closed++;
      });
      return closed;
    });
  }

  function isLegacyForeground(type) {
    return type !== "permission_request" && type !== "permission_reminder" && type !== "ask_user";
  }

  // The payloads emitters not yet on the core send, shown as they always were.
  function showLegacy(env, data) {
    var options = {
      body: data.body || "",
      tag: data.tag || "clagentic",
      data: data,
    };
    if (data.type === "permission_request") {
      options.requireInteraction = true;
      options.tag = "perm-" + data.requestId;
    } else if (data.type === "permission_reminder") {
      options.requireInteraction = true;
      options.tag = data.tag || "prompt-reminder";
      options.renotify = true;
    } else if (data.type === "done") {
      options.tag = data.tag || "claude-done";
    } else if (data.type === "ask_user") {
      options.requireInteraction = true;
      options.tag = "claude-ask";
    } else if (data.type === "dm") {
      options.tag = data.tag || "dm";
    }
    return env.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      if (isLegacyForeground(data.type)) {
        for (var i = 0; i < list.length; i++) {
          if (list[i].focused || list[i].visibilityState === "visible") return;
        }
      }
      return env.registration.showNotification(data.title || "Clagentic: Console", options);
    });
  }

  /**
   * @param {object} env
   * @param {object} data the parsed push payload.
   * @returns {Promise<*>}
   */
  function handlePush(env, data) {
    if (!data || data.type === "test") return Promise.resolve();
    if (isCore(data)) {
      if (data.type === "notify_close") return closeByTags(env, data);
      return showCore(env, data);
    }
    return showLegacy(env, data);
  }

  function legacyClick(env, data) {
    var baseUrl = env.scope || "/";
    var targetUrl = data.slug ? baseUrl + "p/" + data.slug + "/" : baseUrl;
    return env.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf(targetUrl) !== -1) return list[i].focus();
      }
      for (var j = 0; j < list.length; j++) {
        if (list[j].visibilityState !== "hidden") return list[j].focus();
      }
      if (list.length > 0) return list[0].focus();
      return env.clients.openWindow(targetUrl);
    });
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
        pick.postMessage({ type: "notify_route", target: t });
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
    return isCore(data) ? coreClick(env, data) : legacyClick(env, data);
  }

  return {
    handlePush: handlePush,
    handleClick: handleClick,
    reconcileShown: reconcileShown,
    requiresVisible: requiresVisible,
    RESOLVED_LINGER_MS: RESOLVED_LINGER_MS,
  };
});

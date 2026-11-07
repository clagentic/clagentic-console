var webpush = require("web-push");
var fs = require("fs");
var path = require("path");
var config = require("./config");
var store = require("./store");
var { categoryOfPush } = require("./notification-prefs");
var usersModule = require("./users");

// The daemon's mode; a mode that cannot be read counts as multi-user, the
// stricter one (same rule as lib/push-audience.js).
function multiUserMode(isMultiUser) {
  try {
    return isMultiUser() !== false;
  } catch (e) {
    return true;
  }
}

function loadOrCreateVapidKeys() {
  var dir = config.CONFIG_DIR;
  var keyFile = path.join(dir, "vapid.json");

  // Synchronous read at startup so initPush() can return keys immediately.
  try {
    var data = fs.readFileSync(keyFile, "utf8");
    return JSON.parse(data);
  } catch (e) {
    // Generate new keys and write via store.js (async, 0o600).
  }

  var keys = webpush.generateVAPIDKeys();
  store.writeJson("vapid.json", keys).catch(function (err) {
    process.stderr.write("[push] Failed to write vapid.json: " + (err && err.message ? err.message : err) + "\n");
  });
  return keys;
}

/**
 * @param {object} [opts]
 * @param {{allows: function(?string, string, ?string): boolean}} [opts.prefs]
 *   the per-user notification preferences (lib/notification-prefs.js). A push a
 *   user has muted is not sent to that user's subscriptions; this is the one
 *   place push is filtered, so a muted type never reaches the phone whichever
 *   caller raised it.
 * @param {function(): boolean} [opts.isMultiUser] the daemon's mode; defaults to
 *   the users store. In multi-user mode a subscription with no user is neither
 *   stored nor sent to: nobody can say whose device it is.
 */
function initPush(opts) {
  var prefs = opts && opts.prefs ? opts.prefs : null;
  var isMultiUser = opts && opts.isMultiUser ? opts.isMultiUser : usersModule.isMultiUser;

  var keys = loadOrCreateVapidKeys();

  var vapidDetails = {
    subject: "mailto:push@clagentic.dev",
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };

  var dir = config.CONFIG_DIR;
  var subFile = path.join(dir, "push-subs.json");
  var subscriptions = new Map();

  // Load persisted subscriptions synchronously at startup; writes go through store.js.
  try {
    var saved = JSON.parse(fs.readFileSync(subFile, "utf8"));
    if (saved.vapidKey && saved.vapidKey !== keys.publicKey) {
      saved.subs = [];
    }
    var subs = saved.subs || saved;
    if (Array.isArray(subs)) {
      for (var i = 0; i < subs.length; i++) {
        if (subs[i] && subs[i].endpoint) subscriptions.set(subs[i].endpoint, subs[i]);
      }
    }
  } catch (e) {}

  function save() {
    // Async atomic write through store.js (queued, 0o600). Fire-and-forget.
    store.writeJson("push-subs.json", {
      vapidKey: keys.publicKey,
      subs: Array.from(subscriptions.values()),
    }).catch(function (err) {
      process.stderr.write("[push] save failed: " + (err && err.message ? err.message : err) + "\n");
    });
  }

  save();

  // Purge stale subscriptions on startup
  var startupEndpoints = Array.from(subscriptions.keys());
  for (var si = 0; si < startupEndpoints.length; si++) {
    (function (ep) {
      var sub = subscriptions.get(ep);
      webpush.sendNotification(sub, JSON.stringify({ type: "test" }), { TTL: 0, vapidDetails: vapidDetails })
        .then(function () {})
        .catch(function (err) {
          if (err.statusCode === 403 || err.statusCode === 410 || err.statusCode === 404) {
            subscriptions.delete(ep);
            save();
          }
        });
    })(startupEndpoints[si]);
  }

  /**
   * @returns {boolean} false when the subscription was refused: it has no
   *   endpoint, or it has no user in multi-user mode.
   */
  function addSubscription(sub, replaceEndpoint, userId) {
    if (!sub || !sub.endpoint) return false;
    if (!userId && multiUserMode(isMultiUser)) {
      console.log("[push] refused anonymous subscription in multi-user mode");
      return false;
    }
    // Remove previous subscription from the same client if endpoint changed.
    // Only delete replaceEndpoint if it belongs to the same caller — prevents an
    // unauthenticated request from unsubscribing arbitrary known endpoints.
    if (replaceEndpoint && replaceEndpoint !== sub.endpoint) {
      var existing = subscriptions.get(replaceEndpoint);
      // In multi-user mode (userId set), require ownership match.
      // In single-user / anonymous mode (userId null), allow the replacement
      // only if the stored subscription is also anonymous (no _userId).
      var callerOwns = userId
        ? (existing && existing._userId === userId)
        : (existing && !existing._userId);
      if (callerOwns) {
        subscriptions.delete(replaceEndpoint);
      }
    }
    // Attach userId for per-user targeting. An authenticated re-register of an
    // endpoint stored without a user claims it, so a device subscribed before
    // the user was recorded recovers when its client re-sends the subscription.
    if (userId) {
      var stored = subscriptions.get(sub.endpoint);
      if (stored && !stored._userId) console.log("[push] claimed anonymous subscription user=" + userId);
      sub._userId = userId;
    }
    // Store immediately, then validate async. Invalid subs get cleaned on first sendPush.
    subscriptions.set(sub.endpoint, sub);
    save();
    // Validate with a silent push (TTL 0 = don't actually deliver if device offline)
    webpush.sendNotification(sub, JSON.stringify({ type: "test" }), { TTL: 0, vapidDetails: vapidDetails })
      .then(function () {})
      .catch(function (err) {
        if (err.statusCode === 403 || err.statusCode === 410 || err.statusCode === 404) {
          subscriptions.delete(sub.endpoint);
          save();
        }
      });
  }

  function removeSubscription(endpoint) {
    subscriptions.delete(endpoint);
    save();
  }

  // One journal line per decision: identifiers and the type only, never the
  // title or body (they carry tool input and response text).
  function wanted(sub, payload) {
    var category = categoryOfPush(payload);
    var userId = sub._userId || null;
    var allowed = !prefs || prefs.allows(userId, "push", category);
    console.log("[push] " + (allowed ? "sending" : "muted") + " type=" + payload.type + " category=" + (category || "none") + " user=" + (userId || "default"));
    return allowed;
  }

  // Sends still on the wire, so a shutdown can wait for them (flush).
  var inflight = new Set();

  function sendTo(sub, endpoint, json) {
    var sent = webpush.sendNotification(sub, json, { vapidDetails: vapidDetails })
      .then(function () {})
      .catch(function (err) {
        if (err.statusCode === 410 || err.statusCode === 404 || err.statusCode === 403) {
          subscriptions.delete(endpoint);
          save();
        }
      })
      .then(function () { inflight.delete(sent); });
    inflight.add(sent);
  }

  /** Resolves once every push sent so far has been handed to the push service. */
  function flush() {
    return Promise.all(Array.from(inflight));
  }

  function sendPush(payload) {
    var json = JSON.stringify(payload);
    var multi = multiUserMode(isMultiUser);
    subscriptions.forEach(function (sub, endpoint) {
      // A subscription stored before users were recorded has no owner; in
      // multi-user mode a broadcast must not reach a device nobody can name.
      if (multi && !sub._userId) return;
      if (!wanted(sub, payload)) return;
      sendTo(sub, endpoint, json);
    });
  }

  function sendPushToUser(userId, payload) {
    if (!userId) return;
    var json = JSON.stringify(payload);
    var matched = 0;
    subscriptions.forEach(function (sub, endpoint) {
      if (sub._userId !== userId) return;
      matched++;
      if (!wanted(sub, payload)) return;
      sendTo(sub, endpoint, json);
    });
    if (!matched) console.log("[push] no-subscription user=" + userId + " type=" + payload.type);
  }

  return {
    publicKey: keys.publicKey,
    addSubscription: addSubscription,
    removeSubscription: removeSubscription,
    sendPush: sendPush,
    sendPushToUser: sendPushToUser,
    flush: flush,
  };
}

module.exports = { initPush };


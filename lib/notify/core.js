"use strict";

// The notification core: the one place that turns a target and a message into a
// push, collapses repeats, and closes a push when its prompt resolves.
// Emitters call notify() and resolve() and keep no tag, route or dedupe logic.
// A notification reaches the surfaces its type registers: push, and the in-app
// banner (lib/project-notifications.js is the banner store the core delivers
// to; it is not a second core).
//
// The core keeps no memory of what it showed. Every tag is derived from the
// type's collapse rule and the target alone (payload.tagFor), so resolve() can
// name the tags to close from the target it is given, in any process: a close
// still works after a daemon restart.

var target = require("./target");
var payloads = require("./payload");
var { pushForSession, audienceFor } = require("../push-audience");

/**
 * @param {object} deps
 * @param {object} deps.registry a type registry (type-registry.js).
 * @param {?object} deps.push the push module (sendPush, sendPushToUser).
 * @param {?{show: function, dismissKeys: function}} [deps.inApp] the in-app
 *   banner store: show(event, data, meta) creates a banner, replacing the one
 *   under the same meta.key; dismissKeys(keys) removes the banners under them.
 */
function createNotifyCore(deps) {
  var registry = deps.registry;
  var push = deps.push || null;
  var inApp = deps.inApp || null;

  function audienceOf(audience) {
    return {
      ownerId: audience && audience.ownerId || null,
      isMultiUser: audience && audience.isMultiUser,
      listAdmins: audience && audience.listAdmins,
    };
  }

  function perSurface(content) {
    var c = content || {};
    if (c.push || c.banner) return { push: c.push || null, banner: c.banner || null };
    return { push: c, banner: null };
  }

  function deliver(audience, payload) {
    return pushForSession(push, audience.ownerId, payload, audience.isMultiUser, audience.listAdmins);
  }

  // The banner follows the push audience: the owner, or the admins for an
  // ownerless session in multi-user mode, so no one else reads its title.
  function bannerData(type, norm, raw, audience, data) {
    var aud = audienceFor(audience.ownerId, audience.isMultiUser, audience.listAdmins);
    // The audience and the target are applied last: emitter content cannot
    // widen or redirect who reads the banner, or where it points.
    return Object.assign({}, data, {
      ownerId: audience.ownerId,
      targetUserId: aud.kind === "owner" ? aud.userIds[0] : null,
      targetUserIds: aud.kind === "admins" ? aud.userIds : null,
      slug: norm.slug,
      sessionId: raw.sessionId,
      requestId: norm.requestId,
    });
  }

  /**
   * Shows (or replaces) the notification for a target, on every surface the
   * type registers.
   * @param {string} typeName a registered type.
   * @param {{slug: ?string, sessionId: ?(number|string), requestId: ?string}} t
   * @param {{push: ?object, banner: ?object}|object} content what each surface
   *   shows. push: the push text ({title, body}, or what the type's format
   *   reads); banner: the in-app store's own content (the target and audience
   *   fields are added here). A surface without content is not delivered to;
   *   the core picks the surfaces from the type's registration, never the
   *   emitter. A content naming neither key is the push content itself.
   * @param {{ownerId: ?string, isMultiUser: ?function, listAdmins: ?function}} [audience]
   *   who the session belongs to; the push audience rules (lib/push-audience.js)
   *   decide the recipients from it, for the push and the banner alike. The
   *   mode and admin readers are optional.
   * @returns {?object} the payload built, or null when nothing was delivered.
   */
  function notify(typeName, t, content, audience) {
    var type = registry.get(typeName);
    if (!type) throw new Error("unregistered notification type: " + typeName);
    var norm = target.makeTarget(t);
    if (!norm) throw new Error("invalid notification target for " + typeName);
    if (type.collapse === "request" && !norm.requestId) {
      throw new Error("notification type " + typeName + " needs a requestId");
    }
    var bySurface = perSurface(content);
    var aud = audienceOf(audience);
    var payload = payloads.buildPayload(type, norm, bySurface.push || bySurface.banner);
    var delivered = false;
    if (push && bySurface.push) {
      deliver(aud, payload);
      delivered = true;
    }
    if (inApp && type.banner && bySurface.banner) {
      inApp.show(typeName, bannerData(type, norm, t, aud, bySurface.banner), {
        key: payload.tag,
        collapse: type.collapse,
        persistent: type.persistent,
        liveInState: type.liveInState,
      });
      delivered = true;
    }
    return delivered ? payload : null;
  }

  // The close-on-resolve types the targets' resolve reaches, grouped by
  // notification category: a close push follows the preference of the
  // notification it closes, and types of one category share a preference, so
  // one push per category carries all its tags.
  function closeGroups(norms) {
    var groups = Object.create(null);
    var order = [];
    var bannerKeys = [];
    norms.forEach(function (norm) {
      registry.names().forEach(function (name) {
        var type = registry.get(name);
        if (!type.closeOnResolve) return;
        // With a request named, that prompt's request-level notifications;
        // without one, the session-level ones.
        if ((type.collapse === "request") !== !!norm.requestId) return;
        var key = type.category || name;
        if (!groups[key]) {
          groups[key] = { type: type, tags: [] };
          order.push(key);
        }
        var tag = payloads.tagFor(type, norm);
        if (groups[key].tags.indexOf(tag) === -1) groups[key].tags.push(tag);
        if (type.banner && bannerKeys.indexOf(tag) === -1) bannerKeys.push(tag);
      });
    });
    return { groups: order.map(function (key) { return groups[key]; }), bannerKeys: bannerKeys };
  }

  /**
   * Closes what is shown for a target, on every surface and every device in
   * its audience: the push on each device, and the banner in every page.
   * @param {object|object[]} what a target { slug, sessionId, requestId }, or a
   *   list of them (a prompt known by more than one id). With a requestId it
   *   closes that prompt's request-level notifications; without one (a session
   *   whose prompts all settled) it closes the session-level ones. A target
   *   without a session id closes no push (a request-only target retires the
   *   banners of that request).
   * @param {{ownerId: ?string, isMultiUser: ?function, listAdmins: ?function}} [audience]
   *   the same audience the notification was sent to.
   * @returns {number} how many close pushes were sent.
   */
  function resolve(what, audience) {
    var all = [].concat(what).map(target.makeTarget).filter(Boolean);
    var norms = all.filter(function (n) { return n.sessionId; });
    var closing = closeGroups(norms);
    if (inApp && closing.bannerKeys.length) inApp.dismissKeys(closing.bannerKeys);
    // An answer that arrives for a prompt no session claims (a stale one) names
    // only its request: the banners of that request are retired, in its project.
    if (inApp && typeof inApp.dismissRequest === "function") {
      all.filter(function (n) { return !n.sessionId && n.requestId; }).forEach(function (n) {
        inApp.dismissRequest(n.slug, n.requestId);
      });
    }
    if (!push) return 0;
    var aud = audienceOf(audience);
    closing.groups.forEach(function (g) {
      deliver(aud, payloads.buildClose(g.type, g.tags));
    });
    return closing.groups.length;
  }

  return { notify: notify, resolve: resolve };
}

module.exports = { createNotifyCore: createNotifyCore };

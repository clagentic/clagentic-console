"use strict";

// The notification core: the one place that turns a target and a message into a
// push, collapses repeats, and closes a push when its prompt resolves.
// Emitters call notify() and resolve() and keep no tag, route or dedupe logic.
//
// The core remembers what it showed (tag -> type, target, audience) so
// resolve() can reach the right devices later, including from a path that only
// knows the request id. The memory is process-local: after a restart a
// notification already on a device is closed by the page's reconcile
// (lib/public/notify-sw-logic.js) instead.

var target = require("./target");
var payloads = require("./payload");
var { pushForSession } = require("../push-audience");

var MAX_LIVE = 2000;

/**
 * @param {object} deps
 * @param {object} deps.registry a type registry (type-registry.js).
 * @param {?object} deps.push the push module (sendPush, sendPushToUser).
 */
function createNotifyCore(deps) {
  var registry = deps.registry;
  var push = deps.push || null;
  // tag -> { type, target, ownerId }
  var live = new Map();

  function remember(tag, type, t, audience) {
    live.delete(tag);
    live.set(tag, { type: type, target: t, audience: audience });
    if (live.size > MAX_LIVE) live.delete(live.keys().next().value);
  }

  function deliver(audience, payload) {
    return pushForSession(push, audience.ownerId || null, payload, audience.isMultiUser, audience.listAdmins);
  }

  /**
   * Shows (or replaces) the notification for a target.
   * @param {string} typeName a registered type.
   * @param {{slug: ?string, sessionId: ?(number|string), requestId: ?string}} t
   * @param {{title: string, body: string}} content
   * @param {{ownerId: ?string, isMultiUser: ?function, listAdmins: ?function}} [audience]
   *   who the session belongs to; the push audience rules (lib/push-audience.js)
   *   decide the recipients from it. The mode and admin readers are optional.
   * @returns {?object} the payload sent, or null when nothing was.
   */
  function notify(typeName, t, content, audience) {
    var type = registry.get(typeName);
    if (!type) throw new Error("unregistered notification type: " + typeName);
    var norm = target.makeTarget(t);
    if (!norm) throw new Error("invalid notification target for " + typeName);
    if (type.collapse === "request" && !norm.requestId) {
      throw new Error("notification type " + typeName + " needs a requestId");
    }
    var aud = {
      ownerId: audience && audience.ownerId || null,
      isMultiUser: audience && audience.isMultiUser,
      listAdmins: audience && audience.listAdmins,
    };
    var payload = payloads.buildPayload(type, norm, content);
    remember(payload.tag, type, norm, aud);
    if (!push) return null;
    deliver(aud, payload);
    return payload;
  }

  function matches(entry, filter) {
    if (!entry.type.closeOnResolve) return false;
    var et = entry.target;
    if (filter.slug && et.slug !== filter.slug) return false;
    if (filter.sessionId && et.sessionId !== filter.sessionId) return false;
    if (filter.requestId) return entry.type.collapse === "request" && et.requestId === filter.requestId;
    // No request named: the session-level notifications of that session.
    return entry.type.collapse === "session";
  }

  /**
   * Closes what was shown for a target, on every device that was sent it.
   * @param {string|object} what a request id, or { slug, sessionId, requestId }.
   *   With a requestId it closes that prompt's request-level notifications;
   *   without one (a session whose prompts all settled) it closes the
   *   session-level ones.
   * @returns {number} how many close pushes were sent.
   */
  function resolve(what) {
    var filter = typeof what === "string"
      ? { requestId: what }
      : (target.makeTarget(what) || {});
    if (!filter.requestId && !filter.sessionId) return 0;
    var sent = 0;
    Array.from(live.keys()).forEach(function (tag) {
      var entry = live.get(tag);
      if (!matches(entry, filter)) return;
      live.delete(tag);
      if (push) {
        deliver(entry.audience, payloads.buildClose(entry.type, tag));
        sent++;
      }
    });
    return sent;
  }

  return { notify: notify, resolve: resolve, liveCount: function () { return live.size; } };
}

module.exports = { createNotifyCore: createNotifyCore };

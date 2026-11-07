"use strict";

// The notification core: the one place that turns a target and a message into a
// push, collapses repeats, and closes a push when its prompt resolves.
// Emitters call notify() and resolve() and keep no tag, route or dedupe logic.
//
// The core keeps no memory of what it showed. Every tag is derived from the
// type's collapse rule and the target alone (payload.tagFor), so resolve() can
// name the tags to close from the target it is given, in any process: a close
// still works after a daemon restart.

var target = require("./target");
var payloads = require("./payload");
var { pushForSession } = require("../push-audience");

/**
 * @param {object} deps
 * @param {object} deps.registry a type registry (type-registry.js).
 * @param {?object} deps.push the push module (sendPush, sendPushToUser).
 */
function createNotifyCore(deps) {
  var registry = deps.registry;
  var push = deps.push || null;

  function audienceOf(audience) {
    return {
      ownerId: audience && audience.ownerId || null,
      isMultiUser: audience && audience.isMultiUser,
      listAdmins: audience && audience.listAdmins,
    };
  }

  function deliver(audience, payload) {
    return pushForSession(push, audience.ownerId, payload, audience.isMultiUser, audience.listAdmins);
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
    if (!push) return null;
    var payload = payloads.buildPayload(type, norm, content);
    deliver(audienceOf(audience), payload);
    return payload;
  }

  // The close-on-resolve types the targets' resolve reaches, grouped by
  // notification category: a close push follows the preference of the
  // notification it closes, and types of one category share a preference, so
  // one push per category carries all its tags.
  function closeGroups(norms) {
    var groups = Object.create(null);
    var order = [];
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
      });
    });
    return order.map(function (key) { return groups[key]; });
  }

  /**
   * Closes what is shown for a target, on every device in its audience.
   * @param {object|object[]} what a target { slug, sessionId, requestId }, or a
   *   list of them (a prompt known by more than one id). With a requestId it
   *   closes that prompt's request-level notifications; without one (a session
   *   whose prompts all settled) it closes the session-level ones. A target
   *   without a session id names nothing.
   * @param {{ownerId: ?string, isMultiUser: ?function, listAdmins: ?function}} [audience]
   *   the same audience the notification was sent to.
   * @returns {number} how many close pushes were sent.
   */
  function resolve(what, audience) {
    if (!push) return 0;
    var norms = [].concat(what).map(target.makeTarget).filter(function (n) {
      return n && n.sessionId;
    });
    var aud = audienceOf(audience);
    var groups = closeGroups(norms);
    groups.forEach(function (g) {
      deliver(aud, payloads.buildClose(g.type, g.tags));
    });
    return groups.length;
  }

  return { notify: notify, resolve: resolve };
}

module.exports = { createNotifyCore: createNotifyCore };

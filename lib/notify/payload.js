"use strict";

// Builds the wire payloads. The tag is derived here and nowhere else: from the
// type's collapse rule and the target key, so two notifications for the same
// target share a tag (the platform replaces, never stacks) and different
// targets never do.

var target = require("./target");

// Marks a payload the generic service worker handles from its own fields. A
// payload without it is a legacy one, shown as before.
var CORE_MARK = 1;
var CLOSE_TYPE = "notify_close";

function tagFor(type, t) {
  var key = type.collapse === "request" ? target.targetKey(t) : target.sessionKey(t);
  return "n:" + type.name + ":" + key;
}

/**
 * @param {object} type a registered type.
 * @param {object} t a normalised target.
 * @param {{title: string, body: string}} content
 */
function buildPayload(type, t, content) {
  var text = type.format(content || {});
  return {
    core: CORE_MARK,
    type: type.name,
    title: text.title,
    body: text.body,
    target: t,
    tag: tagFor(type, t),
    collapse: type.collapse,
    url: target.urlForTarget(t),
    requireInteraction: type.persistent,
    renotify: type.renotify,
    liveInState: type.liveInState,
    // Server time of the send: the page's reconcile only judges a notification
    // sent before the state snapshot it checks against.
    sentAt: Date.now(),
  };
}

/**
 * The push that closes a shown notification. It names the type it closes so
 * the push filter applies that type's preference: a device never told of the
 * notification is not told of its closing.
 * @param {object} type a type of the category being closed.
 * @param {string|string[]} tags the tag or tags to close.
 */
function buildClose(type, tags) {
  return {
    core: CORE_MARK,
    type: CLOSE_TYPE,
    closes: type.name,
    tags: [].concat(tags),
    title: "Clagentic: Console",
    body: "No longer waiting for input",
  };
}

module.exports = { tagFor: tagFor, buildPayload: buildPayload, buildClose: buildClose, CLOSE_TYPE: CLOSE_TYPE };

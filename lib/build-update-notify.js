"use strict";

// Raises and withdraws the build-update offer through the notification core.
// The offer is one notification for the console itself (no project, no
// session): the core collapses every repeat (the standing reconcile, a
// broadcast, a re-emit) into the one shown on each surface, and resolve closes
// it on the phone and in every open page.

var { notifyFor } = require("./notify");

var TYPE = "build_update_offer";
var CONSOLE_TARGET = { slug: null, sessionId: null };

/**
 * @param {object} message the composed offer (build-update-offer.composeNotice).
 */
function offerContent(message) {
  return { title: "A newer build is installed", body: message.message };
}

/**
 * @param {{push: ?object, inApp: ?object, isMultiUser: ?function, listAdmins: ?function}} env
 * @param {object} message the composed offer.
 */
function showBuildOffer(env, message) {
  var text = offerContent(message);
  return notifyFor(env.push, env.inApp).notify(TYPE, CONSOLE_TARGET, {
    push: text,
    banner: Object.assign({}, text, {
      message: message.message,
      buildUpdate: message.buildUpdate,
      actionable: message.actionable,
    }),
  }, { isMultiUser: env.isMultiUser, listAdmins: env.listAdmins });
}

/** The build was adopted or the offer declined: close it everywhere. */
function resolveBuildOffer(env) {
  return notifyFor(env.push, env.inApp).resolve(CONSOLE_TARGET, {
    isMultiUser: env.isMultiUser,
    listAdmins: env.listAdmins,
  }, { type: TYPE });
}

module.exports = { showBuildOffer: showBuildOffer, resolveBuildOffer: resolveBuildOffer, TYPE: TYPE };

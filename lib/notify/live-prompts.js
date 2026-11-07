"use strict";

// The record the page checks a shown prompt notification against: which
// prompts of a project await the operator right now, as seen by one viewer.
// Ids only, never prompt content. It is what makes every persistent
// close-on-resolve type verifiable on the page, including those with no banner
// (ask_user, elicitation).

var { audienceFor } = require("../push-audience");

/**
 * @param {object} deps
 * @param {string} deps.slug the project the sessions belong to.
 * @param {{forEach: function}} deps.sessions the project's sessions.
 * @param {{pendingInfo: function}} deps.prompts the project's prompt registry.
 * @param {?string} deps.viewerId the connecting user, if any.
 * @param {function(): boolean} [deps.isMultiUser] see push-audience.audienceFor.
 * @param {function(): string[]} [deps.listAdmins] see push-audience.audienceFor.
 * @returns {{slug: string, at: number, items: Array<{sessionId: string, requestId: string, toolUseId: ?string}>}}
 *   at is the server time of the snapshot: a notification sent after it is not
 *   judged by it.
 */
function snapshotLivePrompts(deps) {
  var items = [];
  deps.sessions.forEach(function (session) {
    // Only prompts the viewer would have been pushed.
    var audience = audienceFor(session.ownerId || null, deps.isMultiUser, deps.listAdmins);
    if (audience.kind !== "broadcast" && audience.userIds.indexOf(deps.viewerId) === -1) return;
    deps.prompts.pendingInfo(session).forEach(function (info) {
      items.push({ sessionId: String(session.localId), requestId: info.requestId, toolUseId: info.toolUseId || null });
    });
  });
  return { slug: deps.slug, at: Date.now(), items: items };
}

module.exports = { snapshotLivePrompts: snapshotLivePrompts };

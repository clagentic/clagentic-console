// permission-choices.js - which answers a tool-permission ask offers, and in
// what order. The card (permission.js) and the notification banner
// (../prompt-banner.js) both read it, so they cannot offer different answers
// to one ask.
//
// The Claude Agent SDK may attach presentation hints to an ask:
//   defaultToNo   the ask opens on its decline choice, so a stray keystroke or
//                 tap cannot approve it.
// Whether "allow for session" is offered is not decided here: the server
// applies the one offer rule (sessionGrantCanAnswer in lib/grant-keys.js) and
// sends noSessionGrant when no grant can answer the ask. The server also
// refuses or downgrades an Allow-for-session answer whatever a client sends
// (lib/prompt-kinds/permission.js); omitting the choice here is the
// presentation of that rule, not its enforcement.
//
// Deliberately free of imports so the banner can load it without the rest of
// the frontend module graph.

/**
 * @param {object} [hints] - the ask's request fields.
 * @returns {string[]} decisions in the order they are shown; the first is the
 *   default choice when the ask is defaultToNo.
 */
export function permissionChoices(hints) {
  var h = hints || {};
  // suppressAlwaysAllowRule is read too: a request recorded before noSessionGrant
  // existed carries only that hint, and a replay must not offer the choice.
  var withheld = h.noSessionGrant === true || h.suppressAlwaysAllowRule === true;
  var approve = withheld ? ["allow"] : ["allow", "allow_always"];
  return h.defaultToNo === true ? ["deny"].concat(approve) : approve.concat(["deny"]);
}

/** Whether an ask must open on its decline choice. */
export function opensOnNo(hints) {
  return !!hints && hints.defaultToNo === true;
}

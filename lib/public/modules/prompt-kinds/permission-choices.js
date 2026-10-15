// permission-choices.js - which answers a tool-permission ask offers, and in
// what order. The card (permission.js) and the notification banner
// (../prompt-banner.js) both read it, so they cannot offer different answers
// to one ask.
//
// The Claude Agent SDK may attach presentation hints to an ask:
//   suppressAlwaysAllowRule  no persistent "allow for session" choice;
//   defaultToNo              the ask opens on its decline choice, so a stray
//                            keystroke or tap cannot approve it.
// The server refuses an Allow-for-session answer to a suppressed ask whatever
// a client sends (lib/prompt-kinds/permission.js); omitting the choice here is
// the presentation of that rule, not its enforcement.
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
  var approve = h.suppressAlwaysAllowRule === true ? ["allow"] : ["allow", "allow_always"];
  return h.defaultToNo === true ? ["deny"].concat(approve) : approve.concat(["deny"]);
}

/** Whether an ask must open on its decline choice. */
export function opensOnNo(hints) {
  return !!hints && hints.defaultToNo === true;
}

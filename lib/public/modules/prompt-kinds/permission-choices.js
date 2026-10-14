// permission-choices.js - which answers a tool-permission ask offers, and in
// what order. The card (permission.js) and the notification banner
// (../prompt-banner.js) both read it, so they cannot offer different answers
// to one ask.
//
// The Claude Agent SDK may attach presentation hints to an ask:
//   suppressAlwaysAllowRule  no persistent "allow for session" choice;
//   defaultToNo              the ask opens on its decline choice, so a stray
//                            keystroke or tap cannot approve it.
// A call that cannot be granted narrowly (grantScope null: a file tool, which
// never produces a session grant, or a command too long to keep) offers no
// Allow for session either; the server does not store one (a file tool's answer
// is allowed once, any other is refused).
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
  var noSession = h.suppressAlwaysAllowRule === true || h.grantScope === null;
  var approve = noSession ? ["allow"] : ["allow", "allow_always"];
  return h.defaultToNo === true ? ["deny"].concat(approve) : approve.concat(["deny"]);
}

/** Whether an ask must open on its decline choice. */
export function opensOnNo(hints) {
  return !!hints && hints.defaultToNo === true;
}

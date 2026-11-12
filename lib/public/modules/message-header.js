// message-header.js - the one header line every message in the transcript uses.
//
//   buildMessageHeader({ side, avatarEl, showAvatar, name, nameColor, showName,
//                        label, time, extras, control, actions, compact })
//
// Avatar, name, label, time and controls sit on a single line of
// --msg-header-height; nothing in a header is placed on a row by itself. The
// other-speaker side reads avatar, name, label, time, then the controls at the
// far end. The own side is the same line mirrored by CSS (row-reverse), so the
// DOM order is the same and a screen reader hears one order for both.
//
// Per-use options, so a surface adapts the shape and never forks it:
//   side        "other" (default) or "own": picks the mirrored styling
//   avatarEl    the <img> the caller built (through agent-avatar.js for an agent);
//               absent draws no avatar
//   showAvatar  false draws no avatar even when avatarEl is given (default true)
//   name        the speaker's name; showName false leaves it out (default true)
//   nameColor   an accent for the name (a mention's own colour)
//   label       the one-line label after the name (an injected message's
//               initiator, note and sender kind)
//   time        the time text; absent draws none
//   extras      elements placed after the label (badges, a stop button)
//   control     the collapse control, placed at the far end
//   actions     the copy/fork/rewind bar, placed after the control
//   compact     the compact header: avatar and name are left out and only the
//               time and controls remain
//
// Returns { el, avatarEl, nameEl, labelEl, timeEl }. All text is set with
// textContent; a name or label can come from another process.

// Avatars are drawn at --msg-avatar-size; resolvers are asked for twice that so
// they stay sharp on a dense screen.
export var AVATAR_REQUEST_SIZE = 48;

function textSpan(className, text) {
  var span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

export function buildMessageHeader(options) {
  var o = options || {};
  var own = o.side === "own";
  var header = document.createElement("div");
  header.className = "dm-bubble-header msg-header" + (own ? " msg-header-own" : "") + (o.compact ? " msg-header-compact" : "");

  var avatarEl = null;
  if (o.avatarEl && o.showAvatar !== false && !o.compact) {
    avatarEl = o.avatarEl;
    avatarEl.classList.add("msg-header-avatar");
    header.appendChild(avatarEl);
  }

  var nameEl = null;
  if (o.name != null && o.showName !== false && !o.compact) {
    nameEl = textSpan("dm-bubble-name", o.name);
    if (o.nameColor) nameEl.style.color = o.nameColor;
    header.appendChild(nameEl);
  }

  var labelEl = null;
  if (o.label) {
    labelEl = textSpan("injected-label msg-header-label", o.label);
    header.appendChild(labelEl);
  }

  (o.extras || []).forEach(function (extra) { header.appendChild(extra); });

  var timeEl = null;
  if (o.time) {
    timeEl = textSpan("dm-bubble-time", o.time);
    header.appendChild(timeEl);
  }

  if (o.control) header.appendChild(o.control);
  if (o.actions) header.appendChild(o.actions);

  return { el: header, avatarEl: avatarEl, nameEl: nameEl, labelEl: labelEl, timeEl: timeEl };
}

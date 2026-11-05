// build-update-sessions.js — the sessions a restart would end, as a count line
// with an expand control instead of one line each in the card's message. A
// card that lists every session grows with the session count until its
// action buttons leave the screen; collapsed by default, and bounded and
// scrolling when expanded, the list can never push them out. The card places
// this block above its actions, never around them. Every value is set with
// textContent: session titles are content, never markup.

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

// The session lines the offer carries, or [] when it has none to set apart.
export function sessionLinesOf(offer) {
  var i = offer && offer.interruptions;
  if (!i || !Array.isArray(i.lines)) return [];
  return i.lines.filter(function (l) { return typeof l === 'string' && l !== ''; });
}

/**
 * The card's message without the per-session lines. Each line is dropped once,
 * by exact match on the "- " form the daemon writes, so nothing else in the
 * message can be mistaken for a session.
 */
export function messageWithoutSessions(message, lines) {
  if (lines.length === 0) return message;
  var pending = lines.map(function (l) { return '- ' + l; });
  return String(message).split('\n').filter(function (l) {
    var at = pending.indexOf(l);
    if (at === -1) return true;
    pending.splice(at, 1);
    return false;
  }).join('\n');
}

/**
 * @param {string[]} lines
 * @param {{collapsed?: boolean}} [opts]
 * @returns {?HTMLElement} null when there is no session to list
 */
export function buildSessionsEl(lines, opts) {
  if (!lines || lines.length === 0) return null;
  var collapsed = !(opts && opts.collapsed === false);

  var root = document.createElement('div');
  root.className = 'build-update-sessions';

  var head = document.createElement('div');
  head.className = 'build-update-sessions-head';
  var count = document.createElement('span');
  count.className = 'build-update-sessions-count';
  count.textContent = 'Ends ' + plural(lines.length, 'live session');
  var toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'collapsible-toggle build-update-sessions-toggle';
  head.appendChild(count);
  head.appendChild(toggle);

  var list = document.createElement('ul');
  list.className = 'build-update-session-list';
  lines.forEach(function (l) {
    var item = document.createElement('li');
    item.textContent = l;
    list.appendChild(item);
  });

  function apply() {
    root.classList.toggle('is-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.textContent = collapsed ? 'Expand' : 'Collapse';
  }
  toggle.addEventListener('click', function () {
    collapsed = !collapsed;
    apply();
  });
  apply();

  root.appendChild(head);
  root.appendChild(list);
  return root;
}

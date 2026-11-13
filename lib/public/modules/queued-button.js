// queued-button.js - the control on a queued outbox item. Labelled in words and
// sized like the send button (the styling is on .shell-queued-btn). One place,
// so every kind of outbox item draws its controls the same way.
//
// opts.icon: a lucide icon name; the button then shows the icon alone and `label`
// is its accessible name and tooltip. The icon is a placeholder the page's icon
// pass resolves: the caller runs refreshIcons over the row once it is placed.
// Without opts the button is the word button it always was.

import { iconHtml } from './icons.js';

export function queuedButton(label, cls, opts) {
  var b = document.createElement("button");
  b.className = "shell-queued-btn " + cls;
  if (opts && opts.icon) {
    b.classList.add("shell-queued-icon-btn");
    b.title = label;
    b.innerHTML = iconHtml(opts.icon);
  } else {
    b.textContent = label;
  }
  b.setAttribute("aria-label", label);
  return b;
}

// queued-button.js - the control on a queued outbox item. Labelled in words and
// sized like the send button (the styling is on .shell-queued-btn). One place,
// so every kind of outbox item draws its controls the same way.

export function queuedButton(label, cls) {
  var b = document.createElement("button");
  b.className = "shell-queued-btn " + cls;
  b.textContent = label;
  b.setAttribute("aria-label", label);
  return b;
}

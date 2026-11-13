// Detects that the daemon now serves a different build than the one this page
// booted with, and gets the page onto the new client.
//
// The id arrives with every connect (the WebSocket info message and /info), so a
// tab that stayed open across a daemon restart notices on its reconnect, even
// when both builds carry the same package version.
//
// Reload versus banner: a reload drops what has not been sent yet, so with
// unsent input the guard shows a banner the user acts on instead, and reloads
// at once when there is nothing to lose.

import { showOverlay } from './overlay.js';

var RELOAD_BANNER_ID = "sw-update-banner";

export function createBuildGuard(deps) {
  var booted = null;
  var acted = false;

  // Returns what happened, so callers and tests can tell the paths apart.
  function observe(buildId) {
    if (!buildId) return "ignored";
    if (booted === null) {
      booted = buildId;
      return "booted";
    }
    if (buildId === booted) return "same";
    if (acted) return "pending";
    acted = true;
    if (deps.hasUnsent()) {
      deps.showBanner();
      return "banner";
    }
    deps.reload();
    return "reload";
  }

  // Both ways the id arrives carry it as `buildId`: the WebSocket "info" message
  // and the /info response. One entry point for both keeps them from drifting.
  function observeInfo(info) {
    return observe(info && info.buildId);
  }

  return { observe: observe, observeInfo: observeInfo };
}

/**
 * The reload banner, drawn once however many paths ask (the build guard here,
 * the service worker's update message in notifications.js: both share its id).
 * By default it is not dismissable: the page is running code the server no
 * longer matches.
 * @param {Document} doc
 * @param {function(): void} reload
 * @param {{text?: string, dismissible?: boolean}} [opts]
 */
export function showReloadBanner(doc, reload, opts) {
  var o = opts || {};
  if (doc.getElementById(RELOAD_BANNER_ID)) return;
  var text = doc.createElement("span");
  text.className = "sw-update-banner-text";
  text.textContent = o.text || "Clagentic: Console was updated. Reload to continue.";
  var button = doc.createElement("button");
  button.className = "sw-update-banner-btn";
  button.id = "sw-update-reload";
  button.textContent = "Reload";
  button.addEventListener("click", reload);
  showOverlay({
    doc: doc,
    kind: "banner",
    id: RELOAD_BANNER_ID,
    className: "sw-update-banner",
    content: [text, button],
    dismissible: o.dismissible === true,
  });
}

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

  return { observe: observe };
}

// Not dismissable: the page is running code the server no longer matches.
export function showReloadBanner(doc, reload) {
  if (doc.getElementById("sw-update-banner")) return;
  var banner = doc.createElement("div");
  banner.id = "sw-update-banner";
  banner.className = "sw-update-banner";
  var text = doc.createElement("span");
  text.className = "sw-update-banner-text";
  text.textContent = "Clagentic: Console was updated. Reload to continue.";
  var button = doc.createElement("button");
  button.className = "sw-update-banner-btn";
  button.id = "sw-update-reload";
  button.textContent = "Reload";
  button.addEventListener("click", reload);
  banner.appendChild(text);
  banner.appendChild(button);
  doc.body.appendChild(banner);
  banner.classList.add("visible");
}

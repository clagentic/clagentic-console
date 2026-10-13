// vendor-picker.js - draws the agent picker into its container from picker
// rows. An agent that is not installed (or could not be checked) is shown
// disabled with why, and a Re-check button asks the server to look again.
// Kept free of app state: the caller passes the rows and the two actions.

/**
 * @param {Element} container   emptied and refilled
 * @param {Array} rows          from pickerRows (vendor-registry.js)
 * @param {{onSelect: function(string), onRecheck: function()}} actions
 */
export function renderVendorPicker(container, rows, actions) {
  container.innerHTML = "";
  var anyUnavailable = false;
  rows.forEach(function (row) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "vendor-toggle-btn" + (row.active ? " active" : "") + (row.installed ? "" : " disabled");
    btn.dataset.vendor = row.id;
    btn.title = row.title;
    if (!row.installed) {
      btn.setAttribute("aria-disabled", "true");
      anyUnavailable = true;
    }
    if (row.icon) {
      var icon = document.createElement("img");
      icon.className = "vendor-toggle-icon";
      icon.src = row.icon;
      icon.alt = row.displayName;
      btn.appendChild(icon);
    }
    var label = document.createElement("span");
    label.className = "vendor-toggle-label";
    label.textContent = row.displayName;
    btn.appendChild(label);
    if (row.checkFailed || row.version) {
      var note = document.createElement("span");
      note.className = "vendor-toggle-note";
      note.textContent = row.checkFailed ? "Could not check" : row.version;
      btn.appendChild(note);
    }
    btn.addEventListener("click", function () { actions.onSelect(row.id); });
    container.appendChild(btn);
  });
  if (anyUnavailable) {
    var recheck = document.createElement("button");
    recheck.type = "button";
    recheck.className = "vendor-recheck-btn";
    recheck.textContent = "Re-check";
    recheck.title = "Look again for installed agents";
    recheck.addEventListener("click", function () { actions.onRecheck(); });
    container.appendChild(recheck);
  }
}

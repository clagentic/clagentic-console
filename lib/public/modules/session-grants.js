// session-grants.js - the operator's list of what a session may do without
// asking (its Allow for session grants), with a Revoke for each. The server
// owns the grants (lib/prompt-registry.js); this only asks for the list,
// draws what it is told and sends a revoke. A revoke takes effect on the
// session's next tool call, and the server answers with the list as it now is.
//
// Free of the rest of the frontend module graph apart from the connection, so
// a test can drive it with a hand-built DOM.

import { getWs } from './ws-ref.js';

var MODAL_ID = "session-grants-modal";

function send(msg) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

function modal() {
  return document.getElementById(MODAL_ID);
}

function close() {
  var m = modal();
  if (m && m.parentNode) m.parentNode.removeChild(m);
}

/**
 * Draw a grant list into list; exported for tests.
 * @param {Element} list
 * @param {{key: string, text: string, wholeTool: boolean}[]} grants
 * @param {number} sessionId
 * @param {function(object): boolean} sendMsg
 */
export function renderGrantList(list, grants, sessionId, sendMsg) {
  list.textContent = "";
  var error = document.createElement("div");
  error.className = "session-grants-error";
  list.appendChild(error);
  if (!grants.length) {
    var empty = document.createElement("div");
    empty.className = "session-grants-empty";
    empty.textContent = "This session has no Allow for session grants. Every tool call that needs approval asks.";
    list.appendChild(empty);
    return;
  }
  grants.forEach(function (g) {
    var row = document.createElement("div");
    row.className = "session-grants-row" + (g.wholeTool ? " session-grants-whole" : "");
    row.dataset.grantKey = g.key;
    var text = document.createElement("span");
    text.className = "session-grants-text";
    text.textContent = g.text;
    var revoke = document.createElement("button");
    revoke.className = "session-grants-revoke";
    revoke.textContent = "Revoke";
    // Disabled only while the request is in flight. The row goes when the
    // server's list arrives without the grant; a failed send or a server
    // refusal re-enables the button so the revoke can be retried.
    revoke.addEventListener("click", function () {
      revoke.disabled = true;
      error.textContent = "";
      var sent = sendMsg({ type: "revoke_session_grant", sessionId: sessionId, key: g.key });
      if (sent === false) {
        revoke.disabled = false;
        error.textContent = "Could not revoke: not connected. Try again.";
      }
    });
    row.appendChild(text);
    row.appendChild(revoke);
    list.appendChild(row);
  });
}

/** Open the grants list for a session. */
export function openSessionGrants(sessionId) {
  close();
  var m = document.createElement("div");
  m.id = MODAL_ID;
  m.dataset.sessionId = String(sessionId);
  var backdrop = document.createElement("div");
  backdrop.className = "confirm-backdrop";
  backdrop.addEventListener("click", close);
  var dialog = document.createElement("div");
  dialog.className = "confirm-dialog session-grants-dialog";
  var title = document.createElement("div");
  title.className = "session-grants-title";
  title.textContent = "Allow for session grants";
  var list = document.createElement("div");
  list.className = "session-grants-list";
  list.textContent = "Loading...";
  var done = document.createElement("button");
  done.className = "confirm-btn confirm-cancel";
  done.textContent = "Close";
  done.addEventListener("click", close);
  dialog.appendChild(title);
  dialog.appendChild(list);
  dialog.appendChild(done);
  m.appendChild(backdrop);
  m.appendChild(dialog);
  document.body.appendChild(m);
  send({ type: "list_session_grants", sessionId: sessionId });
}

/**
 * A server refusal: keep the rows, show why, and let each Revoke be tried
 * again. Exported for tests.
 * @param {Element} list
 * @param {string} message
 */
export function showGrantError(list, message) {
  var buttons = list.querySelectorAll(".session-grants-revoke");
  for (var i = 0; i < buttons.length; i++) buttons[i].disabled = false;
  var error = list.querySelector(".session-grants-error");
  if (error) error.textContent = message;
}

/** The server's session_grants message: redraw the list if it is the one open. */
export function handleSessionGrants(msg) {
  var m = modal();
  if (!m || m.dataset.sessionId !== String(msg.sessionId)) return;
  var list = m.querySelector(".session-grants-list");
  if (!list) return;
  if (typeof msg.error === "string" && msg.error) {
    showGrantError(list, "Could not revoke: " + msg.error);
    return;
  }
  renderGrantList(list, Array.isArray(msg.grants) ? msg.grants : [], msg.sessionId, send);
}

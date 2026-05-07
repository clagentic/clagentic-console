// ws-ref.js - Shared WebSocket reference
// Infrastructure singleton, not state. Lives outside the store.

var _ws = null;

export function getWs() { return _ws; }
export function setWs(v) { _ws = v; }

function sendWith(ws, payload, quiet) {
  if (!ws || ws.readyState !== 1) return false;
  var body = typeof payload === "string" ? payload : JSON.stringify(payload);
  if (quiet && typeof ws._sendRaw === "function") {
    ws._sendRaw(body);
    return true;
  }
  ws.send(body);
  return true;
}

export function sendWs(payload) {
  return sendWith(_ws, payload, false);
}

export function sendWsQuiet(payload) {
  return sendWith(_ws, payload, true);
}

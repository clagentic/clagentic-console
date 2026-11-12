// serialized-save.js - the one way a per-user preference is written to the server.
//
// The server keeps the last write it receives, and requests can arrive out of
// order, so only one save is in flight; a choice made meanwhile replaces the
// waiting one and is sent when the in-flight save finishes. Best effort: the
// next profile load reconciles a save that failed.
//
//   var save = createSerializedSaver("/api/user/chat-width", "chatWidth");
//   save("wide");   // PUT {"chatWidth":"wide"}

export function createSerializedSaver(url, bodyKey) {
  var saving = false;
  var hasWaiting = false;
  var waitingValue = null;

  function sendWaiting() {
    var value = waitingValue;
    hasWaiting = false;
    waitingValue = null;
    var body = {};
    body[bodyKey] = value;
    fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(function () {
      // Best effort: the next profile load reconciles.
    }).then(function () {
      if (hasWaiting) sendWaiting();
      else saving = false;
    });
  }

  return function save(value) {
    waitingValue = value;
    hasWaiting = true;
    if (saving) return;
    saving = true;
    sendWaiting();
  };
}

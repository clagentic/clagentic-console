// serialized-save.js - the one way a per-user preference is written to the server.
//
// The server keeps the last write it receives, and requests can arrive out of
// order, so only one save is in flight; a choice made meanwhile replaces the
// waiting one and is sent when the in-flight save finishes. A save that fails
// (a network error or a non-OK status) is reported with console.error, naming
// the setting, and is not retried: the saver keeps sending later choices, and
// the next profile load reconciles what the server kept.
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
    }).then(function (res) {
      if (res && res.ok === false) {
        console.error("Saving " + bodyKey + " failed: HTTP " + res.status);
      }
    }, function (err) {
      console.error("Saving " + bodyKey + " failed:", err);
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

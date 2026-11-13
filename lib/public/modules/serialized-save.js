// serialized-save.js - the one way a per-user preference is written to the server.
//
// The server keeps the last write it receives, and requests can arrive out of
// order, so only one save is in flight; a choice made meanwhile replaces the
// waiting one and is sent when the in-flight save finishes. A save that fails
// (a network error or a non-OK status) is reported through preference-sync.js,
// naming the setting, and is not retried: the saver keeps sending later
// choices, and the next profile load reconciles what the server kept.
//
//   var save = createSerializedSaver("/api/user/chat-width", "chatWidth");
//   save("wide");   // PUT {"chatWidth":"wide"}
//
// A choice that needs more than one request, in order (the theme: a mode, then
// a custom theme id), goes through createSerializedRequestSaver, which takes the
// list of requests as the value. The waiting list replaces the older waiting
// list as a whole, so the server never sees half of one choice and half of
// another.
//
//   var save = createSerializedRequestSaver();
//   save([{ url: "/api/user/theme-mode", bodyKey: "themeMode", value: "dark" }]);

import { reportPreferenceFailure } from "./preference-sync.js";

function sendOne(request) {
  var body = {};
  body[request.bodyKey] = request.value;
  var sent;
  try {
    // Sent now, not on a later tick: an idle saver puts a choice on the wire at once.
    sent = fetch(request.url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    sent = Promise.reject(err);
  }
  return sent.then(function (res) {
    if (res && res.ok === false) {
      reportPreferenceFailure("Saving " + request.bodyKey + " failed: HTTP " + res.status);
    }
  }, function (err) {
    reportPreferenceFailure("Saving " + request.bodyKey + " failed:", err);
  });
}

export function createSerializedRequestSaver() {
  var saving = false;
  var waiting = null;

  function sendWaiting() {
    var requests = waiting;
    waiting = null;
    sendFrom(requests, 0);
  }

  function sendFrom(requests, at) {
    if (at >= requests.length) {
      if (waiting) sendWaiting();
      else saving = false;
      return;
    }
    sendOne(requests[at]).then(function () { sendFrom(requests, at + 1); });
  }

  return function save(requests) {
    waiting = requests;
    if (saving) return;
    saving = true;
    sendWaiting();
  };
}

export function createSerializedSaver(url, bodyKey) {
  var saveRequests = createSerializedRequestSaver();
  return function save(value) {
    saveRequests([{ url: url, bodyKey: bodyKey, value: value }]);
  };
}

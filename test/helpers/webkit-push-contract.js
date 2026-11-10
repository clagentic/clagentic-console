"use strict";

// A fake service-worker registration that enforces the userVisibleOnly push
// rule: iOS and desktop Safari revoke a push subscription whose push event
// shows no notification, and Chrome (desktop and Android) posts a generic
// "updated in the background" notice of its own. Each runPush records the showNotification calls made while
// one push is handled, and fails naming the push when a user agent that
// requires a visible notification showed none.

var sw = require("../../lib/public/notify-sw-logic.js");

var IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
var SAFARI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
var ANDROID_UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36";
var CHROME_DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function createContractWorld(userAgent) {
  var all = [];
  var calls = null;
  var lingers = [];
  var autoLinger = true;

  var registration = {
    showNotification: function (title, o) {
      if (calls) calls.push({ title: title, options: o });
      // The platform replaces whatever is shown under the same tag.
      all.forEach(function (n) { if (n.tag === o.tag && !n.closed) n.closed = true; });
      all.push({ tag: o.tag, data: o.data, options: o, closed: false, close: function () { this.closed = true; } });
      return Promise.resolve();
    },
    getNotifications: function (f) {
      return Promise.resolve(all.filter(function (n) {
        return !n.closed && (!f || !f.tag || n.tag === f.tag);
      }));
    },
  };

  var env = {
    registration: registration,
    userAgent: userAgent,
    scope: "https://h.example/",
    setTimeout: function (fn) {
      if (autoLinger) fn(); else lingers.push(fn);
    },
  };

  return {
    env: env,
    lingers: lingers,
    holdLingers: function () { autoLinger = false; },
    live: function () { return all.filter(function (n) { return !n.closed; }); },
    liveUnder: function (tag) { return all.filter(function (n) { return !n.closed && n.tag === tag; }); },

    /**
     * Handles one push event and returns the notifications it showed.
     * @param {string} label names the push in a contract failure.
     * @param {object} data the parsed push payload.
     */
    runPush: function (label, data) {
      return pushAndRecord(label, data, true);
    },
    /** As runPush but for a push already in flight (a held linger). */
    startPush: function (label, data) {
      var rec = beginRecord();
      var done = sw.handlePush(env, data).then(function () { return finish(label, rec); });
      return { settled: done, shownSoFar: function () { return rec.slice(); } };
    },
  };

  function beginRecord() {
    calls = [];
    return calls;
  }

  function finish(label, rec) {
    if (calls === rec) calls = null;
    if (sw.requiresVisible(userAgent) && rec.length === 0) {
      throw new Error("Push contract broken: push '" + label + "' showed no notification");
    }
    return rec;
  }

  function pushAndRecord(label, data) {
    var rec = beginRecord();
    return sw.handlePush(env, data).then(function () { return finish(label, rec); });
  }
}

module.exports = {
  createContractWorld: createContractWorld,
  IOS_UA: IOS_UA,
  SAFARI_UA: SAFARI_UA,
  ANDROID_UA: ANDROID_UA,
  CHROME_DESKTOP_UA: CHROME_DESKTOP_UA,
};

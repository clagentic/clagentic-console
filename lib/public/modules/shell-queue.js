// shell-queue.js - chat typed while a ! command runs. The page keeps it, shows it
// as queued, and sends it in the order it was typed once the command's result
// arrives. The server holds nothing.
//
// Two rules keep a message from being lost or doubled:
//  - a message leaves the queue only by being sent. A send that fails leaves it
//    (and everything behind it) queued, shown as not sent, for the next flush;
//  - a message is drawn once, when it is added. A flush after a failure never
//    draws it again.
// A message whose session is no longer on screen is parked as plain text, kept
// (and saved through hooks.storage, so a reload keeps it) until the person is
// back in that session's composer, where it is restored. No DOM here.

/**
 * @param {object} hooks
 * @param {function(object): *} hooks.show        draws one queued entry, returns a handle
 * @param {function(*): void} hooks.hide          removes what show drew
 * @param {function(*, string): void} hooks.markUnsent  shows an entry as not sent, with why
 * @param {{load: function(): ?Array, save: function(Array): void}} [hooks.storage]
 */
export function createChatQueue(hooks) {
  // Waiting in this page for their session's command to end.
  var entries = [];
  // scope -> [{text, imageCount}]: kept for a composer that is not on screen.
  var parked = new Map();
  var nextId = 1;

  function loadSaved() {
    var saved = hooks.storage ? hooks.storage.load() : null;
    if (!Array.isArray(saved)) return;
    saved.forEach(function (pair) {
      if (!Array.isArray(pair) || typeof pair[0] !== "string" || !Array.isArray(pair[1])) return;
      var items = pair[1].filter(function (it) { return it && typeof it.text === "string"; })
        .map(function (it) { return { text: it.text, imageCount: it.imageCount | 0 }; });
      if (items.length > 0) parked.set(pair[0], items);
    });
  }

  // What a reload must still find: the parked text and the entries still waiting.
  function persist() {
    if (!hooks.storage) return;
    var out = new Map();
    parked.forEach(function (items, scope) { out.set(scope, items.slice()); });
    entries.forEach(function (e) {
      if (!out.has(e.scope)) out.set(e.scope, []);
      out.get(e.scope).push({ text: e.restoreText, imageCount: e.imageCount });
    });
    hooks.storage.save(Array.from(out.entries()));
  }

  loadSaved();

  return {
    /**
     * Queues a message and draws it as queued.
     * @param {{scope: string, text: string, restoreText: string, imageCount: number}} item
     *   plus whatever the caller needs to send it (kept as given)
     */
    add: function (item) {
      var entry = Object.assign({ id: nextId++, drawn: false, unsent: null, handle: null }, item);
      entries.push(entry);
      entry.handle = hooks.show(entry);
      entry.drawn = true;
      persist();
      return entry;
    },

    /** How many messages of a session are waiting. */
    sizeFor: function (scope) {
      return entries.filter(function (e) { return e.scope === scope; }).length;
    },

    /**
     * Sends a session's waiting messages in order and stops at the first that
     * fails. send(entry) returns true once the message has been sent.
     * @returns {{sent: number, failed: boolean}}
     */
    flush: function (scope, send) {
      var sent = 0;
      for (;;) {
        var next = null;
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].scope === scope) { next = entries[i]; break; }
        }
        if (!next) return { sent: sent, failed: false };
        var ok = false;
        var why = "the connection is not open";
        try {
          ok = send(next) === true;
        } catch (err) {
          why = (err && err.message) || String(err);
        }
        if (!ok) {
          next.unsent = why;
          if (next.drawn) hooks.markUnsent(next.handle, why);
          return { sent: sent, failed: true };
        }
        entries.splice(entries.indexOf(next), 1);
        if (next.drawn) hooks.hide(next.handle);
        sent++;
        persist();
      }
    },

    /**
     * The page's transcript was cleared and rebuilt for a session: forget what
     * was drawn, so draw() puts the session's entries back once each.
     */
    forgetDrawn: function () {
      entries.forEach(function (e) { e.drawn = false; e.handle = null; });
    },

    /** Draws a session's entries that are not on screen; the ones that failed show as not sent. */
    draw: function (scope) {
      entries.forEach(function (e) {
        if (e.scope !== scope || e.drawn) return;
        e.handle = hooks.show(e);
        e.drawn = true;
        if (e.unsent) hooks.markUnsent(e.handle, e.unsent);
      });
    },

    /** The session on screen changed: waiting messages of any other session are parked. */
    leave: function (scope) {
      var stay = [];
      entries.forEach(function (e) {
        if (e.scope === scope) { stay.push(e); return; }
        if (!parked.has(e.scope)) parked.set(e.scope, []);
        parked.get(e.scope).push({ text: e.restoreText, imageCount: e.imageCount });
      });
      entries = stay;
      persist();
    },

    /** Keeps plain text for a session's composer. */
    park: function (scope, text) {
      if (!parked.has(scope)) parked.set(scope, []);
      parked.get(scope).push({ text: text, imageCount: 0 });
      persist();
    },

    /** Takes what is parked for a session, oldest first, for its composer. */
    takeParked: function (scope) {
      var items = parked.get(scope) || [];
      parked.delete(scope);
      persist();
      return items;
    },
  };
}

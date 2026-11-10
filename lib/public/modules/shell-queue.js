// shell-queue.js - chat typed while a ! command runs. The page keeps it, shows it
// as queued, and sends it in the order it was typed once the command's result
// arrives. The server holds nothing. A message leaves the queue only by being
// sent: a failed send leaves it (and every message behind it) queued for the next
// flush. No DOM here; the caller supplies how a queued message is drawn.

/**
 * @param {object} hooks
 * @param {function(string): *} hooks.show      draws one queued message, returns a handle
 * @param {function(*): void} hooks.hide        removes what show drew
 * @param {function(Error): void} [hooks.onError] called when a send fails
 */
export function createChatQueue(hooks) {
  var entries = [];

  return {
    /** Queues a message; send is called with no arguments when its turn comes. */
    add: function (label, send) {
      entries.push({ send: send, shown: hooks.show(label) });
    },

    /** Sends every queued message in order; stops at the first that fails. */
    flush: function () {
      while (entries.length > 0) {
        var next = entries[0];
        try {
          next.send();
        } catch (err) {
          if (hooks.onError) hooks.onError(err);
          return;
        }
        entries.shift();
        hooks.hide(next.shown);
      }
    },

    size: function () { return entries.length; },
  };
}

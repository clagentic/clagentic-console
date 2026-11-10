// queued-chat.js - chat pushed into a running turn that the agent has not yet
// taken in. The message is already with the agent (native timing: it is folded
// in at the agent's next step), so the console only tracks it, by the message id
// the page minted, until the agent reports it consumed it (delivered) or the
// sender withdraws it (cancelled). Exactly one of the two ever happens for an
// id: whichever the session sees first removes the entry, and the other finds
// nothing and changes nothing.
//
// A message the agent has not taken stays tracked across turns: the agent's
// queue keeps it and runs it as a later turn (as the native CLI does), so a
// turn ending with it still waiting is not a drop. It is dropped only when the
// query that held it is closed (dropAll), because then nothing will ever take it.
//
// No I/O here: what delivery and a drop do (record the message, tell the page)
// is passed in by the caller that registered the message.

var STATE_KEY = "_queuedChat";

// The id is handed to the agent as the message's uuid, so it must be a uuid.
var UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a value from a page is usable as a message id. */
function isMessageId(value) {
  return typeof value === "string" && UUID_SHAPE.test(value);
}

function table(session) {
  if (!session[STATE_KEY]) session[STATE_KEY] = new Map();
  return session[STATE_KEY];
}

/**
 * Starts tracking a pushed message.
 * @param {object} session
 * @param {string} messageId
 * @param {{onDelivered: function(): void, onDropped: function(): void}} hooks
 *   onDelivered runs once when the agent takes the message; onDropped runs once
 *   when the query is closed with the message never taken and never cancelled.
 * @param {{text: string, pastes: string[], imageCount: number}} [restore]  what
 *   the page needs to hand the message back to its sender when it can no longer
 *   find its own queued item (a switched session, a reload)
 */
function register(session, messageId, hooks, restore) {
  table(session).set(messageId, { hooks: hooks, restore: restore || null, cancelling: null });
}

/** The text of a tracked message, as registered, or null when it is not tracked. */
function restoreOf(session, messageId) {
  var entry = session[STATE_KEY] && session[STATE_KEY].get(messageId);
  return entry ? entry.restore : null;
}

function has(session, messageId) {
  return !!session[STATE_KEY] && session[STATE_KEY].has(messageId);
}

/**
 * The agent reports these message ids as consumed. Each tracked id is delivered
 * once; an id that is not tracked (already delivered, cancelled, or never
 * queued) is ignored.
 * @param {object} session
 * @param {string[]} ids
 * @returns {string[]} the ids that were delivered by this call
 */
function consume(session, ids) {
  var tracked = session[STATE_KEY];
  if (!tracked || tracked.size === 0 || !Array.isArray(ids)) return [];
  var delivered = [];
  ids.forEach(function (id) {
    var entry = tracked.get(id);
    if (!entry) return;
    tracked.delete(id);
    delivered.push(id);
    entry.hooks.onDelivered();
  });
  return delivered;
}

/**
 * Withdraws a tracked message.
 * @param {object} session
 * @param {string} messageId
 * @param {function(string): Promise<boolean>} cancelFn  asks the agent; true
 *   only when the agent still held the message and dropped it
 * @returns {Promise<"cancelled"|"already_delivered">} already_delivered covers a
 *   message the agent took (or is taking), one cancelled before, and an unknown
 *   id: in each the page must not expect the message back. Rejects when the
 *   agent could not answer; the message is then still tracked.
 */
function cancel(session, messageId, cancelFn) {
  var tracked = session[STATE_KEY];
  var entry = tracked && tracked.get(messageId);
  if (!entry) return Promise.resolve("already_delivered");
  if (entry.cancelling) return entry.cancelling;
  var asked = Promise.resolve().then(function () { return cancelFn(messageId); }).then(function (withdrawn) {
    entry.cancelling = null;
    // A delivery that was processed while the agent was answering already
    // removed the entry; it wins, whatever the agent said.
    if (tracked.get(messageId) !== entry) return "already_delivered";
    if (withdrawn === true) {
      tracked.delete(messageId);
      return "cancelled";
    }
    return "already_delivered";
  }, function (err) {
    entry.cancelling = null;
    throw err;
  });
  entry.cancelling = asked;
  return asked;
}

/**
 * The query was closed and these messages were never taken: nothing will
 * deliver them now, so each is dropped once. Not for the end of a turn: the
 * agent runs a message still waiting then as its next turn.
 * @returns {string[]} the dropped ids
 */
function dropAll(session) {
  var tracked = session[STATE_KEY];
  if (!tracked || tracked.size === 0) return [];
  var entries = Array.from(tracked.entries());
  tracked.clear();
  entries.forEach(function (pair) { pair[1].hooks.onDropped(); });
  return entries.map(function (pair) { return pair[0]; });
}

module.exports = { isMessageId: isMessageId, register: register, has: has, restoreOf: restoreOf, consume: consume, cancel: cancel, dropAll: dropAll };

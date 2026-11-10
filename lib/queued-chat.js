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
// One exception: a cancel the SDK answers false to. The SDK's cancel_async_message
// answer is only `response.cancelled` (a boolean; sdk.mjs cancelAsyncMessage), and
// false does not say whether the message runs: it also covers the representative
// of a coalesced batch (the whole batch is dropped) and a held-back uuid (dropped
// later by the drain), see the SDKControlInterruptResponse notes in sdk.d.ts.
// Such a message stays tracked as unconfirmed and is settled by what the agent
// does next: taken (delivered) or not taken when a turn ends (dropped).
//
// No I/O here: what delivery and a drop do (record the message, tell the page)
// is passed in by the caller that registered the message.

var STATE_KEY = "_queuedChat";
// Registration counter, and its value when the last turn ended: a message
// registered before that point was waiting for the next turn's batch.
var SEQ_KEY = "_queuedChatSeq";
var BOUNDARY_KEY = "_queuedChatBoundary";

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
  var seq = (session[SEQ_KEY] || 0) + 1;
  session[SEQ_KEY] = seq;
  table(session).set(messageId, { hooks: hooks, restore: restore || null, cancelling: null, seq: seq, unconfirmed: false, armed: false });
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
 * @returns {Promise<"cancelled"|"already_delivered"|"pending">} already_delivered
 *   covers a message already consumed, one cancelled before, and an unknown id:
 *   in each the page must not expect the message back. pending: the agent did
 *   not drop it from its queue, which does not say whether it runs; it stays
 *   tracked and ends delivered or dropped (see settleTurn). Rejects when the
 *   agent could not answer; the message is then still tracked.
 */
function cancel(session, messageId, cancelFn) {
  var tracked = session[STATE_KEY];
  var entry = tracked && tracked.get(messageId);
  if (!entry) return Promise.resolve("already_delivered");
  if (entry.unconfirmed) return Promise.resolve("pending");
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
    // The SDK's answer is a bare boolean (see the file header). false covers a
    // message that runs (taken already, a non-representative member of a
    // coalesced batch), one that is dropped (the batch representative drops the
    // whole batch; a held-back message is dropped by the drain later) and an
    // unknown id, with no field telling them apart. The message therefore stays
    // tracked: its delivery still delivers it; if the turn ends with it never
    // taken, settleTurn drops it with its text.
    suspect(session, entry);
    return "pending";
  }, function (err) {
    entry.cancelling = null;
    throw err;
  });
  entry.cancelling = asked;
  return asked;
}

// Marks the cancelled message, and the messages that were waiting with it for
// the same turn's batch (registered before the last turn ended), as unconfirmed.
// A cancel of a batch representative drops every member, so each member's fate is
// settled the same way; a message registered during the running turn cannot be
// in that batch and is left alone.
function suspect(session, entry) {
  var boundary = session[BOUNDARY_KEY] || 0;
  table(session).forEach(function (other) {
    if (other === entry || other.seq <= boundary) other.unconfirmed = true;
  });
}

function dropEntries(session, picked) {
  var tracked = session[STATE_KEY];
  var ids = [];
  picked.forEach(function (pair) {
    tracked.delete(pair[0]);
    ids.push(pair[0]);
  });
  picked.forEach(function (pair) { pair[1].hooks.onDropped(); });
  return ids;
}

function unconfirmedPairs(session, only) {
  var tracked = session[STATE_KEY];
  if (!tracked) return [];
  return Array.from(tracked.entries()).filter(function (pair) { return pair[1].unconfirmed && (!only || only(pair[1])); });
}

/**
 * A frame of the agent's stream was handled (after consume). Call it for every
 * frame; isResult marks the end of a turn. An unconfirmed message (a cancel that
 * answered false) that is still not taken when a turn that began after the
 * cancel ends did not run in it: a message the agent folds into a turn is named
 * on that turn's frames, before its result. It is dropped, once, with its text.
 * @param {object} session
 * @param {boolean} isResult
 * @returns {string[]} the dropped ids
 */
function settleTurn(session, isResult) {
  var tracked = session[STATE_KEY];
  if (!isResult) {
    if (tracked) tracked.forEach(function (e) { if (e.unconfirmed) e.armed = true; });
    return [];
  }
  session[BOUNDARY_KEY] = session[SEQ_KEY] || 0;
  return dropEntries(session, unconfirmedPairs(session, function (e) { return e.armed; }));
}

/** Whether any message is waiting for the outcome of a cancel the agent answered false to. */
function hasUnconfirmed(session) {
  return unconfirmedPairs(session).length > 0;
}

/**
 * Called some time after a cancel answered false. With no turn running there is
 * no result frame left to settle the message, so each unconfirmed message is
 * dropped now; with a turn running its result frame settles it.
 * @returns {string[]} the dropped ids
 */
function settleIdle(session, turnRunning) {
  if (turnRunning) return [];
  return dropEntries(session, unconfirmedPairs(session));
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

module.exports = { isMessageId: isMessageId, register: register, has: has, restoreOf: restoreOf, consume: consume, cancel: cancel, settleTurn: settleTurn, settleIdle: settleIdle, hasUnconfirmed: hasUnconfirmed, dropAll: dropAll };

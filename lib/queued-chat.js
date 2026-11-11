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
// Such a message stays tracked as unconfirmed. An unconfirmed message ends in one
// of three ways only: taken (delivered), dropped "not_taken" by the idle grace
// settle (settleIdle, which never fires while a turn runs), or dropped "closed"
// with its query. The end of a turn settles nothing: a turn that ends with the
// message untaken does not say the agent will not run it as the next turn.
//
// No I/O here: what delivery and a drop do (record the message, tell the page)
// is passed in by the caller that registered the message.

var STATE_KEY = "_queuedChat";
// Registration counter, and its value when the last turn ended: a message
// registered before that point was waiting for the next turn's batch (used only
// to choose which waiting messages a representative cancel puts in doubt).
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
 * @param {{onDelivered: function(): void, onDropped: function(string): void, onUnconfirmed: (function(): void)|undefined}} hooks
 *   onDelivered runs once when the agent takes the message; onDropped runs once
 *   with the cause when the message is never taken and never cancelled:
 *   "closed" (its query closed) or "not_taken" (a cancel the agent answered false
 *   to was followed by the idle grace with no turn running and no delivery);
 *   onUnconfirmed runs when a
 *   cancel of another message puts this one in doubt, so its page can say so.
 * @param {{text: string, pastes: string[], imageCount: number}} [restore]  what
 *   the page needs to hand the message back to its sender when it can no longer
 *   find its own queued item (a switched session, a reload)
 */
function register(session, messageId, hooks, restore, owner) {
  var seq = (session[SEQ_KEY] || 0) + 1;
  session[SEQ_KEY] = seq;
  table(session).set(messageId, { hooks: hooks, restore: restore || null, owner: owner || null, cancelling: null, seq: seq, unconfirmed: false });
}

function restoreRecord(messageId, restore) {
  return { messageId: messageId, text: restore.text, pastes: restore.pastes.slice(), imageCount: restore.imageCount };
}

/**
 * The messages still tracked as queued, with what the page needs to draw each
 * one again (a reload, a second tab). Messages registered without restore data
 * are not listed: there is nothing to draw.
 * @returns {Array<{messageId: string, text: string, pastes: string[], imageCount: number, unconfirmed: boolean}>}
 */
function pending(session) {
  var tracked = session[STATE_KEY];
  if (!tracked) return [];
  var out = [];
  tracked.forEach(function (entry, id) {
    if (!entry.restore) return;
    out.push(Object.assign(restoreRecord(id, entry.restore), { unconfirmed: entry.unconfirmed }));
  });
  return out;
}

// Text of messages that will never run (their query closed with nobody viewing
// the session, or the daemon restarted) and that no page has been handed yet. It
// lives with the session, so a restart does not lose it, and goes out once, on
// the next time the session is shown. Each record is {messageId, text, pastes,
// imageCount, cause}; cause is "closed" in this process and "restart" once read
// back from the session file.
var PARKED_KEY = "_queuedChatParked";

/** Keeps a dropped message's text for the next page that shows the session. */
function park(session, messageId, restore, cause) {
  if (!restore) return;
  if (!session[PARKED_KEY]) session[PARKED_KEY] = [];
  session[PARKED_KEY].push(Object.assign(restoreRecord(messageId, restore), { cause: cause }));
}

/** Returns the parked messages and forgets them: each is handed back once. */
function takeParked(session) {
  var parked = session[PARKED_KEY] || [];
  session[PARKED_KEY] = [];
  return parked;
}

/**
 * What survives a restart: the tracked messages and the parked ones, as plain
 * records for the session file. After a restart none of them is tracked any more
 * (the agent that held them is gone), so they all come back as parked.
 */
function durable(session) {
  var records = pending(session).map(function (p) { return { messageId: p.messageId, text: p.text, pastes: p.pastes, imageCount: p.imageCount }; });
  (session[PARKED_KEY] || []).forEach(function (p) {
    records.push({ messageId: p.messageId, text: p.text, pastes: p.pastes, imageCount: p.imageCount });
  });
  return records;
}

/** Reads records from a session file back as parked messages; anything malformed is skipped. */
function loadParked(session, records) {
  if (!Array.isArray(records)) return;
  records.forEach(function (r) {
    if (!r || !isMessageId(r.messageId) || typeof r.text !== "string") return;
    var pastes = Array.isArray(r.pastes) ? r.pastes.filter(function (p) { return typeof p === "string"; }) : [];
    var imageCount = Number.isInteger(r.imageCount) && r.imageCount > 0 ? r.imageCount : 0;
    park(session, r.messageId, { text: r.text, pastes: pastes, imageCount: imageCount }, "restart");
  });
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
 *   tracked and ends delivered or dropped (see settleIdle, dropAll). Rejects when the
 *   agent could not answer; the message is then still tracked. An unconfirmed
 *   message is asked about again: until it is delivered or dropped the agent may
 *   still hold it, and a cancel the builder made must reach the agent.
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
    // The SDK's answer is a bare boolean (see the file header). false covers a
    // message that runs (taken already, a non-representative member of a
    // coalesced batch), one that is dropped (the batch representative drops the
    // whole batch; a held-back message is dropped by the drain later) and an
    // unknown id, with no field telling them apart. The message therefore stays
    // tracked: its delivery still delivers it; if nothing takes it and no turn
    // runs for the grace period, settleIdle drops it with its text.
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
// the same turn's batch (registered before the last turn ended), as unconfirmed,
// and tells the page of each member newly put in doubt.
//
// Which messages a representative cancel drops: sdk.d.ts:4890 (0.3.318, and the
// batch wording of 0.3.295 at sdk.d.ts:4638) says "once a batch is dequeued and
// coalesced into one turn, ... cancelling the batch-representative uuid drops the
// WHOLE coalesced batch". The batch is what was in the queue when the turn was
// dequeued, i.e. the messages registered before the previous turn's result. A
// message registered after that result was pushed while this turn runs: it was
// not in the queue at dequeue, so it is not in the dropped batch; it is taken
// by a fold-in of this turn or waits for the next batch, and stays correctly
// queued (a held-back uuid's cancel-pending mark names only its own uuid). A
// message registered between the result and the dequeue (milliseconds) is
// treated as outside the batch too; if the SDK did drop it, the idle settle
// still returns its text, never a loss.
function suspect(session, entry) {
  var boundary = session[BOUNDARY_KEY] || 0;
  entry.unconfirmed = true;
  table(session).forEach(function (other) {
    if (other === entry || other.unconfirmed || other.seq > boundary) return;
    other.unconfirmed = true;
    if (typeof other.hooks.onUnconfirmed === "function") other.hooks.onUnconfirmed();
  });
}

function dropEntries(session, picked, cause) {
  var tracked = session[STATE_KEY];
  var ids = [];
  picked.forEach(function (pair) {
    tracked.delete(pair[0]);
    ids.push(pair[0]);
  });
  picked.forEach(function (pair) { pair[1].hooks.onDropped(cause); });
  return ids;
}

function unconfirmedPairs(session) {
  var tracked = session[STATE_KEY];
  if (!tracked) return [];
  return Array.from(tracked.entries()).filter(function (pair) { return pair[1].unconfirmed; });
}

/**
 * A turn ended (its result frame). Records the registration count so a later
 * representative cancel can tell the batch dequeued for the next turn from
 * messages pushed after it. It neither delivers nor drops anything.
 * @param {object} session
 */
function markTurnEnd(session) {
  session[BOUNDARY_KEY] = session[SEQ_KEY] || 0;
}

/** Whether any message is waiting for the outcome of a cancel the agent answered false to. */
function hasUnconfirmed(session) {
  return unconfirmedPairs(session).length > 0;
}

/**
 * Called some time after a cancel answered false. With no turn running nothing
 * is left that could take the message, so each unconfirmed message is dropped
 * now; with a turn running it is left alone (the agent may still take it, or run
 * it as the next turn) and the caller asks again later.
 * @returns {string[]} the dropped ids
 */
function settleIdle(session, turnRunning) {
  if (turnRunning) return [];
  return dropEntries(session, unconfirmedPairs(session), "not_taken");
}

/**
 * The query was closed and these messages were never taken: nothing will
 * deliver them now, so each is dropped once. Not for the end of a turn: the
 * agent runs a message still waiting then as its next turn.
 * @param {object} session
 * @param {object} [owner]  the query that closed. A rewind can replace the query
 *   while the old one is still unwinding, so a message pushed into the new query
 *   must survive the old one's close: only messages pushed into this query (or
 *   registered with no query to name, which a close cannot tell apart) are
 *   dropped. Omitted: every tracked message.
 * @returns {string[]} the dropped ids
 */
function dropAll(session, owner) {
  var tracked = session[STATE_KEY];
  if (!tracked || tracked.size === 0) return [];
  var entries = Array.from(tracked.entries()).filter(function (pair) {
    return owner === undefined || pair[1].owner === owner || pair[1].owner === null;
  });
  entries.forEach(function (pair) { tracked.delete(pair[0]); });
  entries.forEach(function (pair) { pair[1].hooks.onDropped("closed"); });
  return entries.map(function (pair) { return pair[0]; });
}

module.exports = { isMessageId: isMessageId, register: register, has: has, restoreOf: restoreOf, consume: consume, cancel: cancel, markTurnEnd: markTurnEnd, settleIdle: settleIdle, hasUnconfirmed: hasUnconfirmed, dropAll: dropAll, pending: pending, park: park, takeParked: takeParked, durable: durable, loadParked: loadParked };

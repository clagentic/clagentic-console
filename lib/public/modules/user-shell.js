// user-shell.js - the composer's ! command line on the page: the request a ! line
// becomes, the card that shows a command and its outcome, the chat queue that
// holds what is typed (chat and ! lines) while a turn or a command runs, and the
// settings the server sends.
// The server decides everything that matters (the setting, OS-user isolation,
// plan mode, the permission gate); this module sends the line and draws what
// comes back. Handlers are registered by app-messages.js.

import { store } from './store.js';
import { addToMessages, addSystemMessage, scrollToBottom } from './app-rendering.js';
import { setSendBtnMode } from './app-favicon.js';
import { buildCard, fillCard, showRunning } from './shell-card.js';
import { createChatQueue } from './shell-queue.js';
import { currentSendNowState, currentQueuedControls } from './send-now.js';
import { renderUserShellSettings } from './shell-settings-controls.js';
import { queuedButton } from './queued-button.js';

var STORAGE_KEY = "clagentic-console-shell-queue";
var IMAGE_NOTE = "[an image attachment of this message was not restored; attach it again]";

// requestId -> { scope, command, card }: commands sent from this page that have
// not finished. A request is entered only after its frame was sent.
var pending = new Map();
// What input.js supplies: the composer and the way a queued chat message is sent.
var composer = null;
var chatSender = null;
// Sends one frame; true when the socket took it.
var frameSender = null;
// Draws a delivered chat message as the normal user message.
var deliveredRenderer = null;
// messageId -> the chat messages sent into a running turn that the agent has
// not yet taken in, drawn as queued (oldest first). Unlike the entries of the
// queue below, these have already been sent: nothing here is ever sent again.
var inflight = new Map();
// Which socket sent each chat message still waiting, with its images. The server
// echoes a delivered message to every socket but the sender's, so a page whose
// item was redrawn after a session switch on that same socket gets no echo and
// has to draw the message itself.
var sentOn = new Map();
// Returns the page's current socket; compared by identity only.
var socketProbe = null;
// A draft set aside while a refused command is edited in the composer.
var setAside = null;
var lastScope = null;
// A busy refusal of a flushed command arrives after the page already reads idle, so
// no processing change follows to flush again. This timer retries instead, with a
// doubling delay up to a cap; it never runs as a tight loop.
var RETRY_BASE_MS = 500;
var RETRY_CAP_MS = 8000;
var retryTimer = null;
var retryCount = 0;

function cancelRetry() {
  if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
}

function armRetry() {
  cancelRetry();
  var delay = Math.min(RETRY_BASE_MS * Math.pow(2, retryCount), RETRY_CAP_MS);
  retryCount++;
  retryTimer = setTimeout(function () {
    retryTimer = null;
    flushQueuedChat();
  }, delay);
}

function currentScope() {
  return (store.get("currentSlug") || "") + ":" + String(store.get("activeSessionId"));
}

var sessionStore = {
  load: function () {
    try {
      var raw = window.sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.warn("[user-shell] could not read the saved queue:", (err && err.message) || err);
      return null;
    }
  },
  save: function (pairs) {
    try {
      if (pairs.length === 0) window.sessionStorage.removeItem(STORAGE_KEY);
      else window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pairs));
    } catch (err) {
      addSystemMessage("Queued messages could not be saved for a reload: " + ((err && err.message) || err), true);
    }
  },
};

// Send now on a queued ! entry follows the capability table: unavailable while a
// turn runs (aria-disabled, so a tap can still say why), usable when idle.
function paintSendNow(btn, kind) {
  var st = currentSendNowState(kind);
  var off = st.mode === "disabled";
  btn.classList.toggle("unavailable", off);
  btn.setAttribute("aria-disabled", off ? "true" : "false");
  btn.title = off ? "Send now (unavailable): " + st.reason : "Send now: run this command next";
}

function sendQueuedItemNow(entry) {
  var st = currentSendNowState(entry.kind);
  if (st.mode === "disabled") {
    addSystemMessage("Send now is unavailable: " + st.reason + ".", true);
    return;
  }
  chatQueue.promote(currentScope(), function (e) { return e.id === entry.id; });
  flushQueuedChat();
}

var chatQueue = createChatQueue({
  storage: sessionStore,
  show: function (entry) {
    var el = document.createElement("div");
    el.className = "shell-queued";
    var tag = document.createElement("span");
    tag.className = "shell-queued-tag";
    tag.textContent = "Queued";
    var body = document.createElement("span");
    body.className = "shell-queued-text";
    body.textContent = entry.kind === "shell" ? "!" + entry.command : entry.text || (entry.imageCount > 0 ? "[image]" : "[attachment]");
    el.appendChild(tag);
    el.appendChild(body);
    var handle = { el: el, tag: tag, refresh: null };
    if (entry.kind === "shell") {
      var actions = document.createElement("span");
      actions.className = "shell-queued-actions";
      var sendNowBtn = queuedButton("Send now", "shell-queued-send-now");
      sendNowBtn.addEventListener("click", function () { sendQueuedItemNow(entry); });
      var cancelBtn = queuedButton("Cancel", "shell-queued-cancel");
      cancelBtn.addEventListener("click", function () { chatQueue.remove(entry.id); });
      var editBtn = queuedButton("Edit", "shell-queued-edit");
      editBtn.addEventListener("click", function () {
        chatQueue.remove(entry.id);
        editRefusedCommand(entry.command);
      });
      actions.appendChild(sendNowBtn);
      actions.appendChild(editBtn);
      actions.appendChild(cancelBtn);
      el.appendChild(actions);
      handle.refresh = function () { paintSendNow(sendNowBtn, entry.kind); };
      handle.refresh();
    }
    addToMessages(el);
    scrollToBottom();
    return handle;
  },
  hide: function (handle) { handle.el.remove(); },
  markUnsent: function (handle, why) {
    handle.el.className = "shell-queued unsent";
    handle.tag.textContent = "Not sent";
    handle.el.setAttribute("title", "Not sent: " + why + ". It is sent when the connection is back.");
  },
});

/** Hands over the composer: read() its text, write(text) to replace it. */
export function registerComposer(c) { composer = c; }

/** Hands over how one queued chat entry is sent: send(entry) returns true when it was sent. */
export function registerChatSender(fn) { chatSender = fn; }

/** Hands over how a frame is sent: send(frame) returns true when the socket took it. */
export function registerFrameSender(fn) { frameSender = fn; }

/** Hands over how the page's current socket is read: probe() returns it. */
export function registerSocketProbe(fn) { socketProbe = fn; }

/** Hands over how a delivered chat message is shown: render({text, images, pastes}). */
export function registerDeliveredRenderer(fn) { deliveredRenderer = fn; }

/** Whether a ! line is sent as a command: the server's setting is on (the default). */
export function isShellModeOn() {
  var s = store.get("userShellSettings");
  return !s || s.enabled !== false;
}

/** Whether a command sent from this page, in the session on screen, has not finished. */
export function isShellPending() {
  var scope = currentScope();
  var found = false;
  pending.forEach(function (p) { if (p.scope === scope) found = true; });
  return found;
}

/** Whether anything (chat or a ! line) of the session on screen is waiting to be sent. */
export function hasQueuedChat() {
  return chatQueue.sizeFor(currentScope()) > 0;
}

/**
 * Ctrl/Cmd+Enter: the session's queued ! entries are set to run next, ahead of any
 * chat behind them, and the queue is flushed (they still wait for a running turn).
 */
export function runQueuedShellNext() {
  chatQueue.promote(currentScope(), function (e) { return e.kind === "shell"; });
  flushQueuedChat();
}

/**
 * Up from an empty composer: when everything queued for the session is a ! entry,
 * takes the LAST one out of the queue and returns it as a single "!" line for the
 * composer (the rest stay queued; Up again takes the next). One draft is one command,
 * so no path writes several queued entries into the composer. Returns null, and
 * changes nothing, otherwise.
 * @returns {?string}
 */
export function takeBackQueuedShell() {
  var mine = chatQueue.entriesFor(currentScope());
  if (mine.length === 0 || mine.some(function (e) { return e.kind !== "shell"; })) return null;
  var last = mine[mine.length - 1];
  chatQueue.remove(last.id);
  return "!" + last.command;
}

// ---------------------------------------------------------------- queued chat

// A random version-4 uuid. crypto.randomUUID exists only in a secure context and
// this page can be served over plain http, so getRandomValues (available in
// both) is used. Returns null when the page has no source of randomness, in
// which case the message is sent as it always was, not drawn as queued.
export function newMessageId() {
  var c = typeof window !== "undefined" ? window.crypto : null;
  if (!c || typeof c.getRandomValues !== "function") return null;
  var b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  var hex = Array.from(b, function (x) { return (x + 256).toString(16).slice(1); }).join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}

/**
 * Whether a chat message typed now is sent into the running turn and drawn as
 * queued until the agent takes it: a turn runs and the agent can withdraw a
 * message that is waiting. Otherwise it is shown as sent, as ever.
 */
export function chatQueuesWithAgent() {
  return !!store.get("processing") && currentQueuedControls("chat").cancel.enabled;
}

// Cancel, Edit and Send now of one chat item, painted from what the item and the
// agent allow now: delivered or mid-request items cannot be withdrawn, and the
// reason is in the title and stated on a tap (aria-disabled keeps the tap).
function paintInflight(item) {
  // After Send now the item is not queued any more: no label, no controls, until
  // the agent takes the message (message_delivered) or hands it back.
  paintSendNowState(item);
  if (item.sendNow) return;
  var controls = currentQueuedControls("chat");
  var why = "";
  if (item.delivered) why = "Already delivered to the agent.";
  else if (item.unconfirmed) why = "The agent may already be running it.";
  else if (item.action) why = "Working on it.";
  else if (!controls.cancel.enabled) why = controls.cancel.reason;
  item.withdrawBlocked = why;
  [["cancel", "Cancel", "Cancel: withdraw this message"], ["edit", "Edit", "Edit: withdraw it and edit it in the composer"]].forEach(function (b) {
    var btn = item.buttons[b[0]];
    btn.classList.toggle("unavailable", !!why);
    btn.setAttribute("aria-disabled", why ? "true" : "false");
    btn.title = why ? b[1] + " (unavailable): " + why : b[2];
  });
  var st = currentSendNowState("chat");
  var off = item.delivered || st.mode === "disabled";
  item.buttons.sendNow.classList.toggle("unavailable", off);
  item.buttons.sendNow.setAttribute("aria-disabled", off ? "true" : "false");
  item.buttons.sendNow.title = item.delivered
    ? "Send now (unavailable): Already delivered to the agent."
    : off ? "Send now (unavailable): " + st.reason
    : "Send now: this message is already with the agent and joins the turn at its next step";
}

function paintSendNowState(item) {
  if (!item.tagEl || !item.actionsEl) return;
  item.tagEl.textContent = item.sendNow ? "Sending" : "Queued";
  item.actionsEl.style.display = item.sendNow ? "none" : "";
}

function drawInflight(item) {
  var el = document.createElement("div");
  el.className = "shell-queued";
  var tag = document.createElement("span");
  tag.className = "shell-queued-tag";
  tag.textContent = "Queued";
  var body = document.createElement("span");
  body.className = "shell-queued-text";
  body.textContent = item.text || (item.imageCount > 0 ? "[image]" : "[attachment]");
  var actions = document.createElement("span");
  actions.className = "shell-queued-actions";
  var sendNowBtn = queuedButton("Send now", "shell-queued-send-now");
  var editBtn = queuedButton("Edit", "shell-queued-edit");
  var cancelBtn = queuedButton("Cancel", "shell-queued-cancel");
  sendNowBtn.addEventListener("click", function () { sendInflightNow(item); });
  editBtn.addEventListener("click", function () { withdrawInflight(item, "edit"); });
  cancelBtn.addEventListener("click", function () { withdrawInflight(item, "cancel"); });
  actions.appendChild(sendNowBtn);
  actions.appendChild(editBtn);
  actions.appendChild(cancelBtn);
  el.appendChild(tag);
  el.appendChild(body);
  el.appendChild(actions);
  item.el = el;
  item.tagEl = tag;
  item.actionsEl = actions;
  item.buttons = { sendNow: sendNowBtn, edit: editBtn, cancel: cancelBtn };
  paintInflight(item);
  addToMessages(el);
  scrollToBottom();
}

function removeInflight(item) {
  inflight.delete(item.messageId);
  sentOn.delete(item.messageId);
  if (item.el && item.el.remove) item.el.remove();
}

// The composer text for a queued chat handed back: its text and pastes as one
// entry, with the note that attached images are not restored.
function queuedRestoreText(text, pastes, imageCount) {
  var restoreText = [text].concat(pastes || []).filter(Boolean).join("\n\n");
  if (imageCount > 0) restoreText = restoreText ? restoreText + "\n" + IMAGE_NOTE : IMAGE_NOTE;
  return restoreText;
}

/**
 * A chat message was sent into the running turn: draws it as queued, with its
 * controls, until the agent takes it in (message_delivered).
 * @param {{messageId: string, text: string, images: Array, pastes: Array<string>}} message
 */
export function trackSentChat(message) {
  sentOn.set(message.messageId, { socket: socketProbe ? socketProbe() : null, images: message.images });
  addInflight(message.messageId, message.text, message.images, message.pastes, message.images.length, false, false);
}

function addInflight(messageId, text, images, pastes, imageCount, unconfirmed, sendNow) {
  var item = {
    messageId: messageId,
    scope: currentScope(),
    text: text,
    images: images,
    pastes: pastes,
    imageCount: imageCount,
    restoreText: queuedRestoreText(text, pastes, imageCount),
    action: null,
    delivered: false,
    unconfirmed: unconfirmed,
    // Send now was pressed (here, on another page, or before a reload): the item is
    // drawn as sending and is never drawn queued again.
    sendNow: !!sendNow,
    // Set for an item drawn from the server's word rather than from a send on this
    // page: the transcript gets the message itself when the agent takes it in.
    redrawn: false,
    el: null,
    buttons: null,
  };
  inflight.set(item.messageId, item);
  drawInflight(item);
  return item;
}

/**
 * queued_message_tracked: the server says a chat message is still waiting for the
 * agent, on a page that holds no queued item of its own (it was reloaded, or this
 * is a second tab). Draws it as queued again with its controls. When the agent
 * takes it in, every socket but the sender's gets the message itself, so delivery
 * here only removes the item. The sender's own socket (a switch away and back)
 * gets no echo: its item draws the message on delivery.
 */
export function handleQueuedMessageTracked(msg) {
  if (inflight.has(msg.messageId) || typeof msg.text !== "string") return;
  var sent = sentOn.get(msg.messageId);
  var echoed = !(sent && socketProbe && sent.socket !== null && sent.socket === socketProbe());
  var item = addInflight(msg.messageId, msg.text, echoed ? [] : sent.images, Array.isArray(msg.pastes) ? msg.pastes : [], msg.imageCount | 0, !!msg.unconfirmed, msg.sendNow === true);
  item.redrawn = echoed;
}

// Asks the server to withdraw a queued chat message. What follows (the text in
// the composer for Edit and take-back) happens only on its answer, so a message
// the agent already took is never both delivered and handed back.
function withdrawInflight(item, action) {
  if (item.withdrawBlocked) {
    addSystemMessage((action === "cancel" ? "Cancel" : action === "edit" ? "Edit" : "Take back") + " is unavailable: " + item.withdrawBlocked, true);
    return false;
  }
  if (!frameSender || !frameSender({ type: "cancel_queued_message", messageId: item.messageId })) {
    addSystemMessage("Not connected: the message could not be withdrawn.", true);
    return false;
  }
  item.action = action;
  paintInflight(item);
  return true;
}

// Send now on a message that is already with the agent: it was pushed the moment
// it was sent, so nothing is sent again, never a second copy. The server
// interrupts the running turn with the agent's queue kept, so the message runs as
// the next input at once. The item is drawn as sending from the press on, which
// also makes a second press a no-op; the server's answer undoes that only when
// nothing was interrupted.
function sendInflightNow(item) {
  var st = currentSendNowState("chat");
  if (item.delivered) {
    addSystemMessage("Send now is unavailable: Already delivered to the agent.", true);
  } else if (st.mode === "disabled") {
    addSystemMessage("Send now is unavailable: " + st.reason, true);
  } else if (item.sendNow) {
    return;
  } else if (!frameSender || !frameSender({ type: "send_now_queued_message", messageId: item.messageId })) {
    addSystemMessage("Not connected: Send now could not be sent.", true);
  } else {
    item.sendNow = true;
    paintInflight(item);
    addSystemMessage("Interrupting the running turn so this message runs now.", false);
  }
}

/**
 * queued_message_send_now: the server's answer to Send now, or word from another
 * page of the session that it was pressed. Only a request that interrupted nothing
 * draws the item as queued again, with the reason; a miss arrives as a dropped reply.
 */
export function handleQueuedMessageSendNow(msg) {
  var item = inflight.get(msg.messageId);
  if (!item) return;
  if (msg.result === "requested") {
    item.sendNow = true;
    paintInflight(item);
    return;
  }
  if (msg.result === "already_delivered") {
    // Delivery follows, or came first and the item is gone; nothing was interrupted.
    item.delivered = true;
    paintInflight(item);
    return;
  }
  if (msg.result === "missed") return;
  item.sendNow = false;
  paintInflight(item);
  addSystemMessage(msg.result === "no_turn"
    ? "No turn is running, so there is nothing to interrupt. The message is with the agent and starts when it can."
    : "Send now did not take effect" + (msg.message ? ": " + msg.message : ".") + " The message is still queued.", true);
}

/**
 * Up from an empty composer takes back ONE queued entry, never several joined:
 * the last queued ! entry while any is waiting on this page (and nothing else
 * is held here), otherwise the last chat message still waiting to be delivered.
 * A chat message is withdrawn at the agent first; its text reaches the composer
 * only if the agent confirms it dropped it. Returns false, and changes nothing,
 * when there is nothing to take back.
 * @param {function(string): void} write  puts the entry's text in the composer
 * @returns {boolean} whether a take-back was started
 */
export function takeBackLastQueued(write) {
  if (chatQueue.sizeFor(currentScope()) > 0) {
    var line = takeBackQueuedShell();
    if (line === null) return false;
    write(line);
    return true;
  }
  var scope = currentScope();
  var waiting = Array.from(inflight.values()).filter(function (it) { return it.scope === scope && !it.delivered && !it.unconfirmed && !it.action && !it.sendNow; });
  if (waiting.length === 0) return false;
  return withdrawInflight(waiting[waiting.length - 1], "takeback");
}

/** message_delivered: the agent took the message in. The queued item becomes the normal message, once. */
export function handleMessageDelivered(msg) {
  var item = inflight.get(msg.messageId);
  if (!item) {
    // Delivered while this page showed another session: the message is over, so
    // the sender record kept for a switch back has no more use.
    sentOn.delete(msg.messageId);
    settleMissedDelivery(msg.messageId, true);
    return;
  }
  removeInflight(item);
  if (!item.redrawn && deliveredRenderer) deliveredRenderer({ text: item.text, images: item.images, pastes: item.pastes });
}

// Send now receipt misses: messageId -> {scope, restoreText, notice, message, draw,
// delivered}. The SDK may have taken the message into the interrupted turn before
// the receipt was read, so its delivery can still follow the miss. The record
// belongs to the session that sent the message and touches only that session's page.
var missedBySendNow = new Map();

// message: {text, images, pastes}; draw: whether this page draws the delivered
// message itself (no server echo reaches the sending socket).
function noteSendNowMiss(messageId, scope, restoreText, message, draw) {
  var notice = addSystemMessage(droppedNotice("send_now_missed"), true);
  missedBySendNow.set(messageId, { scope: scope, restoreText: restoreText, notice: notice, message: message, draw: draw, delivered: false });
}

// The message ran after all: the restore notice is replaced, the message is drawn
// like a normal delivery, and the composer is cleared only while it still holds
// exactly the restored text. Never sends anything. A record of another session
// stays pending (marked delivered) until that session is on screen again, where
// the replayed history already holds the message (fromReplay: nothing to draw).
function settleMissedDelivery(messageId, live, fromReplay) {
  var missed = missedBySendNow.get(messageId);
  if (!missed) return;
  if (missed.scope !== currentScope()) {
    if (live) missed.delivered = true;
    return;
  }
  missedBySendNow.delete(messageId);
  if (missed.notice && missed.notice.remove) missed.notice.remove();
  if (composer && missed.restoreText && composerText() === missed.restoreText) composer.write("");
  if (!fromReplay && missed.draw && deliveredRenderer) deliveredRenderer(missed.message);
  addSystemMessage("This message was delivered after all, so it ran. It is no longer in your composer.", false);
}

// A session is on screen again with its history replayed: its missed records whose
// delivery arrived meanwhile are settled now.
function settleMissedOfShownSession() {
  Array.from(missedBySendNow.keys()).forEach(function (id) {
    if (missedBySendNow.get(id).delivered) settleMissedDelivery(id, false, true);
  });
}

// What a dropped message's notice says, by the cause the server names.
function droppedNotice(cause) {
  if (cause === "send_now_missed") return "Send now interrupted the turn, but the agent no longer held this message, so it was not sent. It is back in your composer.";
  if (cause === "not_taken") return "The agent did not run this message, so it was not sent. It is back in your composer.";
  return "The session ended before this message was delivered, so it was not sent. It is back in your composer.";
}

/** The server's answer to a withdraw request, or word that the turn ended with the message untaken. */
export function handleQueuedMessageCancelled(msg) {
  var item = inflight.get(msg.messageId);
  if (!item) {
    // Whether this socket sent the message: if not, the server's echo draws it.
    var sentHere = sentOn.get(msg.messageId);
    var ownSend = !!(sentHere && socketProbe && sentHere.socket !== null && sentHere.socket === socketProbe());
    // Only a final answer ends the message: a pending or already_delivered one
    // leaves it live, and the record is still needed if its item is drawn again.
    if (msg.result === "cancelled" || msg.result === "dropped") sentOn.delete(msg.messageId);
    // The page no longer holds the queued item (a session switch or a reload),
    // but the server confirmed the message will not be delivered and sent its
    // text: it goes back to the composer as one entry, never lost.
    if ((msg.result === "cancelled" || msg.result === "dropped") && typeof msg.text === "string") {
      var back = queuedRestoreText(msg.text, msg.pastes, msg.imageCount | 0);
      if (back) {
        putInComposer(back);
        if (msg.cause === "send_now_missed") {
          noteSendNowMiss(msg.messageId, currentScope(), back, { text: msg.text, images: ownSend ? sentHere.images : [], pastes: Array.isArray(msg.pastes) ? msg.pastes : [] }, ownSend);
        }
        else addSystemMessage("A message you queued was not delivered. It is back in your composer.", true);
      }
    }
    return;
  }
  var action = item.action;
  item.action = null;
  if (msg.result === "cancelled") {
    removeInflight(item);
    // Edit and take-back both hand the one entry to the composer; a draft typed
    // meanwhile is set aside, not overwritten.
    if (action === "edit" || action === "takeback") putInComposer(item.restoreText);
    return;
  }
  if (msg.result === "dropped") {
    removeInflight(item);
    putInComposer(item.restoreText);
    if (msg.cause === "send_now_missed") {
      noteSendNowMiss(item.messageId, item.scope, item.restoreText, { text: item.text, images: item.images, pastes: item.pastes }, !item.redrawn);
    }
    else addSystemMessage(droppedNotice(msg.cause), true);
    return;
  }
  if (msg.result === "pending") {
    // The agent did not drop it, and cannot say whether it runs. It stays
    // queued: delivery turns it into the normal message, otherwise a dropped
    // reply follows with its text.
    item.unconfirmed = true;
    paintInflight(item);
    addSystemMessage(action
      ? "The agent could not confirm the withdrawal. The message stays queued; if the agent does not run it, it comes back to your composer."
      : "Withdrawing another message may have dropped this one too. It stays queued; if the agent does not run it, it comes back to your composer.", false);
    return;
  }
  if (msg.result === "already_delivered") {
    // The server no longer tracks it. Usually the agent has it and the delivery
    // event follows (or came first, and the item is already gone); the same
    // result also answers an id cancelled earlier or unknown, where none follows.
    // Nothing is handed back, so nothing is doubled.
    item.delivered = true;
    paintInflight(item);
    addSystemMessage("This message can no longer be cancelled.", false);
    return;
  }
  paintInflight(item);
  addSystemMessage("The message could not be withdrawn" + (msg.message ? ": " + msg.message : ".") + " It is still queued.", true);
}

/** Whether a turn of the session on screen is running. */
export function isTurnRunning() {
  return !!store.get("processing");
}

function restoreSendButton() {
  setSendBtnMode(store.get("processing") || isShellPending() ? "stop" : "send");
}

function newRequestId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return String(Date.now()) + Math.random().toString(36).slice(2);
}

/**
 * Sends a command and, only once the frame was sent, draws its card and marks it
 * pending. A frame that was not sent leaves nothing pending, so later chat is
 * never held for a command the server never saw.
 * @param {string} command
 * @param {function(object): boolean} transmit - sends a frame; true when sent
 * @returns {boolean} whether the request was sent
 */
export function sendShellCommand(command, transmit) {
  var requestId = newRequestId();
  var payload = { type: "shell", command: command, requestId: requestId };
  var vendor = store.get("currentVendor");
  if (vendor) payload.vendor = vendor;
  if (!transmit(payload)) return false;
  var card = buildCard(command, "pending");
  showRunning(card);
  addToMessages(card);
  scrollToBottom();
  pending.set(requestId, { scope: currentScope(), command: command, card: card });
  setSendBtnMode("stop");
  return true;
}

/**
 * Keeps a chat message typed while a command runs (or while an earlier message
 * is still unsent), shown as queued. It is sent in order by flushQueuedChat.
 * @param {{text: string, images: Array, pastes: Array<string>, steerNow: boolean}} message
 */
export function queueChatMessage(message) {
  var restoreText = [message.text].concat(message.pastes).filter(Boolean).join("\n\n");
  if (message.images.length > 0) restoreText = restoreText ? restoreText + "\n" + IMAGE_NOTE : IMAGE_NOTE;
  chatQueue.add({
    scope: currentScope(),
    text: message.text,
    images: message.images,
    pastes: message.pastes,
    steerNow: message.steerNow,
    imageCount: message.images.length,
    restoreText: restoreText,
  });
}

/**
 * Keeps a ! line typed while a turn runs, while a command is pending, or behind
 * earlier queued entries, shown as queued. It is sent in order by flushQueuedChat.
 * @param {string} command - the line after the "!", as parseShellLine returns it
 */
export function queueShellCommand(command) {
  chatQueue.add(shellItem(command, currentScope()));
}

function shellItem(command, scope) {
  return { scope: scope, kind: "shell", command: command, text: command, imageCount: 0, restoreText: "!" + command };
}

/** Whether a turn or a command of this session must end before the entry can be sent. */
function mustWaitFor(entry) {
  if (isShellPending()) return true;
  return entry.kind === "shell" && isTurnRunning();
}

/**
 * Sends the session's queued entries, one at a time in order: chat goes at once, a
 * ! entry only when no turn is running, and anything behind a ! entry only after
 * its result.
 * Called when a command ends, when the page has rebuilt a session, and before
 * any new chat is sent while an earlier message is still unsent.
 */
export function flushQueuedChat() {
  // Any flush supersedes a pending retry; a busy refusal arms a new one.
  cancelRetry();
  if (!chatSender || store.get("replayingHistory") || !store.get("connected")) return;
  chatQueue.flush(currentScope(), chatSender, function (entry) { return !mustWaitFor(entry); });
}

function composerText() { return composer ? composer.read() : ""; }

// Edit on a refused command: the command goes back to the composer. A draft
// already there is set aside, not overwritten (and not run: the draft is never
// placed behind a "!"), and returns to the composer after the next send.
function editRefusedCommand(command) {
  putInComposer("!" + command);
}

// Puts one queued entry's text in the composer for editing. A draft already
// there is set aside, never joined to it, so the composer holds one entry.
function putInComposer(text) {
  if (!composer) return;
  var draft = composerText();
  if (draft.trim() && draft !== text) {
    setAside = { scope: currentScope(), text: setAside ? setAside.text + "\n\n" + draft : draft };
    addSystemMessage("Your draft was set aside while you edit. It comes back in the composer after you send.", false);
  }
  composer.write(text);
}

/** After a send: puts a draft that was set aside by an Edit back in the empty composer. */
export function restoreSetAsideDraft() {
  if (!setAside || !composer || composerText().trim()) return;
  var text = setAside.text;
  setAside = null;
  composer.write(text);
}

export function handleShellResult(msg) {
  var entry = pending.get(msg.requestId);
  pending.delete(msg.requestId);
  var card = entry ? entry.card : null;
  // A command the server refused as busy (a turn started first) is not an answer
  // to show: it goes back to the head of the queue and is sent when the session is
  // next free. The server's refusal stays as the backstop; the page never shows it.
  if (entry && msg.refused && msg.reason === "busy" && !store.get("replayingHistory")) {
    if (card && card.remove) card.remove();
    chatQueue.addFirst(shellItem(entry.command, entry.scope), true);
    scrollToBottom();
    restoreSendButton();
    armRetry();
    return;
  }
  retryCount = 0;
  if (!card) {
    card = buildCard(msg.command, "pending");
    addToMessages(card);
  }
  fillCard(card, msg, { onEdit: editRefusedCommand });
  scrollToBottom();
  if (!store.get("replayingHistory")) restoreSendButton();
  // Whatever way the command ended (result, refusal, denial, error, timeout or
  // stop) it arrives here, and what was typed meanwhile goes now, in order.
  if (entry) flushQueuedChat();
}

/**
 * The server put a session on screen (first load, a switch or a reconnect), and
 * the transcript was cleared. Queued chat of a session left behind is parked as
 * text; what is parked for this session goes back in front of its draft.
 * @param {HTMLTextAreaElement} inputEl - the composer, already holding the session's draft
 */
export function handleSessionShown(inputEl) {
  var scope = currentScope();
  if (lastScope !== null && lastScope !== scope) {
    // A result for a command of a session left behind is not sent to this page.
    pending.forEach(function (p, id) { if (p.scope !== scope) pending.delete(id); });
    if (setAside && setAside.scope !== scope) {
      chatQueue.park(setAside.scope, setAside.text);
      setAside = null;
    }
  }
  lastScope = scope;
  cancelRetry();
  retryCount = 0;
  chatQueue.leave(scope);
  chatQueue.forgetDrawn();
  // The transcript is rebuilt from the server's history, which has every message
  // the agent took in. What was still waiting is drawn again from the server's
  // queued_message_tracked frames, which follow the replay.
  inflight.clear();
  pending.forEach(function (p) { p.card = null; });
  var back = chatQueue.takeParked(scope);
  if (back.some(function (b) { return b.kind === "shell"; })) {
    // A ! line must stay a command of its own: the entries go back in the queue,
    // in typed order, not into the composer where they would join into one line.
    var drafts = [];
    var items = [];
    back.forEach(function (b) {
      if (b.kind === "shell") items.push(shellItem(b.command, scope));
      else if (b.kind === "draft") drafts.push(b.text);
      else items.push({ scope: scope, kind: "chat", text: b.text, images: [], pastes: [], steerNow: false, imageCount: 0, restoreText: b.text });
    });
    chatQueue.restore(items);
    if (inputEl.value) drafts.push(inputEl.value);
    inputEl.value = drafts.join("\n\n");
  } else if (back.length > 0) {
    var texts = back.map(function (b) { return b.text; });
    if (inputEl.value) texts.push(inputEl.value);
    inputEl.value = texts.join("\n\n");
  }
}

/**
 * The session's history has been replayed, so the transcript is whole: puts back
 * what the page holds that history cannot (a running command's card, queued
 * chat), and resumes the queue if the command it waited for is done.
 */
export function handleHistoryReplayed() {
  var scope = currentScope();
  pending.forEach(function (p) {
    if (p.scope !== scope || p.card) return;
    p.card = buildCard(p.command, "pending");
    showRunning(p.card);
    addToMessages(p.card);
  });
  chatQueue.draw(scope);
  settleMissedOfShownSession();
  scrollToBottom();
  restoreSendButton();
  flushQueuedChat();
}

export function handleUserShellSettings(msg) {
  store.set({
    userShellSettings: {
      enabled: msg.userShellEnabled !== false,
      timeoutMinutes: msg.userShellTimeoutMinutes,
      maxOutputKiB: msg.userShellMaxOutputKiB,
    },
  });
  renderUserShellSettings();
}

// A turn ending releases what was typed meanwhile (a ! entry waits for it).
store.subscribe(["processing"], function (state, prev) {
  chatQueue.eachDrawn(function (e) { if (e.handle && e.handle.refresh) e.handle.refresh(); });
  inflight.forEach(paintInflight);
  if (prev.processing && !state.processing) flushQueuedChat();
});

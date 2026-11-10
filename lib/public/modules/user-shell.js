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
import { renderUserShellSettings } from './shell-settings-controls.js';

var STORAGE_KEY = "clagentic-console-shell-queue";
var IMAGE_NOTE = "[an image attachment of this message was not restored; attach it again]";

// requestId -> { scope, command, card }: commands sent from this page that have
// not finished. A request is entered only after its frame was sent.
var pending = new Map();
// What input.js supplies: the composer and the way a queued chat message is sent.
var composer = null;
var chatSender = null;
// A draft set aside while a refused command is edited in the composer.
var setAside = null;
var lastScope = null;

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
    addToMessages(el);
    scrollToBottom();
    return { el: el, tag: tag };
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
  if (!chatSender || store.get("replayingHistory") || !store.get("connected")) return;
  chatQueue.flush(currentScope(), chatSender, function (entry) { return !mustWaitFor(entry); });
}

function composerText() { return composer ? composer.read() : ""; }

// Edit on a refused command: the command goes back to the composer. A draft
// already there is set aside, not overwritten (and not run: the draft is never
// placed behind a "!"), and returns to the composer after the next send.
function editRefusedCommand(command) {
  if (!composer) return;
  var draft = composerText();
  if (draft.trim() && draft !== "!" + command) {
    setAside = { scope: currentScope(), text: setAside ? setAside.text + "\n\n" + draft : draft };
    addSystemMessage("Your draft was set aside while you edit the command. It comes back in the composer after you send.", false);
  }
  composer.write("!" + command);
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
    return;
  }
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
  chatQueue.leave(scope);
  chatQueue.forgetDrawn();
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
  if (prev.processing && !state.processing) flushQueuedChat();
});

// agent-messages.js - the Team view's agent-messages section: the agent-to-agent
// traffic that went through the console (open-session, send-input, scheduled
// input, replies), as a map of who talks to whom and a thread per pair.
//
// Read-only. The server (lib/team-traffic.js) builds the snapshot from the
// outbound ledger under the ledger's own read rules and sends it when this
// connection asks; nothing is kept here except the last snapshot, so a reload or
// a daemon restart rebuilds the same view. A team_traffic_changed message
// carries no content; it only makes the section ask again.

import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { registerTeamSection, closeTeamView } from './team-view.js';
import { isMobileViewport } from './popover-position.js';
import { resolveInjectedIdentity } from './injected-identity.js';
import { relativeTime } from './relative-time.js';

var SECTION_ID = "agent-messages";
var AVATAR_SIZE = 24;
var REQUEST_GAP_MS = 1000;

var snapshot = null;
var selectedKey = null;
var activeContainer = null;
var lastRequestAt = 0;
var trailingTimer = null;
var openSessionFn = null;
var knownAgentsFn = function () { return []; };

// --- Transport ---

// Every request is held to REQUEST_GAP_MS. A request inside the gap is not
// dropped (the nudge would be lost): one trailing request is scheduled for when
// the gap ends, and only if the section is still on screen by then.
function requestTraffic() {
  var now = Date.now();
  var wait = REQUEST_GAP_MS - (now - lastRequestAt);
  if (wait > 0) {
    if (!trailingTimer) {
      trailingTimer = setTimeout(function () {
        trailingTimer = null;
        if (releaseIfClosed()) requestTraffic();
      }, wait);
      if (trailingTimer && typeof trailingTimer.unref === "function") trailingTimer.unref();
    }
    return;
  }
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return;
  lastRequestAt = now;
  ws.send(JSON.stringify({ type: "team_traffic_request" }));
}

// --- Text ---

var KIND_LABEL = { open: "open", input: "input", scheduled: "scheduled", reply: "reply", loop: "loop" };

export function emptyStateText(snap) {
  if (!snap) return "Loading agent messages.";
  if (snap.ok === false) return "Agent messages could not be read: " + (snap.reason || "unknown error") + ".";
  if (snap.note) return snap.note.charAt(0).toUpperCase() + snap.note.slice(1) + ".";
  var withheld = snap.withheld || { count: 0, reasons: [] };
  if (withheld.count > 0) {
    var why = withheld.reasons && withheld.reasons.length ? ": " + withheld.reasons.join("; ") : "";
    return withheld.count + (withheld.count === 1 ? " message is" : " messages are") + " withheld from you" + why + ".";
  }
  return "No agent messages recorded yet. Messages one session sends another with open-session, send-input and scheduled input appear here.";
}

function endpointLabel(target) {
  var who = target.name || target.agent || "session";
  return target.project ? who + "@" + target.project : who;
}

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function avatarOf(identity) {
  var img = el("img", "am-avatar");
  img.src = identity.avatarUrl;
  img.alt = "";
  img.width = AVATAR_SIZE;
  img.height = AVATAR_SIZE;
  return img;
}

function senderIdentity(sender) {
  return resolveInjectedIdentity(sender, "injected:" + (sender.initiator || "unknown"), knownAgentsFn(), AVATAR_SIZE);
}

function targetIdentity(target) {
  return resolveInjectedIdentity({ senderKind: "extracted", fromName: endpointLabel(target), senderAgent: target.agent }, undefined, knownAgentsFn(), AVATAR_SIZE);
}

function timeText(ts) {
  return ts ? relativeTime(ts) : "";
}

function senderLabel(pair) {
  var id = senderIdentity(pair.sender);
  var unverified = pair.sender.attribution === "unverified" ? " (unverified)" : "";
  return { identity: id, text: id.name + unverified };
}

// --- Views ---

function renderPairRow(pair, onSelect) {
  var row = el("button", "am-pair" + (pair.key === selectedKey ? " selected" : ""));
  row.setAttribute("type", "button");
  row.setAttribute("data-pair-key", pair.key);
  var from = senderLabel(pair);
  row.appendChild(avatarOf(from.identity));
  row.appendChild(el("span", "am-pair-name", from.text));
  row.appendChild(el("span", "am-arrow", "→"));
  row.appendChild(avatarOf(targetIdentity(pair.target)));
  row.appendChild(el("span", "am-pair-name", endpointLabel(pair.target)));
  row.appendChild(el("span", "am-count", String(pair.count)));
  if (pair.lastAt) row.appendChild(el("span", "am-last", timeText(pair.lastAt)));
  if (pair.pendingCount > 0) row.appendChild(el("span", "am-chip pending", pair.pendingCount + " pending"));
  row.addEventListener("click", function () { onSelect(pair.key); });
  return row;
}

function sessionLinkButton(label, link) {
  var btn = el("button", "am-link", label);
  btn.setAttribute("type", "button");
  btn.addEventListener("click", function () {
    if (typeof openSessionFn === "function") openSessionFn(link.project, link.id);
    closeTeamView();
  });
  return btn;
}

function renderMessage(pair, msg) {
  var item = el("div", "am-message");
  item.setAttribute("data-kind", msg.kind);
  var head = el("div", "am-message-head");
  head.appendChild(avatarOf(senderLabel(pair).identity));
  head.appendChild(el("span", "am-sender", senderLabel(pair).text));
  head.appendChild(el("span", "am-chip kind", KIND_LABEL[msg.kind] || msg.kind));
  var when = el("span", "am-time", timeText(msg.ts));
  when.title = msg.ts;
  head.appendChild(when);
  head.appendChild(el("span", "am-chip result " + msg.result, msg.result + (msg.reason ? ": " + msg.reason : "")));
  item.appendChild(head);
  if (msg.contextNote) item.appendChild(el("div", "am-note", msg.contextNote));
  var text = msg.text === null ? "(no text recorded)" : msg.text + (msg.truncated ? "\n[text cut]" : "");
  item.appendChild(el("div", "am-text", text));
  var links = el("div", "am-links");
  if (pair.sender.link) links.appendChild(sessionLinkButton("Sender session", pair.sender.link));
  if (pair.target.link) links.appendChild(sessionLinkButton("Target session", pair.target.link));
  if (pair.sender.link || pair.target.link) item.appendChild(links);
  return item;
}

function renderPending(pair, p) {
  var item = el("div", "am-message pending");
  item.setAttribute("data-kind", "scheduled");
  var head = el("div", "am-message-head");
  head.appendChild(el("span", "am-sender", senderLabel(pair).text));
  head.appendChild(el("span", "am-chip kind", "scheduled"));
  head.appendChild(el("span", "am-chip pending", "pending"));
  var next = p.nextAt ? "next " + new Date(p.nextAt).toLocaleString() : "";
  head.appendChild(el("span", "am-time", next));
  item.appendChild(head);
  if (p.createdBy) item.appendChild(el("div", "am-note", "scheduled by " + p.createdBy));
  item.appendChild(el("div", "am-text", p.text === null ? "(no text)" : p.text + (p.truncated ? "\n[text cut]" : "")));
  return item;
}

function renderThread(container, pair, onBack) {
  var thread = el("div", "am-thread");
  var head = el("div", "am-thread-head");
  if (onBack) {
    var back = el("button", "am-back", "Back");
    back.setAttribute("type", "button");
    back.addEventListener("click", onBack);
    head.appendChild(back);
  }
  head.appendChild(el("span", "am-thread-title", senderLabel(pair).text + " → " + endpointLabel(pair.target)));
  thread.appendChild(head);

  var shown = (snapshot.messages || []).filter(function (m) { return m.pairKey === pair.key; });
  shown.forEach(function (m) { thread.appendChild(renderMessage(pair, m)); });
  (snapshot.pending || []).filter(function (p) { return p.pairKey === pair.key; }).forEach(function (p) {
    thread.appendChild(renderPending(pair, p));
  });
  if (snapshot.messagesTruncated > 0) {
    thread.appendChild(el("div", "am-footnote", snapshot.messagesTruncated + " older messages are not listed."));
  }
  container.appendChild(thread);
}

function selectedPair() {
  var pairs = (snapshot && snapshot.pairs) || [];
  for (var i = 0; i < pairs.length; i++) if (pairs[i].key === selectedKey) return pairs[i];
  return null;
}

function paint(container) {
  container.innerHTML = "";
  var pairs = snapshot && snapshot.ok !== false ? snapshot.pairs || [] : [];
  if (!pairs.length) {
    var empty = el("div", "am-empty", emptyStateText(snapshot));
    empty.setAttribute("data-empty", "true");
    container.appendChild(empty);
    return;
  }
  if (selectedKey && !selectedPair()) selectedKey = null;

  function select(key) {
    selectedKey = key;
    paint(container);
  }
  function back() {
    selectedKey = null;
    paint(container);
  }

  var phone = isMobileViewport();
  var layout = el("div", "am-layout" + (phone ? " phone" : ""));
  var pair = selectedPair();

  if (!(phone && pair)) {
    var map = el("div", "am-map");
    map.appendChild(el("div", "team-section-header", "Who talks to whom"));
    pairs.forEach(function (p) { map.appendChild(renderPairRow(p, select)); });
    layout.appendChild(map);
  }
  if (pair) {
    renderThread(layout, pair, phone ? back : null);
  } else if (!phone) {
    layout.appendChild(el("div", "am-hint", "Select a pair to read its messages."));
  }
  container.appendChild(layout);

  var withheld = snapshot.withheld || { count: 0, reasons: [] };
  if (withheld.count > 0) {
    container.appendChild(el("div", "am-footnote", emptyStateText({ ok: true, withheld: withheld })));
  }
}

function renderSection(container) {
  activeContainer = container;
  paint(container);
  requestTraffic();
}

registerTeamSection({ id: SECTION_ID, title: "Agent messages", render: renderSection });

// --- Exports ---

/**
 * opts.openSession(project, id): show a session of the console (the caller owns
 * how a project switch happens). opts.knownAgents(): the project's agents, for
 * the avatar lookup shared with injected messages.
 */
export function initAgentMessages(opts) {
  opts = opts || {};
  if (typeof opts.openSession === "function") openSessionFn = opts.openSession;
  if (typeof opts.knownAgents === "function") knownAgentsFn = opts.knownAgents;
  store.subscribe(["connected"], function (state, prev) {
    if (state.connected && !prev.connected && releaseIfClosed()) requestTraffic();
  });
}

export function handleTeamTraffic(msg) {
  snapshot = msg;
  if (releaseIfClosed()) paint(activeContainer);
}

// The registry has no close hook, so the section checks that the container it
// last drew into is still on screen: detached by a tab switch or re-render, or
// inside the hidden Team view.
function containerIsShown() {
  if (!activeContainer) return false;
  if (activeContainer.isConnected === false) return false;
  for (var node = activeContainer; node; node = node.parentNode) {
    if (node.classList && node.classList.contains("hidden")) return false;
  }
  return true;
}

function releaseIfClosed() {
  if (activeContainer && !containerIsShown()) activeContainer = null;
  return !!activeContainer;
}

export function handleTeamTrafficChanged() {
  if (releaseIfClosed()) requestTraffic();
}

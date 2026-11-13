// agent-roster.js - the Team view's agent roster: every agent identity the
// console has seen (a session's agent, a sub-agent a Task or Agent call named,
// an injected sender), with first and last seen, where it was seen, and an
// avatar the operator can change.
//
// The server (lib/agent-roster.js) owns the roster. It sends agent_roster on
// connect and on request, limited to the projects this connection may read, and
// nudges every client with agent_roster_changed after a change; the client then
// asks again, so the section updates live and a reload or daemon restart rebuilds
// the same view. Choosing an avatar sends agent_avatar_set; the nudge brings the
// new roster back, and agent-avatar.js redraws each avatar on the page, not just
// this section's.

import { getWs } from "./ws-ref.js";
import { registerTeamSection, isSectionContainerShown } from "./team-view.js";
import { relativeTime } from "./relative-time.js";
import { setAgentAvatars, refreshAgentAvatars, createAgentAvatar, agentAvatarChoice } from "./agent-avatar.js";
import { buildAvatarPicker } from "./agent-avatar-picker.js";
import { GROUPS, partitionRoster, buildRowAvatar, buildGroupSection } from "./agent-roster-groups.js";
import { VENDOR_AVATARS } from "./vendor-registry.js";
import { setClaudeModelFamilies } from "./model-families.js";
import { refreshIcons } from "./icons.js";

var SECTION_ID = "agent-roster";
var AVATAR_SIZE = 40;

// The two lower groups start collapsed; what the operator opens stays open
// across redraws.
var expandedGroups = Object.create(null);

var agents = null;
var pickerKey = null;
var failure = null;
var activeContainer = null;

var SOURCE_LABEL = { session: "session agent", subagent: "sub-agent", sender: "sender" };

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function send(payload) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

export function emptyStateText(list) {
  if (list === null) return "Loading the agent roster.";
  return "No agents seen yet. An agent appears here once it runs a session, is started as a sub-agent, or sends input to a session.";
}

export function placeText(place) {
  var where = [];
  if (place.project) where.push(place.project);
  return (SOURCE_LABEL[place.source] || place.source) + (where.length ? " in " + where.join(", ") : "");
}

function timeText(ts) {
  return ts ? relativeTime(ts) : "";
}

// --- Views ---

function choose(key, ref) {
  failure = null;
  send({ type: "agent_avatar_set", key: key, avatar: ref });
}

// The logo of a model's vendor is the agent registry's icon for that vendor.
var avatarDeps = {
  chosen: function (key) { return !!agentAvatarChoice(key); },
  plain: function (key, size) { return createAgentAvatar(key, size, "ar-avatar"); },
  logoFor: function (vendor) { return VENDOR_AVATARS[vendor] || null; },
};

function buildAvatar(agent) {
  return buildRowAvatar(agent, AVATAR_SIZE, avatarDeps);
}

function renderRow(agent) {
  var open = agent.key === pickerKey;
  var row = el("div", "ar-row" + (open ? " open" : ""));
  row.setAttribute("data-agent-key", agent.key);

  var head = el("div", "ar-head");
  head.appendChild(buildAvatar(agent));

  var main = el("div", "ar-main");
  main.appendChild(el("div", "ar-name", agent.key));
  var seen = el("div", "ar-seen");
  seen.appendChild(el("span", "ar-first", "First seen " + timeText(agent.firstSeen)));
  seen.appendChild(el("span", "ar-last", "Last seen " + timeText(agent.lastSeen)));
  main.appendChild(seen);
  var places = el("div", "ar-places");
  (agent.places || []).forEach(function (p) { places.appendChild(el("span", "ar-place", placeText(p))); });
  main.appendChild(places);
  head.appendChild(main);

  var change = el("button", "ar-change", open ? "Close" : "Change avatar");
  change.setAttribute("type", "button");
  change.addEventListener("click", function () {
    pickerKey = open ? null : agent.key;
    paint();
  });
  head.appendChild(change);
  row.appendChild(head);

  if (open) {
    row.appendChild(buildAvatarPicker(agent.key, function (ref) { choose(agent.key, ref); }));
    if (failure && failure.key === agent.key) row.appendChild(el("div", "ar-failure", "The avatar could not be saved: " + failure.error + "."));
  }
  return row;
}

function paint() {
  var container = activeContainer;
  if (!container) return;
  container.innerHTML = "";
  var list = agents || [];
  if (!list.length) {
    var empty = el("div", "ar-empty", emptyStateText(agents));
    empty.setAttribute("data-empty", "true");
    container.appendChild(empty);
    return;
  }
  var parts = partitionRoster(list);
  GROUPS.forEach(function (group) {
    var members = parts[group.id];
    if (!members.length) return;
    var rows = group.collapsible && !expandedGroups[group.id] ? [] : members.map(renderRow);
    container.appendChild(buildGroupSection(group, rows, {
      count: members.length,
      expanded: !!expandedGroups[group.id],
      onToggle: function () { expandedGroups[group.id] = !expandedGroups[group.id]; paint(); },
    }));
  });
  refreshIcons(container);
}

function renderSection(container) {
  activeContainer = container;
  paint();
  send({ type: "agent_roster_request" });
}

registerTeamSection({ id: SECTION_ID, title: "Agents", render: renderSection });

// --- Messages from the server ---

// The agents and their avatar choices, without the sighting times that change
// on every use: while a picker is open, a roster that differs only in times does
// not redraw it, so a seed being typed is not lost.
function choicesSignature(list) {
  return JSON.stringify((list || []).map(function (a) { return [a.key, a.avatar || null, a.group || null]; }));
}

// The Claude model families come from the models the Claude vendor reported
// (its alias entries); the literal in model-families.js applies until it has.
function applyCatalogFamilies(catalog) {
  (Array.isArray(catalog) ? catalog : []).forEach(function (entry) {
    if (entry && entry.vendor === "claude") setClaudeModelFamilies(entry.models);
  });
}

export function handleAgentRoster(msg) {
  var before = choicesSignature(agents);
  agents = Array.isArray(msg.agents) ? msg.agents : [];
  applyCatalogFamilies(msg.catalog);
  setAgentAvatars(agents);
  refreshAgentAvatars();
  if (activeContainer && !isSectionContainerShown(activeContainer)) activeContainer = null;
  if (!activeContainer) return;
  if (pickerKey && before === choicesSignature(agents)) return;
  paint();
}

// The roster changed. The nudge carries no content: this connection asks, and the
// server answers with only what it may read. Asked whether or not the Team view
// is open, since every avatar on the page resolves from the answer.
export function handleAgentRosterChanged() {
  send({ type: "agent_roster_request" });
}

export function handleAgentAvatarSetResult(msg) {
  if (msg.ok) return;
  failure = { key: msg.key, error: msg.error || "unknown error" };
  if (activeContainer && !isSectionContainerShown(activeContainer)) activeContainer = null;
  if (activeContainer) paint();
}

// team-panel.js - The Agent Teams section of the Team view
// Handles team_state, team_member_update, team_task_update, team_message,
// team_gone WS messages and registers the "Agent Teams" section with the
// section registry in team-view.js, which draws it on desktop and mobile.

import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { escapeHtml } from './utils.js';
import { registerTeamSection, openTeamView, refreshTeamView } from './team-view.js';

// --- Module state ---
var currentTeam = null;
var teamMessages = [];

// --- Helpers ---

function sendWs(msg) {
  var ws = getWs();
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function statusClass(status) {
  if (status === "alive") return "alive";
  if (status === "idle") return "idle";
  if (status === "gone") return "gone";
  return "unknown";
}

function agentId(m) {
  if (typeof m === "string") return m;
  return m.id || m.agentId || "";
}

function agentName(m) {
  if (typeof m === "string") return m;
  return m.name || m.id || m.agentId || "unknown";
}

// --- Render helpers ---

function renderMembersSection(container, members, memberStatuses, memberActivities) {
  var header = document.createElement("div");
  header.className = "team-section-header";
  header.textContent = "Members";
  container.appendChild(header);

  if (!members || members.length === 0) {
    var empty = document.createElement("div");
    empty.className = "team-member-row";
    empty.style.color = "var(--text-dimmer)";
    empty.textContent = "No members";
    container.appendChild(empty);
    return;
  }

  for (var i = 0; i < members.length; i++) {
    var m = members[i];
    var id = agentId(m);
    var name = agentName(m);
    var status = (memberStatuses && memberStatuses[id]) || "unknown";
    var activity = (memberActivities && memberActivities[id]) || "";

    var row = document.createElement("div");
    row.className = "team-member-row";

    var dot = document.createElement("span");
    dot.className = "team-member-status-dot " + statusClass(status);
    row.appendChild(dot);

    var nameEl = document.createElement("span");
    nameEl.className = "team-member-name";
    nameEl.textContent = name;
    row.appendChild(nameEl);

    if (activity) {
      var actEl = document.createElement("span");
      actEl.className = "team-member-activity";
      actEl.textContent = activity;
      row.appendChild(actEl);
    }

    container.appendChild(row);
  }
}

function taskStatusLabel(status) {
  if (status === "completed") return "completed";
  if (status === "in_progress") return "in_progress";
  if (status === "blocked") return "blocked";
  return "pending";
}

function taskCheckmark(status) {
  if (status === "completed") return "✓";
  return "☐";
}

function renderTasksSection(container, tasks) {
  var header = document.createElement("div");
  header.className = "team-section-header";
  header.textContent = "Tasks";
  container.appendChild(header);

  if (!tasks || tasks.length === 0) {
    var empty = document.createElement("div");
    empty.className = "team-task-item";
    empty.style.color = "var(--text-dimmer)";
    empty.textContent = "No tasks";
    container.appendChild(empty);
    return;
  }

  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var status = taskStatusLabel(t.status);

    var item = document.createElement("div");
    item.className = "team-task-item";

    var check = document.createElement("span");
    check.textContent = taskCheckmark(t.status);
    check.style.marginRight = "6px";
    check.style.flexShrink = "0";
    item.appendChild(check);

    var title = document.createElement("span");
    title.style.flex = "1";
    title.textContent = t.title || t.description || t.id || "Task";
    item.appendChild(title);

    var pill = document.createElement("span");
    pill.className = "team-task-status " + status;
    pill.textContent = status.replace("_", " ");
    item.appendChild(pill);

    container.appendChild(item);
  }
}

function renderMessagesSection(container, messages) {
  var header = document.createElement("div");
  header.className = "team-section-header";
  header.textContent = "Messages";
  container.appendChild(header);

  var recent = messages.slice(-10);
  if (recent.length === 0) {
    var empty = document.createElement("div");
    empty.className = "team-message-item";
    empty.style.color = "var(--text-dimmer)";
    empty.textContent = "No messages yet";
    container.appendChild(empty);
    return;
  }

  for (var i = 0; i < recent.length; i++) {
    var msg = recent[i];
    var item = document.createElement("div");
    item.className = "team-message-item";

    var from = document.createElement("div");
    from.className = "team-message-from";
    from.textContent = escapeHtml(msg.fromAgentId || "?") + " → " + escapeHtml(msg.toAgentId || "?") + ":";
    item.appendChild(from);

    var body = document.createElement("div");
    body.className = "team-message-body";
    body.textContent = msg.summary || msg.body || "";
    item.appendChild(body);

    container.appendChild(item);
  }
}

function renderAgentTeamsSection(container) {
  if (!currentTeam) return;

  renderMembersSection(container, currentTeam.members, currentTeam._memberStatuses, currentTeam._memberActivities);

  var divider1 = document.createElement("hr");
  divider1.className = "mobile-sheet-divider";
  container.appendChild(divider1);

  renderTasksSection(container, currentTeam.tasks);

  var divider2 = document.createElement("hr");
  divider2.className = "mobile-sheet-divider";
  container.appendChild(divider2);

  renderMessagesSection(container, teamMessages);
}

export function hasActiveTeam() {
  return !!currentTeam;
}

registerTeamSection({
  id: "agent-teams",
  title: "Agent Teams",
  render: renderAgentTeamsSection,
  isAvailable: hasActiveTeam,
});

// --- Exports ---

export function initTeamPanel() {
  // Send team_request_state when WS connects
  store.subscribe(["connected"], function (state, prev) {
    if (state.connected && !prev.connected) {
      sendWs({ type: "team_request_state" });
    }
  });
}

export function handleTeamState(msg) {
  currentTeam = msg.team || null;
  if (currentTeam) {
    // Keyed by agent ids from the server: no prototype to answer for them.
    currentTeam._memberStatuses = currentTeam._memberStatuses || Object.create(null);
    currentTeam._memberActivities = currentTeam._memberActivities || Object.create(null);
  }
  teamMessages = msg.messages || [];

  if (currentTeam) openTeamView();
  else refreshTeamView();
}

export function handleTeamMemberUpdate(msg) {
  if (!currentTeam) return;

  // Full member list replacement
  if (msg.members) {
    currentTeam.members = msg.members;
  }

  // Single member status/activity update
  if (msg.agentId) {
    currentTeam._memberStatuses = currentTeam._memberStatuses || Object.create(null);
    currentTeam._memberActivities = currentTeam._memberActivities || Object.create(null);
    if (msg.status) {
      currentTeam._memberStatuses[msg.agentId] = msg.status;
    }
    if (msg.currentActivity) {
      currentTeam._memberActivities[msg.agentId] = msg.currentActivity;
    }
  }

  refreshTeamView();
}

export function handleTeamTaskUpdate(msg) {
  if (!currentTeam) return;
  if (msg.tasks) {
    currentTeam.tasks = msg.tasks;
  }
  refreshTeamView();
}

export function handleTeamMessage(msg) {
  if (msg.message) {
    teamMessages.push(msg.message);
    if (teamMessages.length > 50) teamMessages.shift();
  }
  refreshTeamView();
}

export function handleTeamGone() {
  currentTeam = null;
  teamMessages = [];

  refreshTeamView();
}

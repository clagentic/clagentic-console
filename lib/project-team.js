// lib/project-team.js
// Team activity watcher: watches ~/.claude/teams/, ~/.claude/tasks/, and
// per-teammate subagent JSONL files. Emits team_state, team_member_update,
// team_task_update, team_message, team_gone WS messages.

var fs = require("fs");
var path = require("path");
var utils = require("./utils");

function attachTeam(ctx) {
  var send = ctx.send;
  var config = ctx.config;
  // sm is optional (may be null if not yet wired)
  var sm = ctx.sm || null;

  var teamState = null; // null or { teamId, teamName, description, members[], tasks[] }
  var teamMessages = []; // last 50 team_message payloads
  var agentTails = {};  // agentId -> { path, offset, watcher }
  var memberLastActivity = {}; // agentId -> Unix ms timestamp
  var memberStatus = {}; // agentId -> last known status string
  var teamWatcher = null;
  var taskWatcher = null;
  var configWatcher = null;
  var livenessTimer = null;
  var deactivatePendingMs = 0; // epoch when deactivate-if-missing starts
  var DEACTIVATE_AFTER_MS = 30000;

  function getClaudeDir() {
    return path.join(config.REAL_HOME, ".claude");
  }

  function getTeamDir(teamId) {
    return path.join(getClaudeDir(), "teams", teamId);
  }

  function getTaskDir(teamId) {
    return path.join(getClaudeDir(), "tasks", teamId);
  }

  function readJsonSafe(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
      return null;
    }
  }

  function emitTeamState() {
    if (!teamState) return;
    send({ type: "team_state", team: teamState, messages: teamMessages });
  }

  function emitTeamGone() {
    send({ type: "team_gone" });
  }

  function deactivateTeam() {
    // Stop all watchers and timers
    if (livenessTimer) { clearInterval(livenessTimer); livenessTimer = null; }
    if (configWatcher) { try { configWatcher.close(); } catch (e) {} configWatcher = null; }
    if (taskWatcher) { try { taskWatcher.close(); } catch (e) {} taskWatcher = null; }

    var agentIds = Object.keys(agentTails);
    for (var i = 0; i < agentIds.length; i++) {
      var tail = agentTails[agentIds[i]];
      if (tail && tail.watcher) { try { tail.watcher.close(); } catch (e) {} }
    }
    agentTails = {};
    memberLastActivity = {};
    memberStatus = {};
    deactivatePendingMs = 0;
    teamMessages = [];
    teamState = null;
    emitTeamGone();
    console.log("[project-team] Team deactivated");
  }

  function watchTaskDir(teamId) {
    var dir = getTaskDir(teamId);
    try {
      if (!fs.existsSync(dir)) return;
    } catch (e) {
      return;
    }

    function readTasks() {
      try {
        var files = fs.readdirSync(dir);
        var tasks = [];
        for (var i = 0; i < files.length; i++) {
          if (!files[i].endsWith(".json")) continue;
          var t = readJsonSafe(path.join(dir, files[i]));
          if (t) tasks.push(t);
        }
        return tasks;
      } catch (e) {
        return [];
      }
    }

    var lastTasksJson = "";

    function checkTasks() {
      if (!teamState) return;
      var tasks = readTasks();
      var tasksJson = JSON.stringify(tasks);
      if (tasksJson === lastTasksJson) return;
      lastTasksJson = tasksJson;
      teamState.tasks = tasks;
      send({ type: "team_task_update", tasks: tasks });
    }

    try {
      taskWatcher = fs.watch(dir, function (event) {
        checkTasks();
      });
      taskWatcher.on("error", function () {});
      checkTasks();
    } catch (e) {
      // task dir may not exist — no-op
    }
  }

  function tailAgentJSONL(agentId, filePath) {
    if (agentTails[agentId] && agentTails[agentId].watcher) {
      // Already tailing this agent
      return;
    }

    var entry = { path: filePath, offset: 0, watcher: null };
    agentTails[agentId] = entry;

    function readNewLines() {
      try {
        var stat = fs.statSync(filePath);
        if (stat.size <= entry.offset) return;
        var fd = fs.openSync(filePath, "r");
        var bufSize = stat.size - entry.offset;
        var buf = Buffer.alloc(bufSize);
        var bytesRead = fs.readSync(fd, buf, 0, bufSize, entry.offset);
        fs.closeSync(fd);
        entry.offset += bytesRead;

        var text = buf.slice(0, bytesRead).toString("utf8");
        var lines = text.split("\n");
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line) continue;
          try {
            var parsed = JSON.parse(line);
            processAgentLine(agentId, parsed);
          } catch (e) {
            // Non-JSON line — skip
          }
        }
      } catch (e) {
        // File may not exist or be unreadable — tolerate
      }
    }

    function processAgentLine(aid, parsed) {
      // Update liveness timestamp on any new line
      memberLastActivity[aid] = Date.now();

      // Look for SendMessage tool use (peer DM)
      if (parsed.message && parsed.message.role === "assistant") {
        var content = parsed.message.content;
        if (Array.isArray(content)) {
          for (var ci = 0; ci < content.length; ci++) {
            var block = content[ci];
            if (block.type === "tool_use") {
              if (block.name === "SendMessage") {
                var input = block.input || {};
                var msg = {
                  fromAgentId: aid,
                  toAgentId: input.to || "",
                  summary: (input.message || "").slice(0, 120),
                  body: input.message || "",
                  ts: Date.now(),
                };
                teamMessages.push(msg);
                if (teamMessages.length > 50) teamMessages.shift();
                send({ type: "team_message", message: msg });
              } else {
                // Non-SendMessage tool_use: emit activity update
                send({
                  type: "team_member_update",
                  agentId: aid,
                  currentActivity: block.name,
                });
              }
            }
          }
        }
      }
    }

    // Start watching the file
    try {
      // Read any existing content first
      try {
        var stat = fs.statSync(filePath);
        entry.offset = stat.size; // Start from end (only new lines)
      } catch (e) {}

      entry.watcher = fs.watch(filePath, function (event) {
        readNewLines();
      });
      entry.watcher.on("error", function () {});
    } catch (e) {
      // File doesn't exist yet — watcher will fail silently
    }
  }

  function reconcileAgentTails(members) {
    if (!Array.isArray(members)) return;
    // members is an array of agentId strings or objects with id field
    var memberIds = {};
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      var id = typeof m === "string" ? m : (m.id || m.agentId || "");
      if (!id) continue;
      memberIds[id] = true;
    }

    // Stop tails for members no longer in team
    var existing = Object.keys(agentTails);
    for (var ei = 0; ei < existing.length; ei++) {
      if (!memberIds[existing[ei]]) {
        var tail = agentTails[existing[ei]];
        if (tail && tail.watcher) { try { tail.watcher.close(); } catch (e) {} }
        delete agentTails[existing[ei]];
      }
    }

    // The JSONL path requires cliSessionId and cwd which come in via onTeamCreate.
    // Store them on the entry when available.
    for (var mi = 0; mi < members.length; mi++) {
      var member = members[mi];
      var agentId = typeof member === "string" ? member : (member.id || member.agentId || "");
      if (!agentId) continue;
      if (!agentTails[agentId]) {
        // We don't have a JSONL path yet — mark as pending
        agentTails[agentId] = { path: null, offset: 0, watcher: null };
      }
    }
  }

  function watchConfigJson(teamId) {
    var configPath = path.join(getTeamDir(teamId), "config.json");
    var lastMembersJson = "";

    function reloadConfig() {
      var data = readJsonSafe(configPath);
      if (!data) {
        // config.json disappeared
        deactivatePendingMs = deactivatePendingMs || Date.now();
        return;
      }
      deactivatePendingMs = 0;
      if (!teamState) return;

      var newMembers = data.members || [];
      var newMembersJson = JSON.stringify(newMembers);
      if (newMembersJson === lastMembersJson) return;
      lastMembersJson = newMembersJson;

      teamState.members = newMembers;
      teamState.teamName = data.name || teamState.teamName;
      teamState.description = data.description || teamState.description;

      reconcileAgentTails(newMembers);

      send({ type: "team_member_update", members: teamState.members });
    }

    try {
      configWatcher = fs.watch(configPath, function (event) {
        reloadConfig();
      });
      configWatcher.on("error", function () {});
    } catch (e) {
      // File doesn't exist — tolerate
    }
  }

  function runLivenessCheck() {
    if (!teamState) return;

    var now = Date.now();
    var members = teamState.members || [];
    var changed = false;

    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      var aid = typeof m === "string" ? m : (m.id || m.agentId || "");
      if (!aid) continue;

      var last = memberLastActivity[aid] || 0;
      var status;
      if (last > now - 60000) {
        status = "alive";
      } else if (last > 0) {
        status = "idle";
      } else {
        status = "unknown";
      }

      if (memberStatus[aid] !== status) {
        memberStatus[aid] = status;
        changed = true;
        send({ type: "team_member_update", agentId: aid, status: status });
      }
    }

    // Deactivate check: if config.json has been missing for 30s and all are gone
    if (deactivatePendingMs > 0 && (now - deactivatePendingMs) > DEACTIVATE_AFTER_MS) {
      deactivateTeam();
    }
  }

  function activateTeam(teamId, cliSessionId, cwd) {
    if (teamState) deactivateTeam();

    var configPath = path.join(getTeamDir(teamId), "config.json");
    var data = readJsonSafe(configPath);
    var members = (data && data.members) || [];
    var tasks = [];

    // Read initial tasks
    var taskDir = getTaskDir(teamId);
    try {
      if (fs.existsSync(taskDir)) {
        var files = fs.readdirSync(taskDir);
        for (var i = 0; i < files.length; i++) {
          if (!files[i].endsWith(".json")) continue;
          var t = readJsonSafe(path.join(taskDir, files[i]));
          if (t) tasks.push(t);
        }
      }
    } catch (e) {}

    teamState = {
      teamId: teamId,
      teamName: (data && data.name) || teamId,
      description: (data && data.description) || "",
      members: members,
      tasks: tasks,
    };

    // Wire up JSONL tails for each member
    if (cliSessionId && cwd) {
      var sessionsBase = path.join(config.REAL_HOME, ".clagentic", "sessions");
      var encodedCwd = utils.resolveEncodedDir(sessionsBase, cwd);
      var subagentDir = path.join(
        config.REAL_HOME,
        ".claude",
        "projects",
        encodedCwd,
        cliSessionId,
        "subagents"
      );

      for (var mi = 0; mi < members.length; mi++) {
        var m = members[mi];
        var aid = typeof m === "string" ? m : (m.id || m.agentId || "");
        if (!aid) continue;
        var jsonlPath = path.join(subagentDir, "agent-" + aid + ".jsonl");
        tailAgentJSONL(aid, jsonlPath);
      }
    }

    watchConfigJson(teamId);
    watchTaskDir(teamId);

    livenessTimer = setInterval(runLivenessCheck, 15000);

    emitTeamState();
    console.log("[project-team] Team activated: " + teamId);
  }

  function onTeamCreate(teamId, cliSessionId, cwd) {
    activateTeam(teamId, cliSessionId, cwd);
  }

  function onTeamDelete() {
    if (teamState) deactivateTeam();
  }

  function handleClientMsg(ws, msg) {
    if (msg.type === "team_request_state") {
      if (teamState) {
        try {
          ws.send(JSON.stringify({ type: "team_state", team: teamState, messages: teamMessages }));
        } catch (e) {}
      }
      return true;
    }
    return false;
  }

  function getState() {
    return teamState;
  }

  // Feature-detect: if ~/.claude/teams/ doesn't exist, this module is a no-op
  // at activate time. Watchers are only created on activateTeam().

  return {
    onTeamCreate: onTeamCreate,
    onTeamDelete: onTeamDelete,
    handleClientMsg: handleClientMsg,
    getState: getState,
  };
}

module.exports = { attachTeam: attachTeam };

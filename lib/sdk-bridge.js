const crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var execSync = require("child_process").execSync;
var execFileSync = require("child_process").execFileSync;
var usersModule = require("./users");
var { getCodexConfig } = require("./codex-defaults");
var { splitShellSegments, attachSkillDiscovery, discoverSkillsWithMeta, mergeSkillsWithMeta } = require("./sdk-skill-discovery");
var { createMessageQueue } = require("./sdk-message-queue");
var { attachMessageProcessor } = require("./sdk-message-processor");
var { readAgentToolsFromFile, parseFrontmatter, slugifyAgentName, AGENTS_SOURCE_DIR } = require("./agents");
var { discoverWorkflows } = require("./sdk-workflow-discovery");
var { buildEnrichedSlashCommands } = require("./sdk-slash-enrichment");
var { KNOWN_CONTEXT_WINDOWS: _BACKEND_KNOWN_CONTEXT_WINDOWS, resolveModelContextWindow } = require("./model-context-windows");
var { runPreflight } = require("./settings-preflight");
var { partitionSubagentOwnedPermissions, retainPreservedTaskBookkeeping, sweepClearedPermissionIndex } = require("./sdk-permission-ownership");

// --- lr-29f9: Global concurrent-session ceiling ---
// Counts queries that are actively running (startQuery entered, processQueryStream
// finally not yet reached) across ALL project bridge instances in this daemon process.
// Each project's sdk-bridge instance shares this module-level counter.
// Env override: CLAGENTIC_MAX_CONCURRENT_SESSIONS (must be a positive integer).
var _activeLiveCount = 0;
var MAX_CONCURRENT_SESSIONS = (function () {
  var env = parseInt(process.env.CLAGENTIC_MAX_CONCURRENT_SESSIONS, 10);
  return (env > 0) ? env : 50;
})();

// --- lr-2d91: MemAvailable gate ---
// Default minimum available memory threshold in MB. Referenced by sdk-bridge
// and daemon.js — changing this constant is the single place to adjust the default.
var DEFAULT_MEM_AVAILABLE_MIN_MB = 1024;

// --- lr-2d91: cgroup context token guard ---
// Empirical calibration: claude-opus-4 at 1M context peaks at ~15 GB RSS,
// yielding approximately 67 tokens per MB of headroom consumed.
var DEFAULT_TOKENS_PER_MB_HEADROOM = 67;

// Configurable warn fractions for context guards (lr-1f7e).
// cgroupWarnFraction: warn when context tokens exceed this fraction of the
//   cgroup-headroom-derived ceiling (configurable via getConfig().cgroupWarnFraction).
// contextWindowWarnFraction: proactively warn when context tokens exceed this
//   fraction of the model's context window (configurable via
//   getConfig().contextWindowWarnFraction).  0/null → skip window-based warn.
var DEFAULT_CGROUP_WARN_FRACTION = 0.8;
var DEFAULT_CONTEXT_WINDOW_WARN_FRACTION = 0.8;

// Known context windows for models the backend may encounter (lr-1f7e, lr-336f).
// Imported from lib/model-context-windows.js — shared source of truth with the frontend.
// The alias preserves backward compatibility for any callers that reference this name.
var BACKEND_KNOWN_CONTEXT_WINDOWS = _BACKEND_KNOWN_CONTEXT_WINDOWS;
// resolveModelContextWindow imported from lib/model-context-windows.js above.

// Read Linux MemAvailable from /proc/meminfo synchronously.
// Returns available memory in MB, or null on non-Linux or read failure.
// Sub-millisecond on Linux; the synchronous read is correct here — this is a
// pre-launch check, not a hot path, and the async equivalent buys nothing.
function readMemAvailableMB() {
  if (process.platform !== "linux") return null;
  try {
    var raw = fs.readFileSync("/proc/meminfo", "utf8");
    var match = raw.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (!match) return null;
    return Math.floor(parseInt(match[1], 10) / 1024);
  } catch (e) {
    return null;
  }
}

// Read cgroup memory headroom in MB.
// Tries cgroup v2 (system.slice/clagentic-console.service) first, then cgroup v1.
// Returns null if neither is readable, the limit is "max" (unlimited), or on
// any read error — the caller must treat null as "no limit enforceable".
function readCgroupHeadroomMB() {
  if (process.platform !== "linux") return null;
  try {
    // cgroup v2
    var cgV2Dir = "/sys/fs/cgroup/system.slice/clagentic-console.service";
    var currentRaw = fs.readFileSync(cgV2Dir + "/memory.current", "utf8").trim();
    var maxRaw = fs.readFileSync(cgV2Dir + "/memory.max", "utf8").trim();
    if (maxRaw === "max") return null;
    var current = parseInt(currentRaw, 10);
    var max = parseInt(maxRaw, 10);
    if (isNaN(current) || isNaN(max) || max <= 0) return null;
    return Math.floor((max - current) / 1024 / 1024);
  } catch (e) {
    // fall through to v1
  }
  try {
    // cgroup v1
    var current1 = parseInt(fs.readFileSync("/sys/fs/cgroup/memory/memory.usage_in_bytes", "utf8").trim(), 10);
    var max1 = parseInt(fs.readFileSync("/sys/fs/cgroup/memory/memory.limit_in_bytes", "utf8").trim(), 10);
    if (isNaN(current1) || isNaN(max1) || max1 <= 0) return null;
    // Typical sentinel for "no limit" in cgroup v1 is a very large value (near INT64_MAX)
    if (max1 > 9e18) return null;
    return Math.floor((max1 - current1) / 1024 / 1024);
  } catch (e) {
    return null;
  }
}

// Extract serializable tool descriptors from MCP server instances.
// Used for IPC to worker processes (McpSdkServerConfigWithInstance is not serializable).
function extractMcpDescriptors(mcpServers) {
  if (!mcpServers) return null;
  var toJSONSchema;
  try { toJSONSchema = require("zod").toJSONSchema; } catch (e) { return null; }
  var descriptors = [];
  var names = Object.keys(mcpServers);
  for (var i = 0; i < names.length; i++) {
    var serverName = names[i];
    var server = mcpServers[serverName];
    if (!server || !server.instance || !server.instance._registeredTools) continue;
    var tools = [];
    var toolNames = Object.keys(server.instance._registeredTools);
    for (var j = 0; j < toolNames.length; j++) {
      var toolName = toolNames[j];
      var toolDef = server.instance._registeredTools[toolName];
      var inputSchema = { type: "object", properties: {} };
      try {
        if (toolDef.inputSchema) inputSchema = toJSONSchema(toolDef.inputSchema);
      } catch (e) { /* fallback to empty schema */ }
      tools.push({
        name: toolName,
        description: toolDef.description || toolName,
        inputSchema: inputSchema,
      });
    }
    if (tools.length > 0) descriptors.push({ serverName: serverName, tools: tools });
  }
  return descriptors.length > 0 ? descriptors : null;
}

// Call an MCP tool handler by server name and tool name.
// Returns a promise that resolves with the tool result.
function callMcpToolHandler(mcpServers, serverName, toolName, args) {
  if (!mcpServers || !mcpServers[serverName]) {
    return Promise.reject(new Error("MCP server not found: " + serverName));
  }
  var server = mcpServers[serverName];
  if (!server.instance || !server.instance._registeredTools || !server.instance._registeredTools[toolName]) {
    return Promise.reject(new Error("MCP tool not found: " + serverName + "/" + toolName));
  }
  var handler = server.instance._registeredTools[toolName].handler;
  if (typeof handler !== "function") {
    return Promise.reject(new Error("MCP tool handler not a function: " + serverName + "/" + toolName));
  }
  try {
    return Promise.resolve(handler(args));
  } catch (e) {
    return Promise.reject(e);
  }
}

// Merge in-process MCP servers with remote (extension-bridged) MCP servers.
// Returns the merged object, or null if no servers exist.
function mergeMcpServers(localServers, getRemoteFn) {
  var merged = {};
  var hasAny = false;
  if (localServers) {
    var lk = Object.keys(localServers);
    for (var i = 0; i < lk.length; i++) {
      merged[lk[i]] = localServers[lk[i]];
      hasAny = true;
    }
    console.log("[mergeMcpServers] local servers:", lk.join(", ") || "(none)");
  } else {
    console.log("[mergeMcpServers] local servers: null");
  }
  if (typeof getRemoteFn === "function") {
    var remote = getRemoteFn();
    if (remote) {
      var rk = Object.keys(remote);
      console.log("[mergeMcpServers] remote servers:", rk.join(", ") || "(none)");
      for (var j = 0; j < rk.length; j++) {
        merged[rk[j]] = remote[rk[j]];
        hasAny = true;
      }
    } else {
      console.log("[mergeMcpServers] remote servers: null/empty");
    }
  } else {
    console.log("[mergeMcpServers] getRemoteFn not a function");
  }
  console.log("[mergeMcpServers] merged result:", Object.keys(merged).join(", ") || "(none)");
  return hasAny ? merged : null;
}

function createSDKBridge(opts) {
  var cwd = opts.cwd;
  var slug = opts.slug || "";
  var sm = opts.sessionManager;   // session manager instance
  var send = opts.send;           // broadcast to all clients
  var pushModule = opts.pushModule;
  var getNotificationsModule = opts.getNotificationsModule || function () { return null; };
  var adapter = opts.adapter;
  var adapters = opts.adapters || {};
  var dangerouslySkipPermissions = opts.dangerouslySkipPermissions || false;
  // mcpServers may be either a static object or a getter function. The
  // getter form lets callers gate individual servers at call time (e.g.
  // clay-browser is only exposed while the Chrome extension is connected).
  var _mcpServersSrc = opts.mcpServers || null;
  function getMcpServers() {
    if (typeof _mcpServersSrc === "function") return _mcpServersSrc() || null;
    return _mcpServersSrc;
  }
  var getRemoteMcpServers = opts.getRemoteMcpServers || null;
  var clayPort = opts.clayPort || 2633;
  var clayTls = opts.clayTls || false;
  var clayAuthToken = opts.clayAuthToken || null;
  var onProcessingChanged = opts.onProcessingChanged || function () {};
  var _cachedFreshAuthState = null;
  var _cachedFreshAuthAt = 0;

  function getFreshAuthState(force) {
    var yoke = require("./yoke");
    var now = Date.now();
    if (!force && _cachedFreshAuthState && now - _cachedFreshAuthAt < 15000) {
      return _cachedFreshAuthState;
    }
    if (force) yoke.invalidateAuthCache();
    _cachedFreshAuthState = yoke.checkAuth();
    _cachedFreshAuthAt = now;
    return _cachedFreshAuthState;
  }

  function isAuthErrorMessage(errDetail) {
    if (!errDetail) return false;
    var errLower = String(errDetail).toLowerCase();
    return errLower.indexOf("not logged in") !== -1
      || errLower.indexOf("unauthenticated") !== -1
      || errLower.indexOf("authentication") !== -1
      || errLower.indexOf("sign in") !== -1
      || errLower.indexOf("log in") !== -1
      || errLower.indexOf("please login") !== -1;
  }

  function getLoginCommand(vendor) {
    if (vendor === "codex") return "codex login --device-auth";
    if (vendor === "claude") return "claude login";
    return (vendor || "claude") + " login";
  }

  function notifyAuthRequired(session, title, body, authLinuxUser, canAutoLogin, loginCommand) {
    var _nm = getNotificationsModule();
    if (!_nm) return false;
    _nm.notify("auth_required", {
      title: title,
      body: body,
      slug: slug,
      sessionId: session.localId,
      ownerId: session.ownerId || null,
      vendor: session.vendor || (adapter && adapter.vendor) || "claude",
      loginCommand: loginCommand,
      linuxUser: authLinuxUser,
      canAutoLogin: canAutoLogin,
    });
    return true;
  }

  function logAuthDecision(stage, session, errDetail, authState) {
    var vendor = session && session.vendor ? session.vendor : "(none)";
    var errSnippet = errDetail ? String(errDetail).replace(/\s+/g, " ").slice(0, 180) : "";
    var authSummary = authState ? JSON.stringify(authState) : "(none)";
    console.warn("[sdk-bridge] auth decision [" + stage + "] vendor=" + vendor + " auth=" + authSummary + (errSnippet ? " err=" + errSnippet : ""));
  }

  function getModelsForVendor(vendor) {
    if (vendor && sm.modelsByVendor && sm.modelsByVendor[vendor]) return sm.modelsByVendor[vendor];
    return sm.availableModels || [];
  }

  // Model list entries may be plain strings (Codex) or { value, displayName }
  // objects (Claude SDK). Normalize to the identifier string.
  function modelEntryValue(entry) {
    if (!entry) return "";
    if (typeof entry === "string") return entry;
    return entry.value || entry.id || "";
  }

  function modelListContains(list, modelId) {
    if (!list || !modelId) return false;
    for (var mi = 0; mi < list.length; mi++) {
      if (modelEntryValue(list[mi]) === modelId) return true;
    }
    return false;
  }

  // Resolve a shorthand model name (e.g. "opus[1m]") to its full ID
  // in the vendor model list (e.g. "claude-opus-4.6[1m]").
  function resolveModelInList(list, modelId) {
    if (!list || !modelId) return null;
    var lc = modelId.toLowerCase();
    for (var mi = 0; mi < list.length; mi++) {
      var val = modelEntryValue(list[mi]);
      if (val === modelId) return val;
    }
    for (var mi = 0; mi < list.length; mi++) {
      var val = modelEntryValue(list[mi]);
      if (!val || val === "default") continue;
      var vlc = val.toLowerCase();
      if (vlc.indexOf(lc) !== -1 || lc.indexOf(vlc) !== -1) return val;
    }
    return null;
  }

  function sendModelInfoForVendor(vendor, model) {
    send({
      type: "model_info",
      model: model || "",
      models: getModelsForVendor(vendor),
      vendor: vendor || (adapter && adapter.vendor) || "claude",
      availableVendors: sm.availableVendors || [],
      installedVendors: sm.installedVendors || [],
    });
  }
  var onTurnDone = opts.onTurnDone || null;

  // --- Idle session reaper ---
  // In single-user (in-process) mode, each session's Claude child process stays
  // alive between turns because the messageQueue push-stream is never ended.
  // Without a reaper, processes accumulate indefinitely as users switch between
  // sessions and projects. This reaper ends the messageQueue for sessions that
  // have been idle for IDLE_TIMEOUT_MS, allowing processQueryStream's finally
  // block to clean up the child process. Session state on disk is preserved —
  // the next startQuery() call resumes with a fresh process.
  var IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  var IDLE_CHECK_INTERVAL_MS = 60 * 1000; // check every 60 seconds
  var _idleReaperTimer = null;

  function startIdleReaper() {
    if (_idleReaperTimer) return;
    _idleReaperTimer = setInterval(function () {
      var now = Date.now();
      sm.sessions.forEach(function (session) {
        // Skip sessions that are actively processing, have no query,
        // or are single-turn (Ralph Loop — managed by onQueryComplete).
        if (session.isProcessing) return;
        if (!session.queryInstance) return;
        if (session.singleTurn) return;
        if (session.destroying) return;

        var lastActivity = session.lastActivityAt || 0;
        if (now - lastActivity > IDLE_TIMEOUT_MS) {
          console.log("[sdk-bridge] Reaping idle session " + session.localId +
            " (idle " + Math.round((now - lastActivity) / 60000) + "min)" +
            (session.title ? " title=" + JSON.stringify(session.title) : ""));
          // End the query so the for-await loop in processQueryStream
          // exits naturally, triggering the finally block cleanup.
          // Works for both in-process (messageQueue.end) and worker (handle.close) paths.
          if (session.queryInstance && typeof session.queryInstance.close === "function") {
            try { session.queryInstance.close(); } catch (e) {}
          } else if (session.messageQueue && typeof session.messageQueue.end === "function") {
            try { session.messageQueue.end(); } catch (e) {}
          }
        }
      });
    }, IDLE_CHECK_INTERVAL_MS);
    // Don't prevent process exit
    if (_idleReaperTimer.unref) _idleReaperTimer.unref();
  }

  function stopIdleReaper() {
    if (_idleReaperTimer) {
      clearInterval(_idleReaperTimer);
      _idleReaperTimer = null;
    }
  }

  // --- Skill discovery (extracted to sdk-skill-discovery.js) ---
  var skills = attachSkillDiscovery({ cwd: cwd });
  var discoverSkillDirs = skills.discoverSkillDirs;
  var mergeSkills = skills.mergeSkills;

  // --- Message processing (extracted to sdk-message-processor.js) ---
  // Auto-generate a session title via YOKE adapter.generateTitle().
  // Triggered by sdk-message-processor after AUTO_TITLE_TURN_THRESHOLD turns.
  function autoGenerateTitle(session) {
    var sessionAdapter = getAdapterForSession(session);
    if (typeof sessionAdapter.generateTitle !== "function") {
      console.log("[auto-title] adapter.generateTitle not available for vendor=" + sessionAdapter.vendor);
      return;
    }
    var userMessages = [];
    for (var i = 0; i < session.history.length; i++) {
      var entry = session.history[i];
      if (entry.type === "user_message" && entry.text) {
        userMessages.push(entry.text.substring(0, 200));
        if (userMessages.length >= 5) break;
      }
    }
    if (userMessages.length === 0) {
      console.log("[auto-title] No user messages found in session " + session.localId);
      return;
    }
    console.log("[auto-title] Calling adapter.generateTitle with " + userMessages.length + " messages for session " + session.localId);

    sessionAdapter.generateTitle(userMessages, { cwd: cwd }).then(function(title) {
      if (!title || title.length < 2) return;
      title = title.substring(0, 100);
      if (!session.titleManuallySet) {
        session.title = title;
        session.titleAutoGenerated = true;
        sm.saveSessionFile(session);
        sm.broadcastSessionList();
        if (session.cliSessionId && typeof adapter.renameSession === "function") {
          adapter.renameSession(session.cliSessionId, title, { dir: cwd }).catch(function () {});
        }
        console.log("[auto-title] Generated title for session " + session.localId + ": " + title);
      }
    }).catch(function(e) {
      console.error("[auto-title] Failed:", e.message || e);
    });
  }

  var msgProcessor = attachMessageProcessor({
    sm: sm,
    send: send,
    slug: slug,
    cwd: cwd,
    pushModule: pushModule,
    getNotificationsModule: getNotificationsModule,
    adapter: adapter,
    onProcessingChanged: onProcessingChanged,
    onTurnDone: onTurnDone,
    onAutoTitle: function (session) { autoGenerateTitle(session); },
    onTeamCreate: opts.onTeamCreate || null,
    onTeamDelete: opts.onTeamDelete || null,
    opts: opts,
    discoverSkillDirs: discoverSkillDirs,
    mergeSkills: mergeSkills,
    discoverSkillsWithMeta: function(cwdArg) { return discoverSkillsWithMeta(cwdArg); },
    mergeSkillsWithMeta: mergeSkillsWithMeta,
  });
  var processSDKMessage = msgProcessor.processSDKMessage;
  var sendAndRecord = msgProcessor.sendAndRecord;
  var sendToSession = msgProcessor.sendToSession;

  // --- MCP elicitation ---

  function handleElicitation(session, request, opts) {
    // Ralph Loop: auto-reject elicitation in autonomous mode
    if (session.loop && session.loop.active && session.loop.role !== "crafting") {
      return Promise.resolve({ action: "reject" });
    }

    return new Promise(function(resolve) {
      var requestId = crypto.randomUUID();
      if (!session.pendingElicitations) session.pendingElicitations = {};
      session.pendingElicitations[requestId] = {
        resolve: resolve,
        request: request,
      };
      sendAndRecord(session, {
        type: "elicitation_request",
        requestId: requestId,
        serverName: request.serverName,
        message: request.message,
        mode: request.mode || "form",
        url: request.url || null,
        elicitationId: request.elicitationId || null,
        requestedSchema: request.requestedSchema || null,
      });

      if (pushModule) {
        var _elicitPayload = {
          type: "elicitation",
          slug: slug,
          title: (request.serverName || "MCP Server") + " needs input",
          body: request.message || "Waiting for your response",
          tag: "claude-elicitation",
        };
        // Route to session owner only — body carries MCP message text.
        if (session.ownerId && pushModule.sendPushToUser) {
          pushModule.sendPushToUser(session.ownerId, _elicitPayload);
        } else {
          pushModule.sendPush(_elicitPayload);
        }
      }

      if (opts.signal) {
        opts.signal.addEventListener("abort", function() {
          delete session.pendingElicitations[requestId];
          resolve({ action: "reject" });
        });
      }
    });
  }


  // --- Linux user project directory setup ---
  // Ensures the linux user's .claude project directory exists and is writable,
  // then pre-copies CLI session file if needed. Called before starting a query
  // so the worker can resume from the correct session file.
  function ensureLinuxUserProjectDir(linuxUser, session) {
    try {
      var configMod = require("./config");
      var osUsersMod = require("./os-users");
      var originalHome = configMod.REAL_HOME || require("os").homedir();
      var linuxUserHome = osUsersMod.getLinuxUserHome(linuxUser);
      var uid = osUsersMod.getLinuxUserUid(linuxUser);
      if (originalHome !== linuxUserHome && uid != null) {
        var projectSlug = (cwd || "").replace(/\//g, "-");
        var dstDir = path.join(linuxUserHome, ".claude", "projects", projectSlug);
        // Create and chown the project directory once
        if (!fs.existsSync(dstDir)) {
          fs.mkdirSync(dstDir, { recursive: true });
          try { execFileSync("chown", ["-R", String(uid), path.join(linuxUserHome, ".claude")]); } catch (e2) {}
        } else {
          try {
            var dirStat = fs.statSync(dstDir);
            if (dirStat.uid !== uid) {
              execFileSync("chown", [String(uid), dstDir]);
            }
          } catch (e2) {}
        }
        // Pre-copy CLI session file so the worker can resume the conversation
        if (session.cliSessionId) {
          var sessionFileName = session.cliSessionId + ".jsonl";
          var srcFile = path.join(originalHome, ".claude", "projects", projectSlug, sessionFileName);
          var dstFile = path.join(dstDir, sessionFileName);
          if (fs.existsSync(srcFile) && !fs.existsSync(dstFile)) {
            fs.copyFileSync(srcFile, dstFile);
            try { execFileSync("chown", [String(uid), dstFile]); } catch (e2) {}
            console.log("[sdk-bridge] Pre-copied CLI session " + session.cliSessionId + " to " + linuxUser);
          }
        }
      }
    } catch (copyErr) {
      console.log("[sdk-bridge] Dir setup / session pre-copy skipped:", copyErr.message);
    }
  }

  // --- SDK query lifecycle ---

  // Check if a tool should be auto-approved based on whitelist rules.
  // Returns { behavior: "allow", updatedInput } if whitelisted, or null if not.
  // Shared by handleCanUseTool and mate mention canUseTool handlers.
  function checkToolWhitelist(toolName, input) {
    // Auto-approve read-only tools for ALL sessions.
    // These tools only inspect files and fetch data — no side effects.
    var readOnlyTools = { Read: true, Glob: true, Grep: true, WebFetch: true, WebSearch: true };
    if (readOnlyTools[toolName]) {
      return { behavior: "allow", updatedInput: input };
    }

    // Auto-approve safe browser MCP tools.
    // Only watch/unwatch: user explicitly chose which tab to share.
    // Everything else (screenshot, read_page, list_tabs, etc.) can expose
    // content from tabs the user didn't intend to share, so require approval.
    var safeBrowserTools = { browser_watch_tab: true, browser_unwatch_tab: true };
    if (toolName.indexOf("mcp__") === 0 && toolName.indexOf("__browser_") !== -1) {
      var mcpToolName = toolName.substring(toolName.lastIndexOf("__") + 2);
      if (safeBrowserTools[mcpToolName]) {
        return { behavior: "allow", updatedInput: input };
      }
    }

    // Auto-approve Mate datastore tools. These are scoped to the active Mate
    // project and already enforce SQL policy server-side.
    if (toolName.indexOf("mcp__clay-datastore__") === 0) {
      return { behavior: "allow", updatedInput: input };
    }

    // Auto-approve remote MCP tools that the user explicitly enabled in project settings.
    // These are user-owned local MCP servers, so no additional permission prompt needed.
    if (toolName.indexOf("mcp__") === 0 && getRemoteMcpServers) {
      var _rmcp = getRemoteMcpServers();
      if (_rmcp) {
        var _mcpParts = toolName.split("__");
        var _mcpServerName = _mcpParts.length >= 2 ? _mcpParts[1] : "";
        if (_rmcp[_mcpServerName]) {
          return { behavior: "allow", updatedInput: input };
        }
      }
    }

    // Auto-approve safe Bash commands (read-only, non-destructive)
    // Applies to ALL sessions (mates and regular projects alike).
    // These are purely read-only commands that cannot modify files, install
    // packages, or change system state. Functionally equivalent to the
    // Read/Glob/Grep built-in tools which are already auto-approved.
    //
    // lr-74c8: this whitelist previously included multi-purpose tools
    // (interpreters, package managers, git, sed/awk, xargs, tee, find,
    // curl/wget/http) with only a first-word check, so e.g.
    // `python3 -c "..."`, `git push --force`, `xargs rm -rf`, and
    // `sed -i ... file` were silently auto-allowed. Those entries are
    // removed outright (they have no read-only-only form worth trusting to
    // a first-word check). `git` is retained but restricted to an
    // argument-validated read-only subcommand allowlist. A leading `sudo`
    // is NEVER stripped before this check — a sudo-prefixed command must
    // fall through to the normal user permission prompt.
    if (toolName === "Bash" && input && input.command) {
      var cmd = input.command.trim();
      var safeBashCommands = {
        // Navigation (harmless on its own, checked in compound commands below)
        cd: true, pushd: true, popd: true,
        // File/dir inspection
        ls: true, cat: true, head: true, tail: true, wc: true, file: true,
        stat: true, tree: true, du: true, df: true,
        readlink: true, realpath: true, basename: true, dirname: true,
        // Search
        grep: true, rg: true, ag: true, ack: true, fgrep: true, egrep: true,
        // Lookup
        which: true, type: true, whereis: true, hash: true,
        // Environment/system info
        // lr-74c8 (BOBBIE follow-up): `env` and `command` are execution
        // primitives, not read-only inspection — `env rm -rf /` and
        // `command rm -rf /` launder an arbitrary tail command past a
        // first-word-only check with no argument validator. Removed
        // outright rather than gated: neither has a read-only-only form
        // worth trusting to a first-word check (contrast `printenv`,
        // which genuinely can only print).
        echo: true, printf: true, printenv: true, pwd: true,
        whoami: true, id: true, groups: true,
        date: true, uname: true, hostname: true, uptime: true, arch: true,
        nproc: true, free: true, lsb_release: true, sw_vers: true,
        locale: true, timedatectl: true,
        // Text processing (pure stdin/stdout, no side effects)
        jq: true, yq: true, sort: true, uniq: true, cut: true, tr: true,
        paste: true, column: true, fold: true,
        rev: true, tac: true, nl: true, expand: true, unexpand: true,
        fmt: true, pr: true, csplit: true, comm: true, join: true,
        // Comparison/hashing
        diff: true, cmp: true, md5sum: true, sha256sum: true, sha1sum: true,
        shasum: true, cksum: true, sum: true, b2sum: true, base64: true,
        xxd: true, od: true, hexdump: true,
        // Misc read-only
        test: true, true: true, false: true, seq: true, yes: true,
        sleep: true, time: true,
        man: true, help: true, info: true, apropos: true,
        cal: true, bc: true, expr: true, factor: true,
        lsof: true, ps: true, top: true, htop: true, pgrep: true,
        netstat: true, ss: true, ifconfig: true, ip: true, dig: true,
        nslookup: true, host: true, ping: true, traceroute: true,
      };
      // Multi-purpose tools retained in the whitelist but restricted to a
      // read-only subcommand/flag allowlist (lr-74c8). Each validator
      // receives the segment's argv (excluding the command word itself)
      // and returns true only for forms that cannot mutate state.
      var validatedCommands = {
        // Only the explicitly read-only git subcommands from the lr-74c8
        // spec are allowed. Deliberately narrow: no `remote`, `tag`,
        // `branch`, etc. — those have mutating forms (`branch -D`,
        // `remote add`, `tag <name>`) that a subcommand-only check cannot
        // safely distinguish from their read-only forms.
        git: function (args) {
          if (args.length === 0) return false;
          var readOnlySubcommands = {
            status: true, log: true, diff: true, show: true, "--version": true,
          };
          if (!readOnlySubcommands[args[0]]) return false;
          // lr-74c8 (BOBBIE follow-up): the subcommand allowlist above only
          // checked args[0] and ignored everything after it. `git show
          // --output=<path>` / `git log --output=<path>` (and the `-o`
          // short form) inherit diff/log's file-write flag, turning a
          // "read-only" subcommand into an unprompted arbitrary file write.
          // `-c <config>` can inject a pager/external-diff/exec config
          // (core.pager, diff.external) that runs an arbitrary command;
          // `--exec`, `--ext-diff`, `--textconv`, `-O`/`--output-indicator-*`
          // extend the same file-write/exec surface. Any of these flags on
          // an otherwise-allowed subcommand falls through to the prompt.
          var dangerousFlagRe = /^(-o|--output(=.*)?|-O|--output-indicator.*|-c|--exec(=.*)?|--ext-diff|--textconv|--upload-pack(=.*)?|--receive-pack(=.*)?)$/;
          for (var gi = 1; gi < args.length; gi++) {
            if (dangerousFlagRe.test(args[gi])) return false;
          }
          return true;
        },
      };
      // Split compound commands on operators (&&, ||, ;, |) while respecting
      // quoted strings and subshells so that e.g. grep -E "(a|b)" is not split
      var segments = splitShellSegments(cmd);
      // lr-74c8 (BOBBIE follow-up): splitShellSegments treats unquoted
      // $(...) and backtick command substitution as opaque inline text —
      // it never splits them out or inspects what's inside. That let
      // e.g. `echo $(rm -rf /)` / `echo \`rm -rf /\`` auto-approve on
      // firstWord `echo` alone, with the embedded command never
      // independently validated. splitShellSegments has exactly one
      // caller (here) plus a loose backward-compat test, so it is safe to
      // change, but changing its segmentation semantics for every caller
      // is riskier than gating at this single call site: any segment that
      // still contains an unquoted `$(`, backtick, or bare `` $`` marker
      // is treated as unwhitelistable outright and falls through to the
      // normal permission prompt, regardless of firstWord.
      var COMMAND_SUBSTITUTION_RE = /\$\(|`/;
      var allSafe = true;
      for (var si = 0; si < segments.length; si++) {
        var seg = segments[si].trim();
        if (!seg) continue;
        if (COMMAND_SUBSTITUTION_RE.test(seg)) {
          allSafe = false;
          break;
        }
        // Strip leading env assignments (FOO=bar cmd) only. A leading sudo
        // is intentionally NOT stripped — `sudo <anything>` always falls
        // through to the normal permission prompt (lr-74c8).
        var segTokens = seg.replace(/^(?:\w+=\S*\s+)*/, "").split(/\s+/).filter(Boolean);
        var firstWord = segTokens[0];
        if (safeBashCommands[firstWord]) continue;
        if (validatedCommands[firstWord] && validatedCommands[firstWord](segTokens.slice(1))) continue;
        allSafe = false;
        break;
      }
      if (allSafe) {
        return { behavior: "allow", updatedInput: input };
      }
    }

    return null; // Not whitelisted
  }

  function handleCanUseTool(session, toolName, input, opts) {
    // Full-auto mode: auto-approve everything except AskUserQuestion
    // (which still needs to go through the user interaction flow).
    if (sm.currentPermissionMode === "bypassPermissions" && toolName !== "AskUserQuestion") {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }

    // Ralph Loop execution: auto-approve all tools, deny interactive ones.
    // Crafting sessions are interactive — user and Claude collaborate to build PROMPT.md / JUDGE.md.
    if (session.loop && session.loop.active && session.loop.role !== "crafting") {
      if (toolName === "AskUserQuestion") {
        return Promise.resolve({ behavior: "deny", message: "Autonomous mode. Make your own decision." });
      }
      if (toolName === "EnterPlanMode") {
        return Promise.resolve({ behavior: "deny", message: "Do not enter plan mode. Execute directly." });
      }
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }

    // Check shared whitelist (read-only tools, safe browser tools, safe bash commands)
    var whitelisted = checkToolWhitelist(toolName, input);
    if (whitelisted) {
      return Promise.resolve(whitelisted);
    }

    // AskUserQuestion: wait for user answers via WebSocket
    if (toolName === "AskUserQuestion") {
      return new Promise(function(resolve) {
        session.pendingAskUser[opts.toolUseID] = {
          resolve: resolve,
          input: input,
        };
        if (opts.signal) {
          opts.signal.addEventListener("abort", function() {
            delete session.pendingAskUser[opts.toolUseID];
            sendAndRecord(session, { type: "ask_user_answered", toolId: opts.toolUseID });
            resolve({ behavior: "deny", message: "Cancelled" });
          });
        }
      });
    }

    // Auto-approve if tool was previously allowed for session
    if (session.allowedTools && session.allowedTools[toolName]) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }

    // Regular tool permission request: send to client and wait
    // TODO(lr-9d4b): unlike the worker path's canUseTool (claude-worker.js:315,
    // 30s auto-deny), this in-process path has no timeout, so an orphaned
    // resolver (e.g. one whose owning session/sub-agent tracking bug is not
    // yet known) wedges the turn forever instead of failing closed. Deferred
    // out of this PR: a uniform timeout here would also auto-deny normal
    // foreground human-review latency for every non-sub-agent permission
    // request in the in-process path, which is a broader behavior change than
    // this hang-fix should bundle silently. Needs a design pass (e.g. scope
    // the timeout to sub-agent-owned entries only, or make it operator-
    // configurable) rather than copying the worker's blanket 30s.
    return new Promise(function(resolve) {
      var requestId = crypto.randomUUID();
      sm.permissionRequestIndex[requestId] = session.localId;
      session.pendingPermissions[requestId] = {
        resolve: resolve,
        requestId: requestId,
        toolName: toolName,
        toolInput: input,
        toolUseId: opts.toolUseID,
        decisionReason: opts.decisionReason || "",
      };

      var permMsg = {
        type: "permission_request",
        requestId: requestId,
        toolName: toolName,
        toolInput: input,
        toolUseId: opts.toolUseID,
        decisionReason: opts.decisionReason || "",
        vendor: session.vendor || (adapter && adapter.vendor) || "claude",
      };
      sendAndRecord(session, permMsg);
      onProcessingChanged(); // update cross-project permission badge

      if (pushModule) {
        var _permPayload = {
          type: "permission_request",
          slug: slug,
          requestId: requestId,
          title: permissionPushTitle(toolName, input),
          body: permissionPushBody(toolName, input),
        };
        // Route to session owner only — body carries tool name and input (may contain paths/code).
        if (session.ownerId && pushModule.sendPushToUser) {
          pushModule.sendPushToUser(session.ownerId, _permPayload);
        } else {
          pushModule.sendPush(_permPayload);
        }
      }

      var _nm = getNotificationsModule();
      if (_nm) {
        _nm.notify("permission_request", {
          title: permissionPushTitle(toolName, input),
          body: permissionPushBody(toolName, input),
          slug: slug,
          sessionId: session.localId,
          ownerId: session.ownerId || null,
          requestId: requestId,
          toolName: toolName,
          toolInput: input,
        });
      }

      if (opts.signal) {
        opts.signal.addEventListener("abort", function() {
          delete session.pendingPermissions[requestId];
          delete sm.permissionRequestIndex[requestId];
          sendAndRecord(session, { type: "permission_cancel", requestId: requestId });
          onProcessingChanged(); // update cross-project permission badge
          resolve({ behavior: "deny", message: "Request cancelled" });
        });
      }
    });
  }

  /**
   * Detect running Claude Code CLI processes that may conflict with our SDK queries.
   * Only returns processes whose cwd matches our project directory.
   * Returns an array of { pid, command } for each conflicting process found.
   */
  function findConflictingClaude() {
    try {
      var output = execFileSync("ps", ["ax", "-o", "pid,command"], { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
      var lines = output.trim().split("\n");
      var candidates = [];
      for (var i = 1; i < lines.length; i++) { // skip header
        var line = lines[i].trim();
        var m = line.match(/^(\d+)\s+(.+)/);
        if (!m) continue;
        var pid = parseInt(m[1], 10);
        var cmd = m[2];
        // Skip our own process
        if (pid === process.pid) continue;
        // Skip node processes (our daemon, dev watchers, etc.)
        if (/\bnode\b/.test(cmd.split(/\s/)[0])) continue;
        // Match actual claude binary (e.g. /Users/x/.claude/local/claude, /usr/local/bin/claude)
        if (/\/claude(\s|$)/.test(cmd) || /^claude(\s|$)/.test(cmd)) {
          candidates.push({ pid: pid, command: cmd.substring(0, 200) });
        }
      }

      // Filter to only processes whose cwd matches our project
      var results = [];
      for (var j = 0; j < candidates.length; j++) {
        var c = candidates[j];
        try {
          // Use /proc/<pid>/cwd symlink (always available on Linux, no lsof dependency)
          var procCwd = fs.readlinkSync("/proc/" + c.pid + "/cwd");
          if (procCwd === cwd) {
            results.push(c);
          }
        } catch (e) {
          // /proc read failed — include as candidate anyway (conservative)
          results.push(c);
        }
      }
      return results;
    } catch (e) {
      return [];
    }
  }

  /**
   * Verify that a PID is actually a claude binary process (not arbitrary).
   */
  function isClaudeProcess(pid) {
    try {
      var output = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim();
      return /\/claude(\s|$)/.test(output) || /^claude(\s|$)/.test(output);
    } catch (e) {
      return false;
    }
  }

  async function processQueryStream(session) {
    // Capture references at start so we only clean up OUR resources in finally,
    // not resources from a newer query that may have been created after an abort.
    var myQueryInstance = session.queryInstance;
    var myAbortController = session.abortController;
    console.log("[sdk-bridge] processQueryStream: starting for-await loop, vendor=" + (session.vendor || adapter.vendor));
    try {
      for await (var msg of myQueryInstance) {
        if (msg && msg.yokeType !== "text_delta" && msg.yokeType !== "thinking_delta" && msg.yokeType !== "tool_input_delta") {
          console.log("[sdk-bridge] processQueryStream: received event yokeType=" + msg.yokeType);
        }
        // Handle worker meta events (context_usage, model_changed, etc.)
        if (msg && msg.type === "_worker_meta") {
          var metaData = msg.data || {};
          switch (msg.subtype) {
            case "context_usage":
              session.lastContextUsage = metaData.data;
              sendToSession(session, { type: "context_usage", data: metaData.data });
              break;
            case "model_changed":
              sm.currentModel = metaData.model;
              sendModelInfoForVendor(session.vendor || (adapter && adapter.vendor) || "claude", metaData.model);
              send({ type: "config_state", model: sm.currentModel, mode: sm.currentPermissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas || [] });
              break;
            case "effort_changed":
              sm.currentEffort = metaData.effort;
              send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort, betas: sm.currentBetas || [] });
              break;
            case "permission_mode_changed":
              sm.currentPermissionMode = metaData.mode;
              send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode, effort: sm.currentEffort || "medium", betas: sm.currentBetas || [] });
              break;
            case "worker_error":
              send({ type: "error", text: metaData.error });
              break;
          }
          continue;
        }
        processSDKMessage(session, msg);
      }
      // (getContextUsage moved to processSDKMessage result handler -- fire-and-forget)
      // Stream ended normally after a task stop — no "result" message was sent,
      // so the session is still marked as processing. Send interrupted feedback.
      console.log("[sdk-bridge] processQueryStream ended: isProcessing=" + session.isProcessing + " taskStopRequested=" + session.taskStopRequested);
      if (session.isProcessing && session.taskStopRequested) {
        session.isProcessing = false;
        onProcessingChanged();
        send({ type: "status", processing: false });
        sendAndRecord(session, { type: "thinking_stop" });
        var interruptMsg = (session.vendor === "codex")
          ? "\u25a0 Conversation interrupted - tell the model what to do differently."
          : "Interrupted \u00b7 What should Claude do instead?";
        sendAndRecord(session, { type: "info", text: interruptMsg });
        sendAndRecord(session, { type: "done", code: 0 });
        sm.broadcastSessionList();
      }
    } catch (err) {
      if (session.isProcessing) {
        session.isProcessing = false;
        onProcessingChanged();
        if (err.name === "AbortError" || (myAbortController && myAbortController.signal.aborted) || session.taskStopRequested) {
          if (!session.destroying) {
            sendAndRecord(session, { type: "thinking_stop" });
            var interruptMsg2 = (session.vendor === "codex")
              ? "\u25a0 Conversation interrupted - tell the model what to do differently."
              : "Interrupted \u00b7 What should Claude do instead?";
            sendAndRecord(session, { type: "info", text: interruptMsg2 });
            sendAndRecord(session, { type: "done", code: 0 });
          }
        } else if (session.destroying) {
          // Suppress error messages during shutdown
          console.log("[sdk-bridge] Suppressing stream error during shutdown for session " + session.localId);
        } else {
          var errDetail = err.message || String(err);
          if (err.stderr) errDetail += "\nstderr: " + err.stderr;
          if (err.exitCode != null) errDetail += " (exitCode: " + err.exitCode + ")";
          console.error("[sdk-bridge] Query stream error for session " + session.localId + ":", errDetail);
          console.error("[sdk-bridge] Stack:", err.stack || "(no stack)");

          // Check for conflicting Claude processes only on exit code 1
          var isExitCode1 = err.exitCode === 1 || (err.message && err.message.indexOf("exited with code 1") !== -1);
          var conflicts = isExitCode1 ? findConflictingClaude() : [];
          if (conflicts.length > 0) {
            console.error("[sdk-bridge] Found " + conflicts.length + " conflicting Claude process(es):", conflicts.map(function(c) { return "PID " + c.pid; }).join(", "));
            sendAndRecord(session, {
              type: "process_conflict",
              text: "Another Claude Code process is already running in this project.",
              processes: conflicts,
            });
          } else {
            var errLower = errDetail.toLowerCase();
            var isContextOverflow = errLower.indexOf("prompt is too long") !== -1
              || errLower.indexOf("context_length") !== -1
              || errLower.indexOf("maximum context length") !== -1;
            var isAuthError = isAuthErrorMessage(errDetail);
            if (isContextOverflow) {
              sendAndRecord(session, {
                type: "context_overflow",
                text: "Conversation too long to continue.",
              });
            } else if (isAuthError) {
              var freshAuth = getFreshAuthState();
              logAuthDecision("catch-auth-error", session, errDetail, freshAuth);
              if (freshAuth[session.vendor]) {
                sendAndRecord(session, {
                  type: "error",
                  text: "Authentication looked fine, but " + (session.vendor || "the vendor") + " returned an auth-like error.",
                });
                sendAndRecord(session, { type: "done", code: 1 });
                sm.broadcastSessionList();
                return;
              }
              var authUser = session.ownerId ? usersModule.findUserById(session.ownerId) : null;
              var authLinuxUser = authUser && authUser.linuxUser ? authUser.linuxUser : null;
              var canAutoLogin = !!authLinuxUser
                || (authUser && authUser.role === "admin");
              var authTitle = (session.vendor === "codex" ? "Codex" : "Claude Code") + " is not logged in.";
              var authMsg = {
                type: "auth_required",
                text: authTitle,
                vendor: session.vendor || (adapter && adapter.vendor) || "claude",
                loginCommand: getLoginCommand(session.vendor || (adapter && adapter.vendor) || "claude"),
                linuxUser: authLinuxUser,
                canAutoLogin: canAutoLogin,
              };
              sendAndRecord(session, authMsg);
              if (!notifyAuthRequired(
                session,
                authTitle,
                "Open a terminal, then click the URL and follow the instructions.",
                authLinuxUser,
                canAutoLogin,
                getLoginCommand(session.vendor || (adapter && adapter.vendor) || "claude")
              )) {
                // chat message already sent above
              }
            } else {
              sendAndRecord(session, { type: "error", text: "Claude process error: " + err.message });
            }
          }
          sendAndRecord(session, { type: "done", code: 1 });
        }
        sm.broadcastSessionList();
      }
    } finally {
      // Close the SDK query to terminate the underlying claude child process.
      // Without this, the process stays alive indefinitely (single-user mode).
      // Only clean up if the session still references OUR resources.
      // A rewind + new startQuery may have already replaced these with
      // a newer query — clobbering them would kill the new query.
      if (session.queryInstance === myQueryInstance) {
        try {
          if (typeof session.queryInstance.close === "function") {
            session.queryInstance.close();
          }
        } catch (e) {}
        session.queryInstance = null;
      }
      // lr-b61b: In the in-process path, close() ends the messageQueue but the
      // underlying claude child process may survive in epoll_wait on its stdin
      // socket. Aborting via the AbortController signals the SDK to terminate
      // the child process. We always abort our own controller — even if the
      // session.abortController reference was already replaced by a newer query
      // (e.g. after a rewind), myAbortController is our local capture and
      // aborting it only affects this query's child, not the newer one.
      if (myAbortController && typeof myAbortController.abort === "function") {
        try {
          myAbortController.abort();
          console.log("[sdk-bridge] processQueryStream finally: aborted AbortController for session " + session.localId);
        } catch (e) {}
      }
      session.messageQueue = null;
      if (session.abortController === myAbortController) session.abortController = null;

      // lr-29f9: Reap the worker process immediately on query completion.
      // The worker is kept alive between turns by _adapterWorkerState reuse, but
      // once processQueryStream exits there is nothing left to receive from it.
      // Kill it now so dead processes do not accumulate. Session history is on
      // disk and unaffected; startQuery will spawn a fresh worker next turn.
      // We use the exitPromise stored at query-start time so startQuery's
      // _workerExitPromise guard (which serialises consecutive queries) still works.
      if (session._adapterWorkerState && session._adapterWorkerState.worker) {
        var doneWorker = session._adapterWorkerState.worker;
        var doneExitPromise = session._adapterWorkerState.exitPromise;
        // Hand the exitPromise to startQuery so it can await worker termination
        // before spawning the next one (prevents session-file race on resume).
        session._workerExitPromise = doneExitPromise || null;
        // Null out worker state so the next startQuery spawns fresh.
        session._adapterWorkerState = null;
        session.worker = null;
        console.log("[sdk-bridge] Reaping worker pid=" + (doneWorker.process ? doneWorker.process.pid : "?") + " for session " + session.localId + " on query completion");
        try { doneWorker.kill(); } catch (e) {}
      }

      // lr-29f9: Release the live-session slot claimed in startQuery.
      if (session._isCountedLive) {
        session._isCountedLive = false;
        _activeLiveCount = Math.max(0, _activeLiveCount - 1);
        console.log("[sdk-bridge] Live query count: " + _activeLiveCount + "/" + MAX_CONCURRENT_SESSIONS + " (session " + session.localId + " done)");
      }
      session.taskStopRequested = false;
      // lr-8355: A rewind (or any other replacement) may have already started
      // a NEW query on this session while this stream's for-await is still
      // unwinding (e.g. rewind_execute nulls session.queryInstance, then the
      // user immediately sends a message, starting a fresh query). If that
      // happened, session.queryInstance now points at the newer query's
      // instance, not ours. Resetting pendingPermissions/pendingAskUser/
      // pendingElicitations/isProcessing here would wipe the NEW query's
      // in-flight state out from under it (approval clicks silently ignored,
      // turn hangs forever) and flip isProcessing=false while the new query
      // is still live. Only run the reset when we still own the session
      // (queryInstance is unchanged or has already been nulled by our own
      // completion path above) — never when a newer query has taken over.
      if (session.queryInstance === myQueryInstance || session.queryInstance === null) {
        // lr-9d4b: This finally block runs on EVERY ordinary (non-superseded)
        // turn completion — including the common case where a backgrounded
        // sub-agent's own permission request (e.g. Bash) is still awaiting
        // the operator's click when the parent turn ends normally. This is a
        // second wipe of pendingPermissions on the SAME turn as the 'result'
        // message's own reset (sdk-message-processor.js), microseconds later
        // once the for-await loop drains. Unconditionally clearing here would
        // re-orphan the resolver the result handler just preserved. Use the
        // same shared keep-decision as that handler (see
        // lib/sdk-permission-ownership.js) rather than duplicating it.
        var _perm9d4b = partitionSubagentOwnedPermissions(session);
        // lr-f940 (N3): sweep sm.permissionRequestIndex for every entry this
        // pass is about to drop (everything not in keptPermissions) — this is
        // the ONLY cleanup that runs for the worker path, whose fake abort
        // signal (yoke/adapters/claude.js) never fires the normal
        // abort-listener deletion. Must run against the PRE-reassignment map.
        sweepClearedPermissionIndex(sm, session.pendingPermissions, _perm9d4b.keptPermissions);
        session.pendingPermissions = _perm9d4b.keptPermissions;
        // Preserve MCP-mode AskUserQuestion entries across turn boundaries.
        // The MCP path is intentionally stateless: ask_user returns immediately
        // ("card posted, end your turn") and the answer arrives as a new
        // user_message on the next turn. Those entries MUST survive this finally
        // block so ask_user_response can find the toolId and inject the answer.
        // canUseTool-mode entries hold an open SDK callback that dies with the
        // query anyway, so those are correctly cleared here.
        var _keepAskUser = {};
        for (var _tid in session.pendingAskUser) {
          var _pau = session.pendingAskUser[_tid];
          if (_pau && _pau.mode === "mcp") _keepAskUser[_tid] = _pau;
        }
        session.pendingAskUser = _keepAskUser;
        session.pendingElicitations = {};
        // lr-9d4b: keep activeTaskToolIds/taskIdMap bookkeeping in sync with
        // whichever Task ids just had a permission preserved above — mirrors
        // the same reconciliation the 'result' handler performs.
        retainPreservedTaskBookkeeping(session, _perm9d4b.preservedTaskIds);

        // Auto-continue on rate limit (scheduler sessions, or user setting)
        // Mark session as done processing so the late rate_limit_event handler
        // can detect the race condition and schedule auto-continue itself.
        session.isProcessing = false;
      }

      var didScheduleAutoContinue = false;
      var acEnabled = session.onQueryComplete || (typeof opts.getAutoContinueSetting === "function" && opts.getAutoContinueSetting(session));
      if (session.rateLimitResetsAt && session.rateLimitResetsAt > Date.now()
          && acEnabled && !session.destroying) {
        var acResetsAt = session.rateLimitResetsAt;
        session.rateLimitResetsAt = null;
        session.rateLimitAutoContinuePending = true;
        didScheduleAutoContinue = true;
        console.log("[sdk-bridge] Rate limited, scheduling auto-continue via scheduleMessage for session " + session.localId);
        if (typeof opts.scheduleMessage === "function") {
          opts.scheduleMessage(session, "continue", acResetsAt);
        }
      } else if (acEnabled && !session.destroying) {
        // Log why auto-continue was not scheduled (for debugging)
        console.log("[sdk-bridge] Query done, auto-continue enabled but not scheduled: rateLimitResetsAt=" +
          session.rateLimitResetsAt + " (will rely on late rate_limit_event handler)");
      }

      // Ralph Loop: notify completion so loop orchestrator can proceed
      if (session.onQueryComplete && !didScheduleAutoContinue) {
        console.log("[sdk-bridge] Calling onQueryComplete for session " + session.localId + " (title: " + (session.title || "?") + ")");
        try {
          session.onQueryComplete(session);
        } catch (err) {
          console.error("[sdk-bridge] onQueryComplete error:", err.message || err);
        }
      }
    }
  }

  async function getOrCreateRewindQuery(session) {
    if (session.queryInstance) return { query: session.queryInstance, isTemp: false, cleanup: function() {} };

    var handle;
    try {
      handle = await adapter.createQuery({
        cwd: cwd,
        resumeSessionId: session.cliSessionId,
        adapterOptions: {
          CLAUDE: {
            settingSources: ["user", "project", "local"],
            enableFileCheckpointing: true,
          },
        },
      });
    } catch (e) {
      sendAndRecord(session, { type: "error", text: "Failed to load Claude SDK: " + (e.message || e) });
      throw e;
    }

    // Drain messages in background (stream stays alive until close)
    (async function() {
      try { for await (var msg of handle) {} } catch(e) {}
    })();

    return {
      query: handle,
      isTemp: true,
      cleanup: function() { try { handle.close(); } catch(e) {} },
    };
  }

  // --- Unified rewind/fork interface (adapter-agnostic) ---

  async function rewindPreview(session, uuid) {
    var sessionAdapter = getAdapterForSession(session);
    // Adapters with rollbackThread (e.g. Codex) do chat-only rewind, no file diffs
    if (sessionAdapter && typeof sessionAdapter.rollbackThread === "function") {
      return { preview: { filesChanged: [] }, diffs: {}, chatOnly: true };
    }
    // Claude path: use rewindFiles with dryRun
    var result = await getOrCreateRewindQuery(session);
    try {
      var preview = await result.query.rewindFiles(uuid, { dryRun: true });
      var diffs = {};
      var changedFiles = preview.filesChanged || [];
      for (var f = 0; f < changedFiles.length; f++) {
        try {
          diffs[changedFiles[f]] = require("child_process").execFileSync(
            "git", ["diff", "HEAD", "--", changedFiles[f]],
            { cwd: cwd, encoding: "utf8", timeout: 5000 }
          ) || "";
        } catch (e) { diffs[changedFiles[f]] = ""; }
      }
      return { preview: preview, diffs: diffs, chatOnly: false };
    } finally {
      if (result.isTemp) result.cleanup();
    }
  }

  async function rewindExecuteFiles(session, uuid) {
    var sessionAdapter = getAdapterForSession(session);
    // Adapters with rollbackThread skip file restoration
    if (sessionAdapter && typeof sessionAdapter.rollbackThread === "function") return;
    // Claude path: restore files
    var result = await getOrCreateRewindQuery(session);
    try {
      await result.query.rewindFiles(uuid, { dryRun: false });
    } finally {
      if (result.isTemp) result.cleanup();
    }
  }

  async function rollbackConversation(session, numTurns) {
    var sessionAdapter = getAdapterForSession(session);
    if (sessionAdapter && typeof sessionAdapter.rollbackThread === "function") {
      await sessionAdapter.rollbackThread(session.cliSessionId, numTurns);
    }
    // Claude: conversation rollback is handled by rewindFiles + local history trim
  }

  function getAdapterForSession(session) {
    var vendor = session.vendor || sm.defaultVendor || "claude";
    return adapters[vendor] || adapter;
  }

  async function forkSessionUnified(session, uuid) {
    var sessionAdapter = getAdapterForSession(session);
    var result = await sessionAdapter.forkSession(session.cliSessionId, { upToMessageId: uuid, dir: cwd });
    if (!result || !result.sessionId) throw new Error("Fork returned no session id");

    // Adapters with rollbackThread (e.g. Codex) use local history copy
    if (typeof sessionAdapter.rollbackThread === "function") {
      return { sessionId: result.sessionId, useLocalHistory: true };
    }
    // Claude: read history from CLI session files
    return { sessionId: result.sessionId, useLocalHistory: false };
  }

  async function startQuery(session, text, images, linuxUser) {
    async function ensureVendorReady(vendor) {
      if (!vendor) return null;
      var vendorAdapter = adapters[vendor] || null;
      if (!vendorAdapter) {
        var yoke = require("./yoke");
        vendorAdapter = await yoke.lazyCreateAdapter(adapters, vendor, {
          cwd: cwd,
          dangerouslySkipPermissions: dangerouslySkipPermissions,
          linuxUser: linuxUser || undefined,
          clayPort: clayPort,
          clayTls: clayTls,
          clayAuthToken: clayAuthToken,
          slug: slug,
        });
      } else if ((!sm.modelsByVendor || !sm.modelsByVendor[vendor]) && typeof vendorAdapter.init === "function") {
        await vendorAdapter.init({
          cwd: cwd,
          dangerouslySkipPermissions: dangerouslySkipPermissions,
          linuxUser: linuxUser || undefined,
          clayPort: clayPort,
          clayTls: clayTls,
          clayAuthToken: clayAuthToken,
          slug: slug,
        });
      }
      if (vendorAdapter) {
        sm.availableVendors = Object.keys(adapters);
        sm.modelsByVendor = sm.modelsByVendor || {};
        if (!sm.modelsByVendor[vendor] && typeof vendorAdapter.supportedModels === "function") {
          sm.modelsByVendor[vendor] = await vendorAdapter.supportedModels();
        }
      }
      return vendorAdapter;
    }

    // If vendor is set but adapter not ready, try lazy creation (user may have logged in)
    if (session.vendor && !adapters[session.vendor]) {
      var lazyAdapter = await ensureVendorReady(session.vendor);
      if (lazyAdapter) {
        console.log("[sdk-bridge] Lazy adapter created for " + session.vendor);
      }
    } else if (session.vendor) {
      await ensureVendorReady(session.vendor);
    }
    if (session.vendor && !adapters[session.vendor]) {
      var freshAuth = getFreshAuthState();
      logAuthDecision("pre-auth-required", session, null, freshAuth);
      if (freshAuth[session.vendor]) {
        var recoveredAdapter = await ensureVendorReady(session.vendor);
        if (recoveredAdapter) {
          console.log("[sdk-bridge] Auth recheck recovered adapter for " + session.vendor);
        }
      }
    }
    // If still not available after lazy check, send auth_required
    if (session.vendor && !adapters[session.vendor]) {
      var vendorName = session.vendor.charAt(0).toUpperCase() + session.vendor.slice(1);
      var authUser = session.ownerId ? usersModule.findUserById(session.ownerId) : null;
      var authLinuxUser = authUser && authUser.linuxUser ? authUser.linuxUser : null;
      var canAutoLogin = !!authLinuxUser
        || (authUser && authUser.role === "admin");
      var authState = getFreshAuthState();
      logAuthDecision("emit-auth-required", session, "missing adapter", authState);
      if (authState[session.vendor]) {
        sendAndRecord(session, {
          type: "error",
          text: vendorName + " auth is available, but the adapter could not be initialized.",
        });
        sendAndRecord(session, { type: "done", code: 1 });
        return;
      }
      var authMsg2 = {
        type: "auth_required",
        text: vendorName + " is not logged in.",
        vendor: session.vendor,
        loginCommand: getLoginCommand(session.vendor),
        linuxUser: authLinuxUser,
        canAutoLogin: canAutoLogin,
      };
      sendAndRecord(session, authMsg2);
      if (!notifyAuthRequired(
        session,
        vendorName + " is not logged in.",
        "Open a terminal, then click the URL and follow the instructions.",
        authLinuxUser,
        canAutoLogin,
        getLoginCommand(session.vendor)
      )) {
        // chat message already sent above
      }
      sendAndRecord(session, { type: "done", code: 1 });
      return;
    }
    // Select adapter based on session vendor (fallback to default)
    var sessionAdapter = (session.vendor && adapters[session.vendor]) || adapter;
    console.log("[sdk-bridge] startQuery: vendor=" + sessionAdapter.vendor + " session=" + session.localId + " text=" + (text || "").substring(0, 50));
    // Remember linuxUser for auto-continue after rate limit
    session.lastLinuxUser = linuxUser || null;

    var t0 = session._queryStartTs || Date.now();

    // lr-29f9: Enforce concurrent-session ceiling.
    // Count only NEW queries (session has no active queryInstance).
    // Multi-turn pushes to an existing query are not new processes — don't gate them.
    var isNewQuery = !session.queryInstance;
    if (isNewQuery && _activeLiveCount >= MAX_CONCURRENT_SESSIONS) {
      console.warn("[sdk-bridge] Concurrent session ceiling hit (" + _activeLiveCount + "/" + MAX_CONCURRENT_SESSIONS + ") — rejecting new query for session " + session.localId);
      session.isProcessing = false;
      onProcessingChanged();
      sendAndRecord(session, {
        type: "error",
        text: "Too many active sessions (" + _activeLiveCount + "/" + MAX_CONCURRENT_SESSIONS + "). Wait for an active session to finish or close unused sessions.",
      });
      sendAndRecord(session, { type: "done", code: 1 });
      sm.broadcastSessionList();
      return;
    }

    // lr-2d91: MemAvailable gate — check before claiming a slot so a rejected
    // query never increments the live counter.
    if (isNewQuery) {
      var memAvailMB = readMemAvailableMB();
      var getConfig = opts.getConfig;
      var memThresholdMB = DEFAULT_MEM_AVAILABLE_MIN_MB;
      if (typeof getConfig === "function") {
        var dc = getConfig();
        if (dc && typeof dc.memAvailableMinMB === "number" && dc.memAvailableMinMB > 0) {
          memThresholdMB = dc.memAvailableMinMB;
        }
      }
      if (memAvailMB !== null && memAvailMB < memThresholdMB) {
        console.warn("[sdk-bridge] MemAvailable gate: " + memAvailMB + " MB available, " + memThresholdMB + " MB required — rejecting new query for session " + session.localId);
        session.isProcessing = false;
        onProcessingChanged();
        var memMsg = "Not enough memory to start a new query (" + memAvailMB + " MB available, " + memThresholdMB + " MB required). Wait for an active session to finish or close unused sessions.";
        sendAndRecord(session, { type: "error", text: memMsg });
        sendAndRecord(session, { type: "done", code: 1 });
        send({ type: "toast", level: "warn", message: "Query blocked — not enough memory (" + memAvailMB + " MB available).", duration: 5000 });
        sm.broadcastSessionList();
        return;
      }
    }
    // lr-2d91 / lr-1f7e: context token guards — apply to ALL turns because long-running
    // sessions accumulate context across turns and each new turn will load the full
    // accumulated context into memory.  Placed after the memAvailableMinMB gate and
    // before the slot is claimed so a rejected query never increments the live counter.
    var contextTokens = session.lastStreamInputTokens || 0;
    if (contextTokens > 0) {
      // Read configurable fractions once so they are available to both checks below.
      var _guardCfg = typeof opts.getConfig === "function" ? opts.getConfig() : null;
      var cgWarnFraction = DEFAULT_CGROUP_WARN_FRACTION;
      var ctxWinWarnFraction = DEFAULT_CONTEXT_WINDOW_WARN_FRACTION;
      if (_guardCfg) {
        if (typeof _guardCfg.cgroupWarnFraction === "number" && _guardCfg.cgroupWarnFraction >= 0) {
          // 0 is a valid value meaning "disabled" — allow it to override the default
          cgWarnFraction = _guardCfg.cgroupWarnFraction;
        }
        if (typeof _guardCfg.contextWindowWarnFraction === "number" && _guardCfg.contextWindowWarnFraction >= 0) {
          // 0 is a valid value meaning "disabled" — allow it to override the default
          ctxWinWarnFraction = _guardCfg.contextWindowWarnFraction;
        }
      }

      // lr-1f7e: proactive model context-window warn.
      // Fires before the cgroup hard gate so the user gets an early signal.
      // Degrades cleanly when the model window is unknown (resolveModelContextWindow returns 0)
      // or when ctxWinWarnFraction is 0 (disabled via config).
      // Pass sm.currentBetas so context-1m beta is respected (mirrors app-panels.js logic).
      var _sessionModel = session.model || sm.currentModel || null;
      var _modelWindow = resolveModelContextWindow(_sessionModel, sm.currentBetas || []);
      if (_modelWindow > 0 && ctxWinWarnFraction > 0) {
        var _winWarnTokens = Math.floor(_modelWindow * ctxWinWarnFraction);
        if (contextTokens >= _winWarnTokens) {
          console.warn("[sdk-bridge] context-window warn: " + Math.round(contextTokens / 1000) + "K tokens >= " + Math.round(_winWarnTokens / 1000) + "K (" + Math.round(ctxWinWarnFraction * 100) + "% of " + Math.round(_modelWindow / 1000) + "K window) for session " + session.localId);
          send({ type: "toast", level: "warn", message: "Session context is " + Math.round((contextTokens / _modelWindow) * 100) + "% full (" + Math.round(contextTokens / 1000) + "K / " + Math.round(_modelWindow / 1000) + "K tokens). Consider starting a new session.", duration: 8000 });
        }
      }

      // lr-2d91: cgroup hard gate — block the query if context exceeds headroom.
      var cgHeadroomMB = readCgroupHeadroomMB();
      if (cgHeadroomMB !== null) {
        var tokensPerMb = DEFAULT_TOKENS_PER_MB_HEADROOM;
        if (_guardCfg && typeof _guardCfg.tokensPerMbHeadroom === "number" && _guardCfg.tokensPerMbHeadroom > 0) {
          tokensPerMb = _guardCfg.tokensPerMbHeadroom;
        }
        var allowedTokens = cgHeadroomMB * tokensPerMb;
        var warnTokens = Math.floor(allowedTokens * cgWarnFraction);
        if (contextTokens >= allowedTokens) {
          console.warn("[sdk-bridge] cgroup context guard: " + Math.round(contextTokens / 1000) + "K tokens >= " + Math.round(allowedTokens / 1000) + "K allowed (" + cgHeadroomMB + " MB headroom) — blocking session " + session.localId);
          session.isProcessing = false;
          onProcessingChanged();
          var blockMsg = "Session context too large for available memory (" + Math.round(contextTokens / 1000) + "K tokens, " + cgHeadroomMB + " MB headroom). Start a new session or wait for other sessions to complete.";
          sendAndRecord(session, { type: "error", text: blockMsg });
          sendAndRecord(session, { type: "done", code: 1 });
          send({ type: "toast", level: "error", message: "Session blocked — context too large for available memory.", duration: 7000 });
          sm.broadcastSessionList();
          return;
        } else if (cgWarnFraction > 0 && contextTokens >= warnTokens) {
          // cgWarnFraction === 0 means the warn is disabled; skip it.
          send({ type: "toast", level: "warn", message: "Large session context (" + Math.round(contextTokens / 1000) + "K tokens). Consider starting a new session to avoid memory pressure.", duration: 8000 });
        }
      }
    }

    // Claim the slot now so concurrent callers see the updated count immediately.
    // Set _isCountedLive on the session at the same time so any early-return path
    // below (sync throw, createQuery failure) can release it via releaseSlot().
    // A local helper is used so there is no window where the slot is claimed but
    // _isCountedLive is not yet set — the two always move together.
    function releaseSlot() {
      if (session._isCountedLive) {
        session._isCountedLive = false;
        _activeLiveCount = Math.max(0, _activeLiveCount - 1);
        console.log("[sdk-bridge] Live query count: " + _activeLiveCount + "/" + MAX_CONCURRENT_SESSIONS + " (session " + session.localId + " slot released)");
      }
    }
    if (isNewQuery) {
      _activeLiveCount++;
      session._isCountedLive = true;
      console.log("[sdk-bridge] Live query count: " + _activeLiveCount + "/" + MAX_CONCURRENT_SESSIONS + " (session " + session.localId + " starting)");
    }

    // Guard the rest of startQuery so any unexpected synchronous throw releases
    // the slot claimed above and surfaces a visible error (no spinner-forever).
    try {

    // Wait for previous worker to fully exit before spawning a new one.
    // Without this, the new worker may try to resume the SDK session file
    // while the old worker is still flushing it to disk, causing
    // "no conversation found" and losing all prior context.
    // Harmless if null (no previous worker).
    if (session._workerExitPromise) {
      var exitWait = session._workerExitPromise;
      session._workerExitPromise = null;
      await Promise.race([
        exitWait,
        new Promise(function(resolve) { setTimeout(resolve, 3000); }),
      ]);
    }

    // Ensure Linux user project directory exists (runs in parallel with worker boot)
    if (linuxUser) {
      ensureLinuxUserProjectDir(linuxUser, session);
    }

    session.blocks = {};
    session.sentToolResults = {};
    session.activeTaskToolIds = {};
    session.pendingElicitations = {};
    session.streamedText = false;
    session.responsePreview = "";

    // For in-process path, create AbortController. For worker path, the adapter
    // handles abort internally and exposes it via handle.abort().
    if (!linuxUser) {
      session.abortController = new AbortController();
    }

    // Build Claude-specific adapter options
    var claudeOpts = {
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      enableFileCheckpointing: true,
      extraArgs: { "replay-user-messages": null },
      promptSuggestions: true,
      agentProgressSummaries: true,
    };

    // lr-7db0 / lr-8e39 — surface per-session agent identity into the SDK
    // `agent` option. The SDK resolves the named agent from the same
    // settingSources catalog it uses internally — no in-band AgentDefinition
    // map is needed (that was a workaround for the old CLI-parse path).
    //
    // Agent injection is Claude Code-only. The Codex adapter has no equivalent
    // API surface, so we skip this block for Codex sessions. The UI already
    // hides the Agent Chat entry point for Codex projects; this guard is
    // belt-and-suspenders for sessions that carry agentName from a prior
    // vendor switch or a direct ws message.
    //
    // lr-4c90 — belt-and-suspenders tool enforcement: the SDK's `agent` option
    // should apply tool restrictions, but only does so when the agent file uses
    // JSON array syntax for the tools field. We read the tools list directly
    // from disk and set claudeOpts.tools explicitly so restriction is enforced
    // even if the SDK's parsing path has any quirks.
    // lr-5bd7 — declared outside the agent block so the model override can be
    // applied when queryModel is computed below (after loop-settings resolution).
    var _agentDeclaredModel = null;

    if (session.agentName && sessionAdapter.vendor !== 'codex') {
      claudeOpts.agent = session.agentName;
      var agentTools = readAgentToolsFromFile(session.agentName);
      if (agentTools) {
        claudeOpts.tools = agentTools;
        console.log("[sdk-bridge] agent tools enforced for " + session.agentName + ": " + agentTools.join(", "));
      }

      // lr-5bd7 — inject AGENT.md body as systemPrompt on the main thread.
      // The `agents` map approach (PR #264) only applies to subagent invocations
      // via the Agent tool; it does not deliver the body to the main conversation.
      // Setting claudeOpts.systemPrompt bypasses settingSources/agents-map resolution
      // and ensures the model receives the agent persona directly.
      // We keep claudeOpts.agent set — it still applies tool restrictions via settingSources.
      var agentSlug = slugifyAgentName(session.agentName);
      var agentFilePath = path.join(AGENTS_SOURCE_DIR, agentSlug + ".md");
      var agentRaw;
      try {
        agentRaw = fs.readFileSync(agentFilePath, "utf8");
      } catch (e) {
        agentRaw = null;
      }
      if (agentRaw) {
        var agentParsed = parseFrontmatter(agentRaw);
        var agentBody = agentParsed && agentParsed.body ? agentParsed.body.trim() : null;
        if (agentBody) {
          claudeOpts.systemPrompt = agentBody;
          console.log("[sdk-bridge] agent body injected as systemPrompt for " + session.agentName + " (" + agentBody.length + " chars)");
        }
        // lr-5bd7 — capture the agent's declared model so we can override queryModel below.
        // The UI-selected model (sm.currentModel / session.model) must not override the
        // agent's own model declaration (e.g. opus for holden).
        if (agentParsed && agentParsed.meta && agentParsed.meta.model) {
          _agentDeclaredModel = agentParsed.meta.model;
          console.log("[sdk-bridge] agent declared model for " + session.agentName + ": " + _agentDeclaredModel);
        }
      }
    }

    // Per-loop settings override global defaults when present
    var ls = session.loopSettings || {};

    if (sm.currentBetas && sm.currentBetas.length > 0) {
      claudeOpts.betas = sm.currentBetas;
    }
    var thinkingMode = ls.thinking || sm.currentThinking;
    if (thinkingMode === "disabled") {
      claudeOpts.thinking = { type: "disabled" };
    } else if (thinkingMode === "budget") {
      var budgetTokens = ls.thinkingBudget || sm.currentThinkingBudget;
      if (budgetTokens) claudeOpts.thinking = { type: "enabled", budgetTokens: budgetTokens };
    }

    if (ls.permissionMode) {
      session._loopPermissionMode = ls.permissionMode;
    }

    // Pass through any extra SDK settings from LOOP.json
    if (ls.disableAllHooks !== undefined) {
      claudeOpts.settings = Object.assign({}, claudeOpts.settings || {}, { disableAllHooks: ls.disableAllHooks });
    }

    if (dangerouslySkipPermissions) {
      claudeOpts.allowDangerouslySkipPermissions = true;
      claudeOpts.permissionMode = "bypassPermissions";
    } else {
      var globalMode = session.permissionMode || sm.currentPermissionMode || "default";
      var effectiveDefault;
      if (globalMode === "bypassPermissions") effectiveDefault = "bypassPermissions";
      else if (session.acceptEditsAfterStart) effectiveDefault = "acceptEdits";
      else effectiveDefault = globalMode;
      var modeToApply = session._loopPermissionMode || effectiveDefault;
      if (modeToApply && modeToApply !== "default") {
        claudeOpts.permissionMode = modeToApply;
      }
    }
    // Clear one-shot acceptEditsAfterStart regardless of which branch ran above,
    // so the flag does not linger into subsequent turns.
    if (session.acceptEditsAfterStart) delete session.acceptEditsAfterStart;
    if (session.cliSessionId && session.lastRewindUuid) {
      claudeOpts.resumeSessionAt = session.lastRewindUuid;
      delete session.lastRewindUuid;
      sm.saveSessionFile(session);
    }

    // Pass linuxUser to adapter for worker-based queries
    if (linuxUser) {
      claudeOpts.linuxUser = linuxUser;
      claudeOpts.singleTurn = !!session.singleTurn;
      claudeOpts.originalHome = require("./config").REAL_HOME || null;
      claudeOpts.projectPath = session.cwd || null;
      claudeOpts._perfT0 = t0;
      // Pass previous worker state for reuse
      if (session._adapterWorkerState) {
        claudeOpts._workerState = session._adapterWorkerState;
        session._adapterWorkerState = null;
      }
    }

    // Pick a model that belongs to the session's vendor. sm.currentModel is
    // shared project-wide, so a Codex session that last set it to
    // "gpt-5.4-mini" would otherwise leak into a Claude session in the same
    // project (or in another session that switches vendor to claude) and
    // Claude would reject the unknown model. We validate against the
    // session vendor's model list regardless of which vendor happens to be
    // the project's default adapter.
    var queryModel = (ls.model && ls.model !== "default" ? ls.model : null) || session.model || sm.currentModel || undefined;
    var sessionVendor = session.vendor || (adapter && adapter.vendor) || null;
    if (sessionVendor) {
      var vendorModels = (sm.modelsByVendor && sm.modelsByVendor[sessionVendor]) || [];
      if (vendorModels.length > 0 && queryModel && !modelListContains(vendorModels, queryModel)) {
        var resolved = resolveModelInList(vendorModels, queryModel);
        queryModel = resolved || modelEntryValue(vendorModels[0]);
      }
    }
    // Guard against anything upstream having set queryModel to an object
    // (e.g. a cached ModelInfo leaked through). Always coerce to string id.
    if (queryModel && typeof queryModel !== "string") {
      queryModel = modelEntryValue(queryModel) || undefined;
    }

    // lr-5bd7 — agent model wins over the UI-selected model. Apply after all
    // vendor-validation logic so the agent model goes through as-is (it is
    // already a valid short-form like "opus" or a full model ID).
    if (_agentDeclaredModel) {
      queryModel = _agentDeclaredModel;
      console.log("[sdk-bridge] agent model override applied: " + queryModel);
    }

    var codexConfig = getCodexConfig(sm);
    var mergedMcpServers = mergeMcpServers(getMcpServers(), getRemoteMcpServers) || undefined;
    var queryOpts = {
      cwd: cwd,
      model: queryModel,
      effort: ls.effort || sm.currentEffort || undefined,
      toolServers: mergedMcpServers,
      toolServerDescriptors: extractMcpDescriptors(mergedMcpServers) || undefined,
      resumeSessionId: session.cliSessionId || undefined,
      abortController: linuxUser ? undefined : session.abortController,
      canUseTool: function(toolName, input, toolOpts) {
        return handleCanUseTool(session, toolName, input, toolOpts);
      },
      onElicitation: function(request, elicitOpts) {
        return handleElicitation(session, request, elicitOpts);
      },
      callMcpTool: function(serverName, toolName, args) {
        return callMcpToolHandler(mergedMcpServers, serverName, toolName, args);
      },
      adapterOptions: {
        CLAUDE: claudeOpts,
        CODEX: {
          // lr-f7a4 — honor the user-configured approval policy instead of
          // hardwiring "never". approvalPolicy only controls Codex's own
          // terminal-native approval UI; every requestApproval /
          // requestUserInput notification the app-server sends is already
          // routed through canUseTool -> handleCanUseTool -> the same
          // WebSocket permission_request prompt Claude sessions use (see
          // handleServerEvent in lib/yoke/adapters/codex.js). So honoring
          // the configured policy here does not reintroduce the
          // terminal-prompt hang this code previously guarded against.
          approvalPolicy: codexConfig.approval,
          sandboxMode: codexConfig.sandbox,
          webSearchMode: codexConfig.webSearch,
        },
      },
    };

    var handle;
    console.log("[sdk-bridge] calling adapter.createQuery... vendor=" + sessionAdapter.vendor);
    try {
      handle = await sessionAdapter.createQuery(queryOpts);
      console.log("[sdk-bridge] createQuery returned handle, vendor=" + sessionAdapter.vendor);
    } catch (e) {
      console.error("[sdk-bridge] Failed to create query for session " + session.localId + ":", e.message || e);
      console.error("[sdk-bridge] cliSessionId:", session.cliSessionId, "resume:", !!session.cliSessionId);
      console.error("[sdk-bridge] Stack:", e.stack || "(no stack)");
      releaseSlot();
      session.isProcessing = false;
      onProcessingChanged();
      session.queryInstance = null;
      session.messageQueue = null;
      session.abortController = null;
      sendAndRecord(session, { type: "error", text: "Failed to start query: " + (e.message || e) });
      sendAndRecord(session, { type: "done", code: 1 });
      sm.broadcastSessionList();
      return;
    }

    // Store adapter worker state for reuse on next query
    if (handle._adapterState) {
      session._adapterWorkerState = handle._adapterState;
      // Keep session.worker reference for external code (sessions.js, project.js)
      // that needs to kill the worker on session destroy.
      if (handle._adapterState.worker) {
        session.worker = handle._adapterState.worker;
      }
    }

    // For worker path, create an abortController wrapper that delegates to handle.abort()
    if (linuxUser) {
      session.abortController = {
        abort: function() { handle.abort(); },
        signal: { aborted: false, addEventListener: function() {} },
      };
    }

    // Store QueryHandle on session for iteration and control.
    session.queryInstance = handle;

    // Push initial user message through the QueryHandle
    console.log("[sdk-bridge] pushing initial message via handle.pushMessage...");
    handle.pushMessage(text, images);

    // lr-b61b: Flush any messages that arrived between turns (after the previous
    // finally block nulled queryInstance and before this startQuery call).
    if (session.pendingMessages && session.pendingMessages.length > 0) {
      console.log("[sdk-bridge] startQuery: flushing " + session.pendingMessages.length + " buffered pending message(s) for session " + session.localId);
      for (var pi = 0; pi < session.pendingMessages.length; pi++) {
        var pm = session.pendingMessages[pi];
        handle.pushMessage(pm.text, pm.images);
      }
      session.pendingMessages = [];
    }

    console.log("[sdk-bridge] pushMessage done, starting processQueryStream...");

    // For single-turn sessions (Ralph Loop), end the message queue so the SDK
    // query finishes after processing the one message. Without this, the query
    // stream stays open forever waiting for more messages, and onQueryComplete
    // never fires.
    if (session.singleTurn) {
      handle.endInput();
    }

    session.lastActivityAt = Date.now();
    session.streamPromise = processQueryStream(session).catch(function(err) {
      console.error("[sdk-bridge] Unhandled stream error for session " + session.localId + ":", err && err.message || err);
      sendToSession(session, { type: "error", text: "Stream error: " + (err && err.message || String(err)) });
      sendToSession(session, { type: "done", code: 1 });
    });

    } catch (startErr) {
      // Unexpected synchronous throw anywhere in the post-slot-claim body.
      // Release the slot and surface the error so the UI does not spin forever.
      releaseSlot();
      session.isProcessing = false;
      onProcessingChanged();
      session.queryInstance = null;
      session.messageQueue = null;
      session.abortController = null;
      console.error("[sdk-bridge] Unexpected error in startQuery for session " + session.localId + ":", startErr && startErr.message || startErr);
      sendAndRecord(session, { type: "error", text: "Failed to start query: " + (startErr && startErr.message || String(startErr)) });
      sendAndRecord(session, { type: "done", code: 1 });
      sm.broadcastSessionList();
    }
  }

  function pushMessage(session, text, images) {
    session.lastActivityAt = Date.now();
    // Route through QueryHandle (works for both in-process and worker paths)
    if (session.queryInstance && typeof session.queryInstance.pushMessage === "function") {
      session.queryInstance.pushMessage(text, images);
    } else {
      // lr-b61b: queryInstance is null between turns (finally block has run but
      // startQuery has not been called yet). Buffer the message so it is not
      // silently dropped; startQuery will flush it after the handle is created.
      if (!session.pendingMessages) session.pendingMessages = [];
      session.pendingMessages.push({ text: text, images: images });
      console.log("[sdk-bridge] pushMessage: queryInstance null, buffered message for session " + session.localId + " (pending=" + session.pendingMessages.length + ")");
    }
  }

  function permissionPushTitle(toolName, input) {
    if (!input) return "Claude wants to use " + toolName;
    var file = input.file_path ? input.file_path.split(/[/\\]/).pop() : "";
    switch (toolName) {
      case "Bash": return "Claude wants to run a command";
      case "Edit": return "Claude wants to edit " + (file || "a file");
      case "Write": return "Claude wants to write " + (file || "a file");
      case "Read": return "Claude wants to read " + (file || "a file");
      case "Grep": return "Claude wants to search files";
      case "Glob": return "Claude wants to find files";
      case "WebFetch": return "Claude wants to fetch a URL";
      case "WebSearch": return "Claude wants to search the web";
      case "Task": return "Claude wants to launch an agent";
      default: return "Claude wants to use " + toolName;
    }
  }

  function permissionPushBody(toolName, input) {
    if (!input) return "";
    var text = "";
    if (toolName === "Bash" && input.command) {
      text = input.command;
    } else if (toolName === "Edit" && input.file_path) {
      text = input.file_path.split(/[/\\]/).pop() + ": " + (input.old_string || "").substring(0, 40) + " \u2192 " + (input.new_string || "").substring(0, 40);
    } else if (toolName === "Write" && input.file_path) {
      text = input.file_path;
    } else if (input.file_path) {
      text = input.file_path;
    } else if (input.command) {
      text = input.command;
    } else if (input.url) {
      text = input.url;
    } else if (input.query) {
      text = input.query;
    } else if (input.pattern) {
      text = input.pattern;
    } else if (input.description) {
      text = input.description;
    }
    if (text.length > 120) text = text.substring(0, 120) + "...";
    return text;
  }

  // Detect which vendor binaries are installed for this user.
  // In multi-user mode, runs checks as the specific Linux user.
  function detectInstalledVendors(linuxUser) {
    var execFileSync = require("child_process").execFileSync;
    var fs = require("fs");
    var result = [];

    function tryLookup(name) {
      // name MUST be a value from the allowlist below — shell injection risk if dynamic
      if (!["claude", "codex"].includes(name)) throw new Error("Disallowed binary name: " + name);
      try {
        if (linuxUser) {
          execFileSync("su", ["-", linuxUser, "-c", "which " + name], { timeout: 3000, stdio: ["pipe", "pipe", "pipe"] });
        } else {
          if (process.platform === "win32") execFileSync("where", [name], { timeout: 3000, stdio: ["pipe", "pipe", "pipe"] });
          else execFileSync("which", [name], { timeout: 3000, stdio: ["pipe", "pipe", "pipe"] });
        }
        return true;
      } catch (e) {
        return false;
      }
    }

    // Claude: check if binary is in PATH
    if (tryLookup("claude")) result.push("claude");

    // Codex: check bundled binary or PATH
    var codexBin = null;
    try {
      codexBin = require("./yoke/codex-app-server").findCodexPath();
    } catch (e) {}
    if ((codexBin && fs.existsSync(codexBin)) || tryLookup("codex")) result.push("codex");

    return result;
  }

  // SDK warmup: initialize all available adapters and collect models.
  // The default adapter is initialized first for slash_commands and skills.
  // Passes linuxUser to adapter for worker-based warmup when OS isolation is needed.
  async function warmup(linuxUser) {
    var defaultVendor = adapter ? adapter.vendor : "claude";
    sm.defaultVendor = defaultVendor;

    // Initialize default adapter first (provides skills, slash commands, etc.)
    if (adapter) {
      try {
        var result = await adapter.init({
          cwd: cwd,
          dangerouslySkipPermissions: dangerouslySkipPermissions,
          linuxUser: linuxUser || undefined,
          clayPort: clayPort,
          clayTls: clayTls,
          clayAuthToken: clayAuthToken,
          slug: slug,
        });

        var fsSkills = discoverSkillDirs();
        sm.skillNames = mergeSkills(result.skills, fsSkills);
        sm.workflowMeta = discoverWorkflows(cwd);
        // Enriched skill metadata (lr-7d8d)
        var fsSkillsMeta = discoverSkillsWithMeta(cwd);
        sm.skillMeta = mergeSkillsWithMeta(result.skills, fsSkillsMeta);
        if (result.slashCommands) {
          // Build enriched {name,desc,type}[] using the shared helper (lr-cf84).
          // Applies skill/workflow priority chain at warmup time, matching the
          // live-query init path so the UI receives enriched objects on connect.
          var combined = buildEnrichedSlashCommands(result.slashCommands, cwd);
          sm.slashCommands = combined;
          sm.setSlashCommandsForVendor(defaultVendor, combined);
          send({ type: "slash_commands", commands: combined, vendor: defaultVendor });
        }
        if (result.defaultModel) {
          sm.currentModel = sm.currentModel || sm._savedDefaultModel || result.defaultModel;
        }
        sm.availableModels = result.models || [];
        // Store per-vendor models and capabilities
        sm.modelsByVendor = sm.modelsByVendor || {};
        sm.modelsByVendor[defaultVendor] = result.models || [];
        sm.capabilitiesByVendor = sm.capabilitiesByVendor || {};
        sm.capabilitiesByVendor[defaultVendor] = result.capabilities || {};

        // lr-1a26: Console-side settings preflight (epic lr-1a52 stage 5/5).
        // Non-blocking: runs after warmup succeeds, errors are swallowed so
        // preflight never blocks or fails the init path. Results are sent as
        // diagnostic events through the same pipeline stages 2-4 established.
        try {
          var preflightDiags = runPreflight({ projectDir: cwd });
          for (var _pi = 0; _pi < preflightDiags.length; _pi++) {
            send(preflightDiags[_pi]);
          }
        } catch (preflightErr) {
          // Swallow all preflight errors — preflight must never affect init.
          console.warn("[sdk-bridge] settings preflight failed (non-fatal):", preflightErr && preflightErr.message || preflightErr);
        }
      } catch (e) {
        if (e && e.name !== "AbortError" && !(e.message && e.message.indexOf("aborted") !== -1)) {
          send({ type: "error", text: "Failed to load " + defaultVendor + " SDK: " + (e.message || e) });
        }
      }
    }

    // Non-default adapters are NOT eagerly initialized here. Doing so used
    // to spawn a CodexAppServer and an mcp-bridge child per project even
    // when the user never touched that vendor. Lazy paths cover the gap:
    //   - get_vendor_models (project.js) inits a vendor when the user
    //     opens its model picker.
    //   - ensureVendorReady (this file) inits a vendor when a session
    //     actually issues a query with it.
    sm.modelsByVendor = sm.modelsByVendor || {};

    // Detect installed vendors per-user (binary existence check)
    sm.installedVendors = detectInstalledVendors(linuxUser);
    sm.availableVendors = Object.keys(adapters);

    // Send initial state to client
    send({
      type: "model_info",
      model: sm.currentModel || "",
      models: getModelsForVendor(defaultVendor),
      vendor: defaultVendor,
      availableVendors: sm.availableVendors,
      installedVendors: sm.installedVendors,
    });
  }

  async function setModel(session, model) {
    // Normalize to string id in case a { value, displayName } object slips in
    if (model && typeof model !== "string") {
      model = modelEntryValue(model);
    }
    if (!session.queryInstance) {
      // No active query — store on session and shared state for next startQuery
      session.model = model;
      sm.currentModel = model;
      // Don't send vendor here: session vendor not yet bound, let client keep its selection
      sendModelInfoForVendor(null, model);
      // config_state is sent targeted by the caller (project-sessions.js) to
      // avoid broadcasting this session's model to all other open sessions.
      return;
    }
    try {
      await session.queryInstance.setModel(model);
      session.model = model;
      sm.currentModel = model;
      var sessionVendor = session.vendor || (adapter && adapter.vendor) || "claude";
      sendModelInfoForVendor(sessionVendor, model);
      // config_state sent targeted by caller — no broadcast here.
    } catch (e) {
      send({ type: "error", text: "Failed to switch model: " + (e.message || e) });
    }
  }

  async function setEffort(session, effort) {
    if (!session.queryInstance) {
      sm.currentEffort = effort;
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort, betas: sm.currentBetas || [] });
      return;
    }
    // Route through QueryHandle (works for both in-process and worker paths)
    if (typeof session.queryInstance.setEffort === "function") {
      await session.queryInstance.setEffort(effort);
    }
    sm.currentEffort = effort;
    send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort, betas: sm.currentBetas || [] });
  }

  async function setPermissionMode(session, mode) {
    if (!session.queryInstance) {
      // No active query — store on session only (not sm — that's for project defaults).
      // config_state sent targeted by caller (project-sessions.js).
      session.permissionMode = mode;
      return;
    }
    try {
      // Route through QueryHandle (works for both in-process and worker paths)
      await session.queryInstance.setPermissionMode(mode);
      session.permissionMode = mode;
      // config_state sent targeted by caller — no broadcast here.
    } catch (e) {
      send({ type: "error", text: "Failed to set permission mode: " + (e.message || e) });
    }
  }

  async function stopTask(taskId, session) {
    // Accept an explicit session so multi-session installs stop the correct
    // session rather than the globally-active one (lr-e0de). Falls back to
    // sm.getActiveSession() so single-user installs are unaffected.
    if (!session) session = sm.getActiveSession();
    if (!session) return;
    session.taskStopRequested = true;
    if (!session.queryInstance) return;
    try {
      // Route through QueryHandle (works for both in-process and worker paths)
      await session.queryInstance.stopTask(taskId);
    } catch (e) {
      console.error("[sdk-bridge] stopTask error:", e.message);
    }
    // SDK stopTask doesn't reliably stop the sub-agent, so abort the entire
    // session as a fallback to ensure the process actually stops.
    if (session.abortController) {
      session.abortController.abort();
    }
  }

  // lr-2d91: Expose live concurrency stats for process_stats WS response.
  // Called by project-sessions.js when building the process_stats payload.
  function getMemoryStats() {
    return {
      activeLiveCount: _activeLiveCount,
      maxConcurrentSessions: MAX_CONCURRENT_SESSIONS,
    };
  }

  return {
    createMessageQueue: createMessageQueue,
    processSDKMessage: processSDKMessage,
    checkToolWhitelist: checkToolWhitelist,
    handleCanUseTool: handleCanUseTool,
    handleElicitation: handleElicitation,
    processQueryStream: processQueryStream,
    getOrCreateRewindQuery: getOrCreateRewindQuery,
    rewindPreview: rewindPreview,
    rewindExecuteFiles: rewindExecuteFiles,
    rollbackConversation: rollbackConversation,
    forkSession: forkSessionUnified,
    startQuery: startQuery,
    pushMessage: pushMessage,
    setModel: setModel,
    setEffort: setEffort,
    setPermissionMode: setPermissionMode,
    isClaudeProcess: isClaudeProcess,
    permissionPushTitle: permissionPushTitle,
    permissionPushBody: permissionPushBody,
    warmup: warmup,
    stopTask: stopTask,
    startIdleReaper: startIdleReaper,
    stopIdleReaper: stopIdleReaper,
    getMemoryStats: getMemoryStats,
  };
}

// Return the current number of active live queries across ALL bridge instances.
// Used by the drain controller (lr-6b30) to decide when it is safe to exit.
function getActiveLiveCount() {
  return _activeLiveCount;
}

module.exports = { createSDKBridge, createMessageQueue, readMemAvailableMB, readCgroupHeadroomMB, resolveModelContextWindow, DEFAULT_MEM_AVAILABLE_MIN_MB, DEFAULT_TOKENS_PER_MB_HEADROOM, getActiveLiveCount };


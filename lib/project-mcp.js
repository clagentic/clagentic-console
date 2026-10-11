var crypto = require("crypto");
var mcpToolSchema = require("./mcp-tool-schema");
var { buildZodShape } = require("./mcp-json-schema-to-zod");

// MCP Bridge module: manages remote MCP servers reported by the Chrome Extension.
// Creates proxy MCP server objects that forward tool calls over WebSocket.
// Follows the attachXxx(ctx) pattern per MODULE_MAP.md.

function attachMcp(ctx) {
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var slug = ctx.slug;
  var getEnabledMcpServers = ctx.getEnabledMcpServers;
  var setEnabledMcpServers = ctx.setEnabledMcpServers;
  var getExtensionWs = ctx.getExtensionWs;
  var getExtensionId = ctx.getExtensionId || function () { return null; };
  var localMcp = ctx.localMcp || null; // mcp-local instance for localhost clients

  // The three tables below are keyed by names and ids a client reports, so
  // they have no prototype to answer for "constructor" or "__proto__".

  // Available servers reported by extension: { name -> { name, transport, tools, enabled } }
  var _availableServers = Object.create(null);

  // Proxy MCP server objects for the SDK: { name -> sdkMcpServerConfig }
  var _proxyServers = Object.create(null);

  // Pending tool calls: { callId -> { resolve, reject, timer, ws } }
  // `ws` is the extension socket the call was sent to; only it may answer.
  var _pendingCalls = Object.create(null);

  var TOOL_TIMEOUT_MS = 30000;

  // ---------- Message Handler ----------

  function handleMcpMessage(ws, msg) {
    if (msg.type === "mcp_servers_available") {
      handleServersAvailable(ws, msg);
      return true;
    }
    if (msg.type === "mcp_tool_result") {
      handleToolResult(ws, msg);
      return true;
    }
    if (msg.type === "mcp_tool_error") {
      handleToolError(ws, msg);
      return true;
    }
    if (msg.type === "mcp_toggle_server") {
      handleToggleServer(ws, msg);
      return true;
    }
    return false;
  }

  var _remoteHostConnected = false;

  function handleServersAvailable(ws, msg) {
    var servers = Array.isArray(msg.servers) ? msg.servers : [];
    _remoteHostConnected = !!msg.hostConnected;
    _availableServers = Object.create(null);
    for (var i = 0; i < servers.length; i++) {
      var s = servers[i];
      if (!s || typeof s !== "object" || typeof s.name !== "string") continue;
      _availableServers[s.name] = {
        name: s.name,
        transport: s.transport || "stdio",
        tools: Array.isArray(s.tools) ? s.tools : [],
        enabled: s.enabled !== false,
      };
    }

    // Rebuild proxy servers based on project-level enabled list
    rebuildProxyServers();

    // Broadcast updated state to all clients
    broadcastMcpState();
  }

  // The call a result or error answers, if the socket that sent it is the
  // socket the call went to; otherwise null and the pending call is untouched.
  function takePendingCall(ws, callId) {
    if (typeof callId !== "string") return null;
    var pending = _pendingCalls[callId];
    if (!pending || pending.ws !== ws) return null;
    if (pending.timer) clearTimeout(pending.timer);
    delete _pendingCalls[callId];
    return pending;
  }

  function handleToolResult(ws, msg) {
    var pending = takePendingCall(ws, msg.callId);
    if (!pending) return;
    pending.resolve(msg.result || { content: [{ type: "text", text: "(empty result)" }] });
  }

  function handleToolError(ws, msg) {
    var pending = takePendingCall(ws, msg.callId);
    if (!pending) return;
    pending.reject(new Error(typeof msg.error === "string" && msg.error ? msg.error : "MCP tool call failed"));
  }

  function handleToggleServer(ws, msg) {
    var name = msg.name;
    if (typeof name !== "string" || !name) return;
    var enabled = !!msg.enabled;

    var list = getEnabledMcpServers() || [];
    var idx = list.indexOf(name);

    if (enabled && idx === -1) {
      list.push(name);
    } else if (!enabled && idx !== -1) {
      list.splice(idx, 1);
    }

    setEnabledMcpServers(list);
    rebuildProxyServers();
    broadcastMcpState();
  }

  // ---------- Proxy Server Builder ----------

  function rebuildProxyServers() {
    _proxyServers = Object.create(null);

    var sdk;
    try {
      sdk = require("@anthropic-ai/claude-agent-sdk");
    } catch (e) {
      console.error("[mcp-bridge] Failed to load SDK:", e.message);
      return;
    }

    var createSdkMcpServer = sdk.createSdkMcpServer;
    var tool = sdk.tool;
    if (!createSdkMcpServer || !tool) {
      console.error("[mcp-bridge] SDK missing createSdkMcpServer or tool helper");
      return;
    }

    var z;
    try { z = require("zod").z; } catch (e) {
      try { z = require("zod"); } catch (e2) {
        console.error("[mcp-bridge] Failed to load zod:", e2.message);
        return;
      }
    }

    var enabledList = getEnabledMcpServers() || [];

    // --- Remote servers (via Extension) ---
    var serverNames = Object.keys(_availableServers);
    for (var si = 0; si < serverNames.length; si++) {
      var serverName = serverNames[si];
      var serverInfo = _availableServers[serverName];

      if (!serverInfo.enabled) continue;
      if (enabledList.indexOf(serverName) === -1) continue;

      var tools = [];
      var serverTools = serverInfo.tools || [];

      for (var ti = 0; ti < serverTools.length; ti++) {
        var mcpTool = serverTools[ti];
        var toolName = mcpTool.name;
        var toolDesc = mcpTool.description || toolName;
        var shape = shapeOrSkip(z, serverName, toolName, mcpTool.inputSchema);
        if (!shape) continue;

        tools.push(tool(
          toolName,
          toolDesc,
          shape,
          createToolHandler(serverName, toolName)
        ));
      }

      if (tools.length > 0) {
        var mcpServer = createSdkMcpServer({
          name: serverName,
          version: "1.0.0",
          tools: tools,
        });
        _proxyServers[serverName] = mcpServer;
      }
    }

    // --- Local servers (direct process, localhost only) ---
    if (localMcp && localMcp.isReady()) {
      var localServers = localMcp.getAvailableServers();
      for (var li = 0; li < localServers.length; li++) {
        var ls = localServers[li];
        if (!ls.ready) continue;
        if (_proxyServers[ls.name]) continue; // remote takes precedence if same name
        if (enabledList.indexOf(ls.name) === -1) continue;

        var localTools = [];
        for (var lti = 0; lti < ls.tools.length; lti++) {
          var lt = ls.tools[lti];
          var ltShape = shapeOrSkip(z, ls.name, lt.name, lt.inputSchema);
          if (!ltShape) continue;
          localTools.push(tool(
            lt.name,
            lt.description || lt.name,
            ltShape,
            createLocalToolHandler(ls.name, lt.name)
          ));
        }

        if (localTools.length > 0) {
          _proxyServers[ls.name] = createSdkMcpServer({
            name: ls.name,
            version: "1.0.0",
            tools: localTools,
          });
        }
      }
    }
  }

  function createLocalToolHandler(serverName, toolName) {
    return function (args) {
      return localMcp.callTool(serverName, toolName, args);
    };
  }

  function createToolHandler(serverName, toolName) {
    return function (args) {
      return new Promise(function (resolve, reject) {
        var extWs = getExtensionWs();
        if (!extWs || extWs.readyState !== 1) {
          reject(new Error("Browser extension not connected. Cannot reach MCP server: " + serverName));
          return;
        }

        var callId = "mc_" + Date.now() + "_" + crypto.randomUUID().slice(0, 8);

        var timer = setTimeout(function () {
          console.log("[mcp-bridge] Tool call TIMEOUT: " + callId + " server=" + serverName + " tool=" + toolName);
          delete _pendingCalls[callId];
          reject(new Error("MCP tool call timed out after " + (TOOL_TIMEOUT_MS / 1000) + "s"));
        }, TOOL_TIMEOUT_MS);

        _pendingCalls[callId] = { resolve: resolve, reject: reject, timer: timer, ws: extWs };

        console.log("[mcp-bridge] Sending tool call: " + callId + " server=" + serverName + " tool=" + toolName);
        sendTo(extWs, {
          type: "mcp_tool_call",
          callId: callId,
          server: serverName,
          method: "tools/call",
          params: { name: toolName, arguments: args },
        });
      });
    };
  }

  // The zod shape for a tool's JSON input schema, or null when the schema
  // cannot be reproduced exactly: the tool is then left out and reported
  // (never registered with a looser schema than it declared).
  function shapeOrSkip(z, serverName, toolName, inputSchema) {
    try {
      return buildZodShape(z, inputSchema);
    } catch (e) {
      mcpToolSchema.reportSkippedTool(serverName, toolName, (e && e.message) || String(e), send);
      return null;
    }
  }

  // ---------- State Broadcasting ----------

  function broadcastMcpState() {
    var state = buildMcpState();
    send(state);
  }

  function sendConnectionState(ws) {
    sendTo(ws, buildMcpState());
  }

  function buildMcpState() {
    var enabledList = getEnabledMcpServers() || [];
    var servers = [];
    var seen = Object.create(null);

    // Remote servers (from Extension)
    var names = Object.keys(_availableServers);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var info = _availableServers[name];
      seen[name] = true;
      servers.push({
        name: name,
        transport: info.transport,
        toolCount: (info.tools || []).length,
        extensionEnabled: info.enabled,
        projectEnabled: enabledList.indexOf(name) !== -1,
        source: "remote",
      });
    }

    // Local servers
    if (localMcp && localMcp.isReady()) {
      var localServers = localMcp.getAvailableServers();
      for (var j = 0; j < localServers.length; j++) {
        var ls = localServers[j];
        if (seen[ls.name]) continue;
        servers.push({
          name: ls.name,
          transport: ls.transport || "stdio",
          toolCount: ls.toolCount || 0,
          extensionEnabled: true,
          projectEnabled: enabledList.indexOf(ls.name) !== -1,
          source: "local",
        });
      }
    }

    return {
      type: "mcp_servers_state",
      servers: servers,
      hostConnected: _remoteHostConnected || !!(localMcp && localMcp.isReady()),
      extensionId: getExtensionId() || null,
    };
  }

  // ---------- Public API ----------

  function getMcpServers() {
    return _proxyServers;
  }

  function cancelAllPending() {
    var ids = Object.keys(_pendingCalls);
    for (var i = 0; i < ids.length; i++) {
      var pending = _pendingCalls[ids[i]];
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error("MCP bridge disconnected"));
    }
    _pendingCalls = Object.create(null);
  }

  function handleExtensionDisconnect() {
    cancelAllPending();
    _availableServers = Object.create(null);
    _proxyServers = Object.create(null);
    broadcastMcpState();
  }

  function rebuildAndBroadcast() {
    rebuildProxyServers();
    broadcastMcpState();
  }

  return {
    handleMcpMessage: handleMcpMessage,
    getMcpServers: getMcpServers,
    sendConnectionState: sendConnectionState,
    handleExtensionDisconnect: handleExtensionDisconnect,
    rebuildAndBroadcast: rebuildAndBroadcast,
  };
}

module.exports = { attachMcp: attachMcp };


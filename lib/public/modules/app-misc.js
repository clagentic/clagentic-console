// app-misc.js - Force PIN, PWA install, extension bridge; re-exports the image, paste and confirm modals
// Extracted from app.js (PR-34)

import { iconHtml } from './icons.js';
import { escapeHtml, copyToClipboard } from './utils.js';
import { getWs } from './ws-ref.js';
import { updateBrowserTabList } from './context-sources.js';
import { setExtensionConnected } from './mcp-ui.js';
import { showOverlay } from './overlay.js';

// --- Module-owned state ---
var _extRequestCallbacks = {};

// Queue for extension messages that arrived before WS was ready
var _pendingExtMessages = [];
// Cache last extension state so we can resend on WS reconnect (server restart)
var _lastTabListMsg = null;
var _lastMcpServersMsg = null;

function sendOrQueue(msgObj) {
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msgObj));
  } else {
    _pendingExtMessages.push(msgObj);
  }
}

export function flushPendingExtMessages() {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return;
  // Flush queued messages from before WS was ready
  if (_pendingExtMessages.length > 0) {
    var queued = _pendingExtMessages.slice();
    _pendingExtMessages = [];
    for (var i = 0; i < queued.length; i++) {
      ws.send(JSON.stringify(queued[i]));
    }
  }
  // Resend cached extension state on every WS reconnect so the server
  // re-registers _extensionWs and rebuilds MCP proxy servers
  if (_lastTabListMsg) ws.send(JSON.stringify(_lastTabListMsg));
  if (_lastMcpServersMsg) ws.send(JSON.stringify(_lastMcpServersMsg));
}

export function initMisc() {
  // --- PWA install prompt ---
  (function () {
    var installPill = document.getElementById("pwa-install-pill");
    var modal = document.getElementById("pwa-install-modal");
    var confirmBtn = document.getElementById("pwa-modal-confirm");
    var cancelBtn = document.getElementById("pwa-modal-cancel");
    if (!installPill || !modal) return;

    // Already standalone -- never show
    if (document.documentElement.classList.contains("pwa-standalone")) return;

    // Show pill on mobile browsers (the primary target for PWA install)
    var isMobile = /Mobi|Android|iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (isMobile) {
      installPill.classList.remove("hidden");
    }

    // Also show on desktop if beforeinstallprompt fires
    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      installPill.classList.remove("hidden");
    });

    var handle = null;

    function openModal() {
      handle = showOverlay({ kind: "modal", el: modal });
      lucide.createIcons({ nodes: [modal] });
    }

    function closeModal() {
      if (handle) handle.close();
    }

    installPill.addEventListener("click", openModal);
    cancelBtn.addEventListener("click", closeModal);

    confirmBtn.addEventListener("click", function () {
      var port = parseInt(location.port, 10);
      var setupUrl;
      if (!port) {
        setupUrl = location.protocol + "//" + location.hostname + "/setup";
      } else {
        // Non-standard port: onboarding server runs on port+1
        setupUrl = "http://" + location.hostname + ":" + (port + 1) + "/setup";
      }
      closeModal();
      location.href = setupUrl;
    });

    // Hide after install
    window.addEventListener("appinstalled", function () {
      installPill.classList.add("hidden");
      closeModal();
    });
  })();

  // --- Extension bridge window message listener ---
  window.addEventListener("message", function(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== "clay-chrome-extension") return;
    var msg = event.data.payload;

    if (msg.type === "clay_ext_tab_list") {
      setExtensionConnected(true);
      updateBrowserTabList(msg.tabs);
      // Cache and send (or queue) - resent on WS reconnect via flushPendingExtMessages
      _lastTabListMsg = { type: "browser_tab_list", tabs: msg.tabs };
      sendOrQueue(_lastTabListMsg);
    }
    if (msg.type === "clay_ext_result") {
      handleExtensionResult(msg.requestId, msg.result);
    }
    if (msg.type === "clay_ext_disconnected") {
      setExtensionConnected(false);
    }

    // MCP bridge: extension reports available MCP servers (queue if WS not ready yet)
    // Cache for resend on WS reconnect (server restart loses _availableServers)
    if (msg.type === "mcp_servers_available") {
      _lastMcpServersMsg = {
        type: "mcp_servers_available",
        servers: msg.servers,
        hostConnected: msg.hostConnected
      };
      sendOrQueue(_lastMcpServersMsg);
    }

    // MCP bridge: tool result from extension (tool results should not be queued,
    // if WS is down the call already timed out server-side)
    if (msg.type === "mcp_tool_result") {
      var ws3 = getWs();
      if (ws3 && ws3.readyState === 1) {
        ws3.send(JSON.stringify({
          type: msg.error ? "mcp_tool_error" : "mcp_tool_result",
          callId: msg.callId,
          result: msg.result || null,
          error: msg.error || null
        }));
      }
    }
  });
}

// Forward an MCP tool call from the server to the Chrome extension
export function forwardMcpToolCall(msg) {
  console.log("[mcp] forwarding to extension:", msg.callId, msg.server, msg.method);
  window.postMessage({
    source: "clay-page",
    payload: {
      type: "clay_mcp_tool_call",
      callId: msg.callId,
      server: msg.server,
      method: msg.method,
      params: msg.params,
    }
  }, "*");
}

// Forward an MCP tool call directly via HTTP for HTTP-transport servers
var _httpMcpServers = {}; // name -> url
export function setHttpMcpServers(servers) {
  _httpMcpServers = {};
  for (var i = 0; i < servers.length; i++) {
    if (servers[i].transport === "http" && servers[i].url) {
      _httpMcpServers[servers[i].name] = servers[i].url;
    }
  }
}

export function handleMcpToolCallMessage(msg) {
  console.log("[mcp] tool call received from server:", msg.callId, msg.server, msg.params && msg.params.name);
  var httpUrl = _httpMcpServers[msg.server];
  if (httpUrl) {
    // HTTP transport: call directly via fetch
    fetch(httpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: msg.callId,
        method: msg.method,
        params: msg.params,
      }),
    })
    .then(function (resp) { return resp.json(); })
    .then(function (data) {
      var ws = getWs();
      if (ws && ws.readyState === 1) {
        if (data.error) {
          ws.send(JSON.stringify({
            type: "mcp_tool_error",
            callId: msg.callId,
            error: data.error.message || JSON.stringify(data.error),
          }));
        } else {
          ws.send(JSON.stringify({
            type: "mcp_tool_result",
            callId: msg.callId,
            result: data.result,
          }));
        }
      }
    })
    .catch(function (err) {
      var ws = getWs();
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: "mcp_tool_error",
          callId: msg.callId,
          error: "HTTP MCP fetch failed: " + err.message,
        }));
      }
    });
  } else {
    // stdio transport: forward to extension
    forwardMcpToolCall(msg);
  }
}

// The image, paste and confirm modals live in app-modals.js; callers keep
// importing them from here.
export { showImageModal, showPasteModal, showConfirm } from './app-modals.js';

// The PIN screen that cannot be dismissed: a modal that is not dismissible, on a
// solid scrim, so neither Escape nor a click outside gets past it. Its look is in
// css/overlays.css (the same .pin-digit boxes the login page draws).
export function showForceChangePinOverlay() {
  var content = '<div class="fcp-card">' +
    '<h2 class="fcp-title">Set your new PIN</h2>' +
    '<p class="fcp-desc">Your temporary PIN has expired. Please set a new 6-digit PIN to continue.</p>' +
    '<div class="pin-wrap" id="fcp-boxes">' +
    '<input class="pin-digit" type="tel" maxlength="1" inputmode="numeric" autocomplete="off">' +
    '<input class="pin-digit" type="tel" maxlength="1" inputmode="numeric" autocomplete="off">' +
    '<input class="pin-digit" type="tel" maxlength="1" inputmode="numeric" autocomplete="off">' +
    '<input class="pin-digit" type="tel" maxlength="1" inputmode="numeric" autocomplete="off">' +
    '<input class="pin-digit" type="tel" maxlength="1" inputmode="numeric" autocomplete="off">' +
    '<input class="pin-digit" type="tel" maxlength="1" inputmode="numeric" autocomplete="off">' +
    '</div>' +
    '<button id="fcp-save" class="fcp-save" disabled>Save PIN</button>' +
    '<div id="fcp-err" class="fcp-err"></div>' +
    '<button id="fcp-logout" class="fcp-logout" type="button">Log out and start over</button>' +
    '</div>';
  var handle = showOverlay({ kind: "modal", id: "force-change-pin-overlay", content: content, dismissible: false, card: false, scrim: "solid" });
  var ov = handle.el;

  var boxes = ov.querySelectorAll(".pin-digit");
  var saveBtn = ov.querySelector("#fcp-save");
  var errEl = ov.querySelector("#fcp-err");
  // Mirror the login screen's pattern (lib/pages.js pinBoxScript): keep an
  // explicit digits[] array as the source of truth, render bullets visually,
  // enable the button when length === 6.
  var digits = ["", "", "", "", "", ""];

  function setDigit(idx, v) {
    digits[idx] = v;
    boxes[idx].value = v ? "\u2022" : "";
    boxes[idx].classList.toggle("filled", v.length > 0);
  }

  function getPin() {
    return digits.join("");
  }

  function updateBtn() {
    var ready = getPin().length === 6;
    saveBtn.disabled = !ready;
  }

  for (var i = 0; i < boxes.length; i++) {
    (function (idx) {
      boxes[idx].addEventListener("input", function () {
        var raw = this.value.replace(/[^0-9]/g, "");
        if (!raw) { setDigit(idx, ""); updateBtn(); return; }
        var v = raw.charAt(raw.length - 1);
        setDigit(idx, v);
        if (v && idx < 5) boxes[idx + 1].focus();
        updateBtn();
      });
      boxes[idx].addEventListener("keydown", function (e) {
        if (e.key === "Backspace") {
          if (!digits[idx] && idx > 0) {
            setDigit(idx - 1, "");
            boxes[idx - 1].focus();
          } else {
            setDigit(idx, "");
          }
          updateBtn();
          return;
        }
        if (e.key === "ArrowLeft" && idx > 0) boxes[idx - 1].focus();
        if (e.key === "ArrowRight" && idx < 5) boxes[idx + 1].focus();
        if (e.key === "Enter" && !saveBtn.disabled) doSave();
        e.stopPropagation();
      });
      boxes[idx].addEventListener("keyup", function (e) { e.stopPropagation(); });
      boxes[idx].addEventListener("keypress", function (e) { e.stopPropagation(); });
      boxes[idx].addEventListener("paste", function (e) {
        e.preventDefault();
        var text = (e.clipboardData || window.clipboardData).getData("text").replace(/[^0-9]/g, "").slice(0, 6);
        for (var j = 0; j < text.length && (idx + j) < 6; j++) {
          setDigit(idx + j, text.charAt(j));
        }
        if (text.length > 0) {
          var focusIdx = Math.min(idx + text.length, 5);
          boxes[focusIdx].focus();
        }
        updateBtn();
      });
      boxes[idx].addEventListener("focus", function () { this.select(); });
    })(i);
  }
  boxes[0].focus();

  function doSave() {
    var pin = getPin();
    if (pin.length !== 6) return;
    saveBtn.disabled = true;
    errEl.textContent = "";
    fetch("/api/user/pin", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPin: pin }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) {
        handle.close();
        return;
      }
      errEl.textContent = d.error || "Failed to save PIN";
      saveBtn.disabled = false;
    }).catch(function () {
      errEl.textContent = "Connection error";
      saveBtn.disabled = false;
    });
  }
  saveBtn.addEventListener("click", doSave);

  var logoutBtn = ov.querySelector("#fcp-logout");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", function () {
      fetch("/auth/logout", { method: "POST" }).then(function () {
        location.href = "/";
      }).catch(function () {
        location.href = "/";
      });
    });
  }
}

export function sendExtensionCommand(command, args, requestId) {
  window.postMessage({
    source: "clay-page",
    payload: {
      type: "clay_ext_command",
      command: command,
      args: args,
      requestId: requestId
    }
  }, "*");
}

export function handleExtensionResult(requestId, result) {
  // Check local callback first (for server-initiated requests)
  var cb = _extRequestCallbacks[requestId];
  if (cb) {
    delete _extRequestCallbacks[requestId];
    cb(result);
    return;
  }
  // Forward to server
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: "extension_result",
      requestId: requestId,
      result: result
    }));
  }
}

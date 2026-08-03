// YOKE Claude Adapter
// --------------------
// Implements the YOKE interface using @anthropic-ai/claude-agent-sdk.
// This is the ONLY file (besides claude-worker.js) that imports the SDK.
// Also manages worker processes for OS-level user isolation.

var path = require("path");
var fs = require("fs");
var os = require("os");
var net = require("net");
var crypto = require("crypto");
var { spawn } = require("child_process");
var { resolveOsUserInfo } = require("../../os-users");
var modelFamilies = require("../../model-families");
var modelCatalog = require("../../model-catalog");

// --- SDK loading ---
// Async loader (ESM dynamic import, same pattern as current project.js getSDK)
var _sdkPromise = null;
function loadSDK() {
  if (!_sdkPromise) _sdkPromise = import("@anthropic-ai/claude-agent-sdk");
  return _sdkPromise;
}

// Sync loader (CJS require, for createToolServer which must be synchronous)
var _sdkSync = null;
function loadSDKSync() {
  if (!_sdkSync) {
    try { _sdkSync = require("@anthropic-ai/claude-agent-sdk"); } catch (e) {
      console.error("[yoke/claude] Failed to load SDK synchronously:", e.message);
      return null;
    }
  }
  return _sdkSync;
}

// --- Internal message queue (async iterable for SDK prompt) ---
function createMessageQueue() {
  var queue = [];
  var waiting = null;
  var ended = false;
  return {
    push: function(msg) {
      if (ended) return;
      if (waiting) {
        var resolve = waiting;
        waiting = null;
        resolve({ value: msg, done: false });
      } else {
        queue.push(msg);
      }
    },
    end: function() {
      ended = true;
      if (waiting) {
        var resolve = waiting;
        waiting = null;
        resolve({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]: function() {
      return {
        next: function() {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise(function(resolve) { waiting = resolve; });
        },
      };
    },
  };
}

// --- Event flattening ---
// Converts raw Claude SDK events into flat objects with a yokeType field.
// This decouples processSDKMessage from the deeply-nested SDK event shapes.
function flattenEvent(raw) {
  // session_id and uuid are cross-cutting: attach to any event that has them
  var base = {};
  if (raw.session_id) base.sessionId = raw.session_id;
  if (raw.uuid) {
    base.uuid = raw.uuid;
    base.messageType = raw.type;  // "user" or "assistant"
    base.parentToolUseId = raw.parent_tool_use_id || null;
  }

  // --- stream_event with nested event ---
  if (raw.type === "stream_event" && raw.event) {
    var evt = raw.event;

    if (evt.type === "message_start") {
      base.yokeType = "turn_start";
      if (evt.message && evt.message.usage) {
        var u = evt.message.usage;
        base.inputTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0);
      }
      return base;
    }

    if (evt.type === "content_block_start" && evt.content_block) {
      var block = evt.content_block;
      base.blockIndex = evt.index;
      base.blockId = "blk_" + evt.index;
      if (block.type === "tool_use") {
        base.yokeType = "tool_start";
        base.toolId = block.id;
        base.toolName = block.name;
      } else if (block.type === "thinking") {
        base.yokeType = "thinking_start";
      } else if (block.type === "text") {
        base.yokeType = "text_start";
      } else {
        base.yokeType = "block_start";
        base.blockType = block.type;
      }
      return base;
    }

    if (evt.type === "content_block_delta" && evt.delta) {
      base.blockIndex = evt.index;
      base.blockId = "blk_" + evt.index;
      if (evt.delta.type === "text_delta") {
        base.yokeType = "text_delta";
        base.text = evt.delta.text;
      } else if (evt.delta.type === "input_json_delta") {
        base.yokeType = "tool_input_delta";
        base.partialJson = evt.delta.partial_json;
      } else if (evt.delta.type === "thinking_delta") {
        base.yokeType = "thinking_delta";
        base.text = evt.delta.thinking;
      } else {
        base.yokeType = "block_delta";
        base.delta = evt.delta;
      }
      return base;
    }

    if (evt.type === "content_block_stop") {
      base.yokeType = "block_stop";
      base.blockIndex = evt.index;
      base.blockId = "blk_" + evt.index;
      return base;
    }

    if (evt.type === "message_stop") {
      base.yokeType = "turn_stop";
      return base;
    }

    // Unrecognized stream_event: pass through
    base.yokeType = "stream_event";
    base.event = evt;
    return base;
  }

  // --- system events ---
  if (raw.type === "system") {
    if (raw.subtype === "init") {
      base.yokeType = "init";
      base.model = raw.model;
      base.skills = raw.skills;
      base.slashCommands = raw.slash_commands;
      base.fastModeState = raw.fast_mode_state || null;
      return base;
    }
    if (raw.subtype === "status") {
      base.yokeType = "status";
      base.status = raw.status;
      return base;
    }
    if (raw.subtype === "task_started") {
      base.yokeType = "task_started";
      base.parentToolId = raw.tool_use_id;
      base.taskId = raw.task_id;
      base.description = raw.description || "";
      return base;
    }
    if (raw.subtype === "task_progress") {
      base.yokeType = "task_progress";
      base.parentToolId = raw.tool_use_id;
      base.taskId = raw.task_id;
      base.usage = raw.usage || null;
      base.lastToolName = raw.last_tool_name || null;
      base.description = raw.description || "";
      base.summary = raw.summary || null;
      return base;
    }
    // Catch-all system event
    base.yokeType = "system";
    base.subtype = raw.subtype;
    base.error = raw.error;
    base.message = raw.message;
    base.text = raw.text;
    base.content = raw.content;
    return base;
  }

  // --- result ---
  if (raw.type === "result") {
    base.yokeType = "result";
    base.cost = raw.total_cost_usd;
    base.duration = raw.duration_ms;
    base.usage = raw.usage || null;
    base.modelUsage = raw.modelUsage || null;
    base.subtype = raw.subtype;
    base.errors = raw.errors;
    base.terminalReason = raw.terminal_reason;
    base.fastModeState = raw.fast_mode_state || null;
    return base;
  }

  // --- assistant/user messages (tool results, subagent messages, fallback text) ---
  if (raw.type === "assistant" || raw.type === "user") {
    if (raw.parent_tool_use_id) {
      base.yokeType = "subagent_message";
      base.parentToolUseId = raw.parent_tool_use_id;
      base.messageRole = raw.type;
      base.content = raw.message ? raw.message.content : null;
      return base;
    }
    base.yokeType = "message";
    base.messageRole = raw.type;
    base.content = raw.message ? raw.message.content : null;
    return base;
  }

  // --- rate_limit_event ---
  if (raw.type === "rate_limit_event" && raw.rate_limit_info) {
    base.yokeType = "rate_limit";
    base.rateLimitInfo = raw.rate_limit_info;
    return base;
  }

  // --- prompt_suggestion ---
  if (raw.type === "prompt_suggestion") {
    base.yokeType = "prompt_suggestion";
    base.suggestion = raw.suggestion || "";
    return base;
  }

  // --- task_notification ---
  if (raw.type === "task_notification") {
    base.yokeType = "task_notification";
    base.parentToolId = raw.parent_tool_use_id;
    base.taskId = raw.task_id;
    base.status = raw.status || "completed";
    base.summary = raw.summary || "";
    base.usage = raw.usage || null;
    return base;
  }

  // --- tool_progress ---
  if (raw.type === "tool_progress") {
    base.yokeType = "tool_progress";
    base.parentToolId = raw.parent_tool_use_id;
    base.text = raw.content || "";
    return base;
  }

  // --- _worker_meta passthrough (not a raw SDK event) ---
  if (raw.type === "_worker_meta") {
    return raw;
  }

  // --- diagnostic events (stage 2/5, lr-28ee / stage 3/5, lr-0868) ---
  // Emitted by claude-worker.js via sdk_event when parseDiagnosticLine matches
  // a CLI stderr line. Shape: { type:'diagnostic', severity, source, message }.
  // Must NOT fall through to the unknown catch-all — the processor routes on
  // yokeType:'diagnostic' to produce a distinct frontend message (not 'error').
  if (raw.type === "diagnostic") {
    base.yokeType = "diagnostic";
    base.severity = raw.severity;
    base.source = raw.source;
    base.message = raw.message;
    return base;
  }

  // --- fallback: unknown event type ---
  base.yokeType = "unknown";
  base.rawType = raw.type;
  base.raw = raw;
  return base;
}

// --- QueryHandle ---
// Wraps a raw SDK query object with the YOKE QueryHandle interface.
// Events are flattened via flattenEvent before yielding.
function createQueryHandle(rawQuery, messageQueue, abortController) {
  var handle = {
    // Opaque adapter state (null for in-process queries)
    _adapterState: null,

    // Async iterable: yields flattened SDK events
    [Symbol.asyncIterator]: function() {
      var rawIter = rawQuery[Symbol.asyncIterator]();
      return {
        next: function() {
          return rawIter.next().then(function(result) {
            if (result.done) return result;
            return { value: flattenEvent(result.value), done: false };
          });
        },
      };
    },

    pushMessage: function(text, images) {
      var content = [];
      if (images && images.length > 0) {
        for (var i = 0; i < images.length; i++) {
          content.push({
            type: "image",
            source: { type: "base64", media_type: images[i].mediaType, data: images[i].data },
          });
        }
      }
      if (text) content.push({ type: "text", text: text });
      messageQueue.push({ type: "user", message: { role: "user", content: content } });
    },

    setModel: function(model) {
      if (rawQuery && typeof rawQuery.setModel === "function") {
        return rawQuery.setModel(model);
      }
      return Promise.resolve();
    },

    setEffort: function(effort) {
      // Claude SDK has no setEffort on active query.
      // Stored at the console level for next query.
      return Promise.resolve();
    },

    setToolPolicy: function(policy) {
      // Map YOKE policy to Claude permission mode
      if (rawQuery && typeof rawQuery.setPermissionMode === "function") {
        var mode = policy === "allow-all" ? "bypassPermissions" : "default";
        return rawQuery.setPermissionMode(mode);
      }
      return Promise.resolve();
    },

    // Phase 3 backward compat: direct setPermissionMode with Claude-specific modes
    setPermissionMode: function(mode) {
      if (rawQuery && typeof rawQuery.setPermissionMode === "function") {
        return rawQuery.setPermissionMode(mode);
      }
      return Promise.resolve();
    },

    stopTask: function(taskId) {
      if (rawQuery && typeof rawQuery.stopTask === "function") {
        return rawQuery.stopTask(taskId);
      }
      return Promise.resolve();
    },

    getContextUsage: function() {
      if (rawQuery && typeof rawQuery.getContextUsage === "function") {
        return rawQuery.getContextUsage();
      }
      return Promise.resolve(null);
    },

    // lr-d91ecf: a per-query supportedModels() used to live here, but it was
    // not part of the documented QueryHandle contract (see
    // yoke/interface.js's QUERY_HANDLE_METHODS) and had no caller anywhere
    // in the codebase — the worker variant was a pure Promise.resolve([])
    // stub that never round-tripped through IPC. Model lists are fetched via
    // the adapter-level supportedModels() (populated at init/warmup and
    // cached), which every real caller (sdk-bridge.js, project.js) already
    // uses. Removed rather than "fixed" to avoid adding a documented surface
    // for a capability nothing needs per-query.

    abort: function() {
      if (abortController) {
        try { abortController.abort(); } catch (e) {}
      }
    },

    close: function() {
      try { messageQueue.end(); } catch (e) {}
      if (rawQuery && typeof rawQuery.close === "function") {
        try { rawQuery.close(); } catch (e) {}
      }
    },

    // End the message queue without closing the raw query
    endInput: function() {
      try { messageQueue.end(); } catch (e) {}
    },

    // Claude SDK specific: rewind files to a previous state
    rewindFiles: function(uuid, opts) {
      if (rawQuery && typeof rawQuery.rewindFiles === "function") {
        return rawQuery.rewindFiles(uuid, opts);
      }
      return Promise.reject(new Error("rewindFiles not supported"));
    },
  };

  return handle;
}

// ===================================================================
// Worker process management (OS-level multi-user)
// ===================================================================

// Ensure the package directory tree is world-readable so OS-level users
// can access the worker script and its dependencies (the install path
// may be under /root/.npm/_npx/ which defaults to 700)
(function ensurePackageReadable() {
  try {
    // Walk up from __dirname to find the package root (where node_modules lives)
    var pkgDir = path.join(__dirname, "..", "..", "..");
    // Open read+execute on each ancestor directory up to and including the
    // npx cache entry so that non-root users can traverse the path
    var dir = pkgDir;
    var dirs = [];
    while (dir !== path.dirname(dir)) {
      dirs.push(dir);
      dir = path.dirname(dir);
    }
    // Open o+rx on each ancestor so non-root users can traverse the path
    // (e.g. /root/.npm/_npx/.../node_modules/clay-server needs /root to be o+x)
    for (var di = 0; di < dirs.length; di++) {
      try {
        var st = fs.statSync(dirs[di]);
        // Add o+x (traverse) to all ancestors, o+rx to npm cache dirs
        var isNpmDir = dirs[di].indexOf(".npm") !== -1 || dirs[di].indexOf("node_modules") !== -1;
        var needed = isNpmDir ? 0o005 : 0o001; // rx for npm dirs, just x for ancestors like /root
        if ((st.mode & needed) !== needed) {
          fs.chmodSync(dirs[di], st.mode | needed);
        }
      } catch (e) {}
    }
    // Recursively make the package AND hoisted dependencies readable.
    // npm/npx may hoist deps (e.g. @anthropic-ai/claude-agent-sdk) to the
    // parent node_modules/ instead of inside clay-server/node_modules/.
    var { execSync: chmodExec } = require("child_process");
    // Find the top-level node_modules that contains clay-server
    var topNodeModules = path.join(pkgDir, "..");
    if (path.basename(topNodeModules) === "node_modules") {
      chmodExec("chmod -R o+rX " + JSON.stringify(topNodeModules), { stdio: "ignore", timeout: 15000 });
    } else {
      chmodExec("chmod -R o+rX " + JSON.stringify(pkgDir), { stdio: "ignore", timeout: 5000 });
    }
  } catch (e) {}
})();

// resolveLinuxUser delegates to shared os-users utility
function resolveLinuxUser(username) {
  return resolveOsUserInfo(username);
}

/**
 * Spawn an SDK worker process running as the given Linux user.
 * Returns a worker handle with send/kill/event methods.
 */
function spawnWorker(linuxUser, workerScriptPath, cwd) {
  var userInfo = resolveLinuxUser(linuxUser);
  var socketId = crypto.randomUUID();
  var socketPath = path.join(os.tmpdir(), "clagentic-worker-" + socketId + ".sock");

  var worker = {
    process: null,
    connection: null,
    socketPath: socketPath,
    server: null,
    messageHandlers: [],
    ready: false,
    readyPromise: null,
    _readyResolve: null,
    buffer: "",
  };

  worker.readyPromise = new Promise(function(resolve, reject) {
    worker._readyResolve = resolve;
    worker._readyReject = reject;
  });

  // Resolves when the worker process actually exits.
  // Used to prevent spawning a new worker before the old one finishes
  // flushing SDK session state to disk (race condition on resume).
  worker.exitPromise = new Promise(function(resolve) {
    worker._exitResolve = resolve;
  });

  // Create Unix socket server
  var spawnT0 = Date.now();
  worker.server = net.createServer(function(connection) {
    console.log("[PERF] spawnWorker: socket connection accepted +" + (Date.now() - spawnT0) + "ms");
    worker.connection = connection;
    connection.on("data", function(chunk) {
      worker.buffer += chunk.toString();
      var lines = worker.buffer.split("\n");
      worker.buffer = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
          var msg = JSON.parse(lines[i]);
          if (msg.type === "ready") {
            console.log("[PERF] spawnWorker: 'ready' IPC received +" + (Date.now() - spawnT0) + "ms");
            worker.ready = true;
            if (worker._readyResolve) {
              worker._readyResolve();
              worker._readyResolve = null;
            }
          }
          for (var h = 0; h < worker.messageHandlers.length; h++) {
            worker.messageHandlers[h](msg);
          }
        } catch (e) {
          console.error("[yoke/claude] Failed to parse worker message:", e.message);
        }
      }
    });
    connection.on("error", function(err) {
      console.error("[yoke/claude] Worker connection error:", err.message);
    });
  });

  worker.server.listen(socketPath, function() {
    console.log("[PERF] spawnWorker: socket listen ready +" + (Date.now() - spawnT0) + "ms");
    // Set socket permissions so the target user can connect
    try { fs.chmodSync(socketPath, 0o777); } catch (e) {}

    // Spawn worker process as the target Linux user.
    // Build a minimal, isolated env (no daemon env leakage).
    var workerEnv = require("../../build-user-env").buildUserEnv({
      uid: userInfo.uid,
      gid: userInfo.gid,
      home: userInfo.home,
      user: linuxUser,
      shell: userInfo.shell || "/bin/bash",
    });

    console.log("[yoke/claude] Spawning worker: uid=" + userInfo.uid + " gid=" + userInfo.gid + " cwd=" + cwd + " socket=" + socketPath);
    console.log("[yoke/claude] Worker script: " + workerScriptPath);
    console.log("[yoke/claude] Node: " + process.execPath);
    worker.process = spawn(process.execPath, [workerScriptPath, socketPath], {
      uid: userInfo.uid,
      gid: userInfo.gid,
      env: workerEnv,
      cwd: cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // detached: true gives the worker its own process group (pgid = worker.pid).
      // This lets us send SIGTERM/SIGKILL to the whole group (kill(-pgid)) when
      // the daemon shuts down, reaping grandchild claude CLI processes too.
      // We do NOT call .unref() so the daemon still tracks the worker.
      detached: true,
    });

    worker.process.stdout.on("data", function(data) {
      console.log("[sdk-worker:" + linuxUser + "] " + data.toString().trim());
    });
    worker._stderrBuf = "";
    worker.process.stderr.on("data", function(data) {
      var text = data.toString().trim();
      worker._stderrBuf += text + "\n";
      console.error("[sdk-worker:" + linuxUser + "] " + text);
    });

    worker.process.on("exit", function(code, signal) {
      console.log("[yoke/claude] Worker for " + linuxUser + " exited (code=" + code + ", signal=" + signal + ")" + (worker._stderrBuf ? " stderr: " + worker._stderrBuf.trim() : ""));
      // Reject readyPromise if worker dies before becoming ready so callers
      // awaiting it surface an error instead of hanging forever.
      _test_handleWorkerEarlyExit(worker, code, signal);
      // Notify message handlers about unexpected exit so sessions don't hang.
      // Always dispatch a fallback query_error. The handler is idempotent:
      // it checks isProcessing before taking action, and cleanupSessionWorker
      // guards against stale workers. This covers all exit cases including
      // signal kills (code=null) and normal exits where the IPC query_error
      // was lost due to connection timing.
      console.log("[yoke/claude] Exit handler: pid=" + (worker.process ? worker.process.pid : "?") + " ready=" + worker.ready + " _queryEnded=" + worker._queryEnded + " _abortSent=" + worker._abortSent + " handlers=" + worker.messageHandlers.length);
      if (code === 0 && !worker.ready) {
        // Worker exited cleanly before sending "ready"
        for (var h = 0; h < worker.messageHandlers.length; h++) {
          worker.messageHandlers[h]({
            type: "query_error",
            error: "Worker exited before ready (code=0). stderr: " + (worker._stderrBuf || "(none)"),
            exitCode: 0,
            stderr: worker._stderrBuf || null,
          });
        }
      } else if (code !== 0 || code === null || signal) {
        // Worker crashed, was killed by signal, or exited abnormally
        var stderrText = worker._stderrBuf || "";
        var exitReason = signal
          ? "Worker killed by " + signal
          : (stderrText || "Worker exited with code " + code);
        for (var h = 0; h < worker.messageHandlers.length; h++) {
          worker.messageHandlers[h]({
            type: "query_error",
            error: exitReason,
            exitCode: code,
            stderr: stderrText || null,
          });
        }
      } else if (worker.messageHandlers.length > 0) {
        // Normal exit (code=0, ready=true). Dispatch fallback in case the
        // IPC query_done/query_error was lost (e.g. connection closed early).
        var fallbackMsg = worker._abortSent
          ? "Worker aborted"
          : "Worker exited before query completed";
        for (var h = 0; h < worker.messageHandlers.length; h++) {
          worker.messageHandlers[h]({
            type: "query_error",
            error: fallbackMsg,
            exitCode: 0,
            stderr: worker._stderrBuf || null,
            _fallback: true,
          });
        }
      }
      cleanupWorker(worker);
      if (worker._exitResolve) {
        worker._exitResolve();
        worker._exitResolve = null;
      }
    });
  });

  worker.send = function(msg) {
    if (!worker.connection || worker.connection.destroyed) return;
    try {
      worker.connection.write(JSON.stringify(serializeWorkerValue(msg)) + "\n");
    } catch (e) {
      console.error("[yoke/claude] Failed to send to worker:", e.message);
    }
  };

  worker.onMessage = function(handler) {
    worker.messageHandlers.push(handler);
  };

  worker.kill = function() {
    console.log("[yoke/claude] worker.kill() called, pid=" + (worker.process ? worker.process.pid : "?") + " stack=" + new Error().stack.split("\n").slice(1, 4).join(" | "));
    worker.send({ type: "shutdown" });
    // Kill the entire process group (worker + any grandchild claude CLI processes).
    // Negative pid targets the process group (pgid = worker.pid when detached: true).
    if (worker.process && worker.process.pid) {
      try { process.kill(-worker.process.pid, "SIGTERM"); } catch (e) {}
    }
    // Force kill the whole group after 5 seconds if still alive (gives SDK time to save session)
    setTimeout(function() {
      if (worker.process && !worker.process.killed) {
        try { process.kill(-worker.process.pid, "SIGKILL"); } catch (e) {}
      }
    }, 5000);
    // Don't call cleanupWorker here. Let the exit handler do it after
    // the worker has had time to save SDK session state to disk.
    // Closing the connection prematurely causes the worker to exit
    // before the SDK can flush its session file, leading to "no
    // conversation found" errors on resume (OS multi-user mode).
  };

  return worker;
}

// Testable seam: the exact logic the exit handler uses to reject readyPromise
// and build the error object when the worker dies before becoming ready.
// Exported as _test_handleWorkerEarlyExit so tests can call the real function
// rather than inlining a copy — reverting the _readyReject call in the exit
// handler will break those tests. (lr-a7e7)
function _test_handleWorkerEarlyExit(worker, code, signal) {
  if (!worker.ready && worker._readyReject) {
    var readyErr = new Error(
      "Worker exited before ready (code=" + code + ", signal=" + signal + ")" +
      (worker._stderrBuf ? ". stderr: " + worker._stderrBuf.trim() : "")
    );
    worker._readyReject(readyErr);
    worker._readyResolve = null;
    worker._readyReject = null;
  }
}

function cleanupWorker(worker) {
  console.log("[yoke/claude] cleanupWorker() called, pid=" + (worker.process ? worker.process.pid : "?") + " stack=" + new Error().stack.split("\n").slice(1, 4).join(" | "));
  if (worker._abortTimeout) { clearTimeout(worker._abortTimeout); worker._abortTimeout = null; }
  if (worker.connection && !worker.connection.destroyed) {
    try { worker.connection.end(); } catch (e) {}
  }
  if (worker.server) {
    try { worker.server.close(); } catch (e) {}
  }
  // Remove socket file
  try { fs.unlinkSync(worker.socketPath); } catch (e) {}
  worker.ready = false;
}

function serializeWorkerValue(value, seen) {
  if (value == null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "undefined") return undefined;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");

  if (!seen) seen = new WeakSet();
  if (typeof value === "object") {
    if (seen.has(value)) return undefined;
    seen.add(value);
  }

  if (Array.isArray(value)) {
    var arr = [];
    for (var i = 0; i < value.length; i++) {
      var item = serializeWorkerValue(value[i], seen);
      if (item !== undefined) arr.push(item);
    }
    return arr;
  }

  var out = {};
  var keys = Object.keys(value);
  for (var j = 0; j < keys.length; j++) {
    var key = keys[j];
    var child = serializeWorkerValue(value[key], seen);
    if (child !== undefined) out[key] = child;
  }
  return out;
}

// --- Worker QueryHandle ---
// Wraps worker IPC into the same async iterable + control interface as the
// in-process QueryHandle. This allows processQueryStream to iterate a worker
// query identically to an in-process query.

function createWorkerQueryHandle(worker, canUseTool, onElicitation, callMcpTool) {
  // Async iterable state
  var iterQueue = [];
  var iterWaiting = null;
  var iterEnded = false;
  var iterError = null;

  // Pending request/response correlation for handle methods that need a
  // result from the worker (e.g. rewindFiles). Each entry is keyed by a
  // requestId and holds { resolve, reject } of the in-flight Promise.
  var pendingRewinds = {};

  // lr-f22787: same correlation pattern as pendingRewinds, for setModel.
  // Without this, an invalid/unentitled model ID sent to a worker session
  // failed silently — the worker-side handleSetModel() (claude-worker.js)
  // already caught the SDK rejection and reported it via a "worker_error"
  // message, but the daemon-side setModel() below returned
  // Promise.resolve() immediately without ever waiting for that reply, so
  // the failure had no path back to the caller (sdk-bridge.js's setModel,
  // then project-sessions.js) to surface to the user.
  var pendingSetModel = {};

  function pushToIter(value) {
    if (iterEnded) return;
    if (iterWaiting) {
      var resolve = iterWaiting;
      iterWaiting = null;
      resolve({ value: value, done: false });
    } else {
      iterQueue.push(value);
    }
  }

  function endIter() {
    if (iterEnded) return;
    iterEnded = true;
    if (iterWaiting) {
      var resolve = iterWaiting;
      iterWaiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  function errorIter(err) {
    if (iterEnded) return;
    iterEnded = true;
    iterError = err;
    if (iterWaiting) {
      var reject = iterWaiting;
      iterWaiting = null;
      // We stored the reject function below; for simplicity, use a combined approach
      reject({ error: err });
    }
  }

  // Set up message handler on the worker
  worker.onMessage(function(msg) {
    switch (msg.type) {
      case "sdk_event":
        pushToIter(flattenEvent(msg.event));
        break;

      case "permission_request":
        if (canUseTool) {
          canUseTool(msg.toolName, msg.input, {
            toolUseID: msg.toolUseId,
            decisionReason: msg.decisionReason,
            signal: { addEventListener: function() {} },
          }).then(function(result) {
            worker.send({ type: "permission_response", requestId: msg.requestId, result: result });
          }).catch(function(e) {
            console.error("[yoke/claude] permission_response send failed:", e.message || e);
          });
        }
        break;

      case "ask_user_request":
        if (canUseTool) {
          canUseTool("AskUserQuestion", msg.input, {
            toolUseID: msg.toolUseId,
            signal: { addEventListener: function() {} },
          }).then(function(result) {
            worker.send({ type: "ask_user_response", toolUseId: msg.toolUseId, result: result });
          }).catch(function(e) {
            console.error("[yoke/claude] ask_user_response send failed:", e.message || e);
          });
        }
        break;

      case "elicitation_request":
        if (onElicitation) {
          onElicitation({
            serverName: msg.serverName,
            message: msg.message,
            mode: msg.mode,
            url: msg.url,
            elicitationId: msg.elicitationId,
            requestedSchema: msg.requestedSchema,
          }, {
            signal: { addEventListener: function() {} },
          }).then(function(result) {
            worker.send({ type: "elicitation_response", requestId: msg.requestId, result: result });
          }).catch(function(e) {
            console.error("[yoke/claude] elicitation_response send failed:", e.message || e);
          });
        }
        break;

      case "mcp_tool_call":
        if (callMcpTool) {
          callMcpTool(msg.serverName, msg.toolName, msg.args || {}).then(function(result) {
            worker.send({ type: "mcp_tool_result", requestId: msg.requestId, result: result });
          }).catch(function(e) {
            worker.send({
              type: "mcp_tool_result",
              requestId: msg.requestId,
              error: (e && e.message) ? e.message : String(e),
            });
          });
        }
        break;

      case "context_usage":
      case "effort_changed":
      case "permission_mode_changed":
        // Yield these as _worker_meta events so processQueryStream can handle them
        pushToIter({ type: "_worker_meta", subtype: msg.type, data: msg });
        break;

      case "model_changed":
        // lr-f22787: still yielded as a _worker_meta event (unchanged
        // consumer contract for sdk-bridge.js), AND resolves the pending
        // setModel() promise correlated by requestId, if present. Older
        // worker builds that don't echo requestId simply leave the pending
        // map untouched — pushToIter below is unaffected either way.
        pushToIter({ type: "_worker_meta", subtype: msg.type, data: msg });
        if (msg.requestId && pendingSetModel[msg.requestId]) {
          var smOk = pendingSetModel[msg.requestId];
          delete pendingSetModel[msg.requestId];
          smOk.resolve();
        }
        break;

      case "worker_error":
        // Yielded as a _worker_meta event (unchanged consumer contract), AND
        // rejects the pending setModel() promise when this worker_error
        // belongs to an in-flight set_model request (lr-f22787). worker_error
        // is also used for effort/permission-mode failures, which carry no
        // requestId and so never match a pendingSetModel entry.
        pushToIter({ type: "_worker_meta", subtype: msg.type, data: msg });
        if (msg.requestId && pendingSetModel[msg.requestId]) {
          var smErr = pendingSetModel[msg.requestId];
          delete pendingSetModel[msg.requestId];
          smErr.reject(new Error(msg.error || "Failed to set model"));
        }
        break;

      case "rewind_files_response": {
        var rp = pendingRewinds[msg.requestId];
        if (rp) {
          delete pendingRewinds[msg.requestId];
          if (msg.error) rp.reject(new Error(msg.error));
          else rp.resolve(msg.result);
        }
        break;
      }

      case "query_done":
        console.log("[yoke/claude] IPC query_done received, pid=" + (worker.process ? worker.process.pid : "?"));
        worker._queryEnded = true;
        endIter();
        break;

      case "query_error": {
        console.log("[yoke/claude] IPC query_error received, pid=" + (worker.process ? worker.process.pid : "?") + " _fallback=" + !!msg._fallback + " _queryEnded=" + worker._queryEnded + " error=" + (msg.error || "").substring(0, 100));
        // Skip fallback errors from exit handler if we already handled the real one
        if (msg._fallback && worker._queryEnded) break;
        worker._queryEnded = true;
        var err = new Error(msg.error || "Worker query error");
        err.exitCode = msg.exitCode;
        err.stderr = msg.stderr;
        // Also store the worker stderr buffer for when msg.stderr is empty
        if (!msg.stderr && worker._stderrBuf) {
          err.stderr = worker._stderrBuf.trim();
        }
        errorIter(err);
        break;
      }
    }
  });

  var handle = {
    // Opaque adapter state: contains worker reference and exit promise
    _adapterState: {
      worker: worker,
      exitPromise: worker.exitPromise,
    },

    [Symbol.asyncIterator]: function() {
      return {
        next: function() {
          // Check for error first
          if (iterError) {
            return Promise.reject(iterError);
          }
          if (iterQueue.length > 0) {
            var item = iterQueue.shift();
            if (item && item.error && iterEnded) {
              // This was an error signal
              return Promise.reject(item.error);
            }
            return Promise.resolve({ value: item, done: false });
          }
          if (iterEnded) {
            if (iterError) return Promise.reject(iterError);
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise(function(resolve, reject) {
            iterWaiting = function(result) {
              if (result && result.error) {
                reject(result.error);
              } else {
                resolve(result);
              }
            };
          });
        },
      };
    },

    pushMessage: function(text, images) {
      var content = [];
      if (images && images.length > 0) {
        for (var i = 0; i < images.length; i++) {
          content.push({
            type: "image",
            source: { type: "base64", media_type: images[i].mediaType, data: images[i].data },
          });
        }
      }
      if (text) content.push({ type: "text", text: text });
      var userMsg = { type: "user", message: { role: "user", content: content } };
      worker.send({ type: "push_message", content: userMsg });
    },

    // lr-f22787: correlated by requestId (mirrors rewindFiles below) so the
    // returned promise reflects the worker's real outcome — a rejected
    // model ID rejects this promise instead of resolving immediately
    // regardless of whether the SDK accepted it.
    setModel: function(model) {
      var requestId = crypto.randomUUID();
      return new Promise(function(resolve, reject) {
        pendingSetModel[requestId] = { resolve: resolve, reject: reject };
        try {
          worker.send({ type: "set_model", requestId: requestId, model: model });
        } catch (e) {
          delete pendingSetModel[requestId];
          reject(e);
        }
      });
    },

    setEffort: function(effort) {
      worker.send({ type: "set_effort", effort: effort });
      return Promise.resolve();
    },

    setToolPolicy: function(policy) {
      var mode = policy === "allow-all" ? "bypassPermissions" : "default";
      worker.send({ type: "set_permission_mode", mode: mode });
      return Promise.resolve();
    },

    setPermissionMode: function(mode) {
      worker.send({ type: "set_permission_mode", mode: mode });
      return Promise.resolve();
    },

    stopTask: function(taskId) {
      worker.send({ type: "stop_task", taskId: taskId });
      return Promise.resolve();
    },

    getContextUsage: function() {
      return Promise.resolve(null);
    },

    // lr-d91ecf: per-query supportedModels() removed — see the matching
    // comment in createQueryHandle above. This stub never round-tripped
    // through worker IPC and had no caller.

    abort: function() {
      console.log("[yoke/claude] ABORT sent to worker pid=" + (worker.process ? worker.process.pid : "?"));
      worker._abortSent = true;
      try { worker.send({ type: "abort" }); } catch (e) {}
      // If the worker doesn't finish within 5s (e.g. subagent stuck), force-kill it.
      // The worker exit handler will dispatch a fallback query_error and send done.
      if (worker._abortTimeout) clearTimeout(worker._abortTimeout);
      worker._abortTimeout = setTimeout(function() {
        if (worker.process && !worker.process.killed) {
          console.log("[yoke/claude] Abort timeout: force-killing worker pid=" + (worker.process ? worker.process.pid : "?"));
          try { process.kill(-worker.process.pid, "SIGKILL"); } catch (e) {}
        }
      }, 5000);
    },

    close: function() {
      // End the iterator
      endIter();
      // Send end_messages to worker
      worker.send({ type: "end_messages" });
    },

    endInput: function() {
      worker.send({ type: "end_messages" });
    },

    // Claude SDK specific: rewind files to a previous state. The in-process
    // handle calls rawQuery.rewindFiles directly; the worker variant has to
    // hop through IPC and correlate the response by requestId.
    rewindFiles: function(uuid, opts) {
      var requestId = crypto.randomUUID();
      return new Promise(function(resolve, reject) {
        pendingRewinds[requestId] = { resolve: resolve, reject: reject };
        try {
          worker.send({ type: "rewind_files", requestId: requestId, uuid: uuid, opts: opts || {} });
        } catch (e) {
          delete pendingRewinds[requestId];
          reject(e);
        }
      });
    },
  };

  return handle;
}


// --- Model enrichment (lr-af9d66) ---
//
// stream.supportedModels() (SDK >=0.3.x) returns rich ModelInfo objects, not
// bare ID strings — verified directly against the live CLI (claude-agent-sdk
// 0.3.173 / claudeCodeVersion 2.1.173): every entry carries at minimum
// {value, displayName, description}, and MAY carry supportsEffort,
// supportedEffortLevels, supportsAdaptiveThinking, supportsFastMode,
// supportsAutoMode. A model the vendor says nothing about for a given field
// (e.g. haiku today reports no effort/thinking keys at all) omits that key
// entirely rather than sending false — so "vendor said no" and "vendor said
// nothing" are different wire shapes, and must stay distinguishable through
// enrichment rather than being silently collapsed into the same boolean.
//
// enrichClaudeModel is the ONE place that resolves "vendor said nothing" to
// a concrete UI value (see FAIL-OPEN rationale below) — do not duplicate
// this fallback decision elsewhere.
//
// The historical claim that this branch was unreachable (bare ID strings
// only) does not hold against the currently pinned SDK version; see PR body
// for the reproduction. Kept as a defensive plain-string branch below in case
// a future SDK/CLI combination or a worker-relayed shape ever regresses to
// bare strings.

// Fallback-only (lr-af9d66, same discipline as KNOWN_CONTEXT_WINDOWS and
// CODEX_DEFAULT_MODELS — lr-d91ecf): consulted only when a model's
// supportedEffortLevels is absent or empty in the vendor response. A
// vendor-reported list always wins outright when present (see
// enrichClaudeModel below) — this table exists purely to cover the case
// where the vendor reports no levels at all, not as the primary source.
var CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

// Display name, thinking/effort capability heuristics, and family/version
// parsing all live in ../../model-families.js (lr-d91ecf) — the single
// shared location also consumed by the frontend (settings-defaults.js,
// app-panels.js) via its ESM twin, lib/public/modules/model-families.js.
// No hardcoded per-ID display-name table: claudeDisplayName derives the
// label from the parsed family + version, so an ID this code has never seen
// still gets a sane label with zero code changes here.
var claudeDisplayName = modelFamilies.claudeDisplayName;
var claudeModelSupportsThinking = modelFamilies.claudeModelSupportsThinking;
var claudeModelSupportsEffort = modelFamilies.claudeModelSupportsEffort;

/**
 * Resolve a capability flag from vendor-reported data, falling back to the
 * family-substring heuristic when the vendor field is absent OR malformed.
 *
 * FAIL-OPEN, BY DESIGN (lr-af9d66): when the vendor is silent, this resolves
 * to whatever the heuristic says (which itself defaults to true for any
 * unrecognized family — see model-families.js:153-161). A brand-new family
 * the parser has never seen therefore gets full capabilities on day one with
 * zero code change, the same property lr-e03635 built for latest/older
 * tiering. The alternative (fail-closed: unknown === unsupported) would
 * silently strip thinking/effort from every new tier until someone updates
 * the parser, which is worse than an occasional false positive on a model
 * that turns out not to support a flag — the operator-observed case (fable)
 * is a fail-open success story, not a bug. This function is the ONLY place
 * that makes that call; do not re-derive it elsewhere.
 *
 * STRICT BOOLEAN, BY DESIGN: a present field is only trusted as a real
 * vendor determination when it is literally `true` or `false`. A present
 * field holding a truthy-but-non-boolean value (a string, a number, an
 * object) is treated the SAME as an absent field — vendor silence, not a
 * "supported" reading via loose `!!` coercion. This is deliberate, not an
 * oversight: lr-af9d66's whole thesis is that "vendor said nothing" must
 * stay distinguishable from "vendor made a real determination" rather than
 * collapsing into one boolean. A malformed value is closer to "we received
 * garbage we don't understand" than to an affirmative "yes" — coercing it
 * to true would silently reintroduce the same indistinguishability at the
 * value layer that hasOwnProperty already fixed at the key-presence layer.
 *
 * @param {object} model - rich model object from the vendor
 * @param {string} vendorField - field name the vendor actually uses (e.g. "supportsAdaptiveThinking")
 * @param {function(string): boolean} heuristic - family-substring fallback (model-families.js)
 * @param {string} value - raw model ID, passed to the heuristic
 * @returns {boolean}
 */
function resolveClaudeCapability(model, vendorField, heuristic, value) {
  if (Object.prototype.hasOwnProperty.call(model, vendorField)) {
    var reported = model[vendorField];
    if (reported === true || reported === false) return reported;
    // Present but not a real boolean — treat as vendor silence, not "yes".
  }
  return heuristic(value);
}

/**
 * True iff `levels` is a non-empty array of strings — the shape
 * enrichClaudeModel requires before trusting it over the static fallback.
 * A malformed value (non-array, empty array, or an array containing a
 * non-string entry) is rejected wholesale rather than partially trusted;
 * see resolveClaudeCapability's doc comment for why "malformed" is treated
 * as "vendor didn't tell us," not coerced into a partial truth.
 * @param {*} levels
 * @returns {boolean}
 */
function isValidEffortLevelsList(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return false;
  for (var i = 0; i < levels.length; i++) {
    if (typeof levels[i] !== "string") return false;
  }
  return true;
}

/**
 * Enrich a raw model ID string (or passthrough if already object) into a rich
 * model descriptor object.
 * @param {string|object} model
 * @returns {{ value, displayName, supportsEffort, supportedEffortLevels, supportsThinking }}
 */
function enrichClaudeModel(model) {
  // Already a rich object — passthrough but ensure all fields present
  if (model && typeof model === "object") {
    var v = model.value || "";
    // Vendor displayName (e.g. "Fable", "Sonnet") is a bare family label with
    // no version — pass description through to claudeDisplayName so the
    // fallback derivation (used when displayName is absent) can recover a
    // real version number from it for an alias-only value (lr-5c07ce).
    var enriched = {
      value: v,
      displayName: model.displayName || claudeDisplayName(v, model.description),
      // supportsEffort: vendor field name matches ours — no translation needed.
      supportsEffort: resolveClaudeCapability(model, "supportsEffort", claudeModelSupportsEffort, v),
      // supportedEffortLevels: reported list wins outright when present,
      // non-empty, AND every entry is a string — the same "malformed reads
      // as silence, not as a real determination" rule as
      // resolveClaudeCapability above, applied to an array shape instead of
      // a boolean one. CLAUDE_EFFORT_LEVELS is the documented fallback-only
      // static table (lr-af9d66 tertiary item — see its declaration above).
      supportedEffortLevels: isValidEffortLevelsList(model.supportedEffortLevels)
        ? model.supportedEffortLevels
        : CLAUDE_EFFORT_LEVELS,
      // supportsThinking: the vendor's actual field is "supportsAdaptiveThinking"
      // (confirmed against the live CLI — see the enrichment comment above).
      // "supportsThinking" is also checked for forward/backward compat in case
      // a future or older CLI build uses that name instead.
      supportsThinking: Object.prototype.hasOwnProperty.call(model, "supportsThinking")
        ? resolveClaudeCapability(model, "supportsThinking", claudeModelSupportsThinking, v)
        : resolveClaudeCapability(model, "supportsAdaptiveThinking", claudeModelSupportsThinking, v),
    };
    // isLatest is derived across the whole model list (enrichClaudeModels),
    // not per-model — but preserve an explicitly-set value on passthrough so
    // a caller that already computed tiering isn't silently overridden.
    if (Object.prototype.hasOwnProperty.call(model, "isLatest")) enriched.isLatest = model.isLatest;
    // lr-f22787: fromCatalog marks an entry that came from the release-time
    // generated catalog rather than the vendor's live enumeration — the
    // picker uses this to show a small non-blocking "Catalog" marker (PR
    // body point (c): shown, never hidden, but visually distinguished from
    // a live-confirmed-current entry).
    if (model.fromCatalog) enriched.fromCatalog = true;
    // lr-f22787 (coordinator follow-up): carry the retired/deprecated
    // marking applied by model-catalog.js's applyRetiredMarking straight
    // through enrichment — these fields are set upstream (mergeStaticCatalog
    // in this file), not derived here, so this is a passthrough, not a
    // second source of truth.
    if (model.status) enriched.status = model.status;
    if (model.isRetired) enriched.isRetired = true;
    if (model.isDeprecated) enriched.isDeprecated = true;
    if (model.disabled) enriched.disabled = true;
    return enriched;
  }
  // Plain string — defensive fallback, see enrichment comment above for why
  // this is not expected to be the live path against current SDK versions.
  var value = String(model || "");
  return {
    value: value,
    displayName: claudeDisplayName(value),
    supportsEffort: claudeModelSupportsEffort(value),
    supportedEffortLevels: CLAUDE_EFFORT_LEVELS,
    supportsThinking: claudeModelSupportsThinking(value),
  };
}

// --- Latest/older tier derivation (lr-e03635) ---
//
// No hardcoded model IDs or names: the split is derived purely from the ID
// pattern (family substring + numeric version ordering). A model release
// that lands with a higher version number in an already-known family, or as
// a brand-new family, is automatically "latest" with zero code changes here.
//
// Parsing/derivation itself lives in ../../model-families.js (lr-d91ecf) —
// the shared location also consumed by the frontend's ESM twin
// (lib/public/modules/model-families.js). Do not add another copy elsewhere.

var deriveClaudeLatestTiers = modelFamilies.deriveClaudeLatestTiers;

// --- Static catalog merge (lr-f22787) ---
//
// The live vendor list (`models` below) only ever contains the current
// alias set (opus/sonnet/haiku/fable) — see model-catalog.js's header
// comment for the full empirical trail. Older, still-runnable versioned IDs
// (e.g. claude-opus-4-5) come from a release-time-generated catalog file
// (lib/generated/claude-model-catalog.json) merged in here, BEFORE tiering,
// so catalog-only entries flow through exactly the same enrichment/
// latest-older derivation as live entries — no separate code path, no
// separate display logic. A catalog read failure (missing/corrupt file)
// degrades to "no extra entries merged," never an exception — see
// loadClaudeModelCatalog's doc comment.
// lr-d3817f: retired entries are filtered out of the CATALOG before merge
// (never just marked/disabled — see model-catalog.js's header comment and
// filterSelectableCatalogModels) so they never reach the live list on any
// surface, collapsed or expanded.
function mergeStaticCatalog(models) {
  var catalog = modelCatalog.loadClaudeModelCatalog();
  if (!catalog.ok || !catalog.models.length) return models;
  var selectable = modelCatalog.filterSelectableCatalogModels(catalog.models);
  if (!selectable.length) return models;
  var merged = modelCatalog.mergeModelCatalog(models, selectable);
  // Deprecated (not retired) entries still get their marker — they still
  // run, so they stay in the list, just visually distinguished.
  return modelCatalog.applyRetiredMarking(merged);
}

// enrichClaudeModels stays a PURE function of its input list (lr-e03635/
// lr-af9d66/lr-5c07ce regression tests call it directly with a closed-world
// synthetic model list and assert on that exact set — merging in
// filesystem-backed catalog data unconditionally inside this function would
// silently change what those tests are asserting against, which is exactly
// the "never modify existing tests" rule this repo enforces). Static catalog
// merging + alias reconciliation live in the separate wrapper below,
// enrichClaudeModelsWithCatalog, which ONLY the real adapter.init()/
// warmup_done code paths call — the one place a live vendor list actually
// needs augmenting with release-time-generated data.
function enrichClaudeModels(models) {
  if (!models || !models.length) return models;
  var latestTiers = deriveClaudeLatestTiers(models);
  var result = [];
  for (var i = 0; i < models.length; i++) {
    var enriched = enrichClaudeModel(models[i]);
    if (!Object.prototype.hasOwnProperty.call(enriched, "isLatest")) {
      enriched.isLatest = latestTiers[enriched.value] !== false;
    }
    result.push(enriched);
  }
  return result;
}

// lr-f22787 (behavior corrected by lr-d3817f): the real adapter-facing
// entry point. Merges the release-time static catalog so the "Older
// models" disclosure can offer real, still-runnable versioned IDs the
// vendor's live enumeration never lists — see model-catalog.js's header
// comment for why supportedModels() alone is not the full universe
// (lr-f22787's original motivation, still valid).
//
// lr-d3817f CORRECTION: the collapsed/default view must show the vendor's
// own alias list EXACTLY as it rendered before lr-f22787 touched this path
// — Default/Opus/Fable/Sonnet/Haiku, never a raw versioned catalog ID, and
// never an alias whose value has been silently substituted for a concrete
// ID (the old reconcileAliasesWithCatalogIds — removed). Achieving that
// means the live alias list and the catalog-only list are TIERED AS TWO
// COMPLETELY SEPARATE GROUPS, not just enriched together and patched
// after the fact by family/version comparison:
//   - every live-sourced entry is forced isLatest:true (mirroring the
//     pre-lr-f22787 world, where the live list had nothing else to compare
//     against within its own family) — the collapsed tier is ALWAYS
//     exactly the live alias set, regardless of what versions the catalog
//     happens to contain (even a catalog entry that would otherwise be the
//     numerically highest version in its family must NOT bump a live
//     alias out of, or itself into, the collapsed tier).
//   - every catalog-sourced entry is forced isLatest:false — it always
//     belongs in the "Older models" expansion, never the collapsed view,
//     even if it happens to be the highest version the catalog knows
//     about for its family. The alias already occupies that family's
//     collapsed slot.
function enrichClaudeModelsWithCatalog(models) {
  if (!models || !models.length) return models;
  var withCatalog = mergeStaticCatalog(models);
  var enriched = enrichClaudeModels(withCatalog);
  for (var i = 0; i < enriched.length; i++) {
    enriched[i].isLatest = !enriched[i].fromCatalog;
  }
  return enriched;
}


// --- Adapter factory ---

function resolveClaudeBinaryPath() {
  // 1. Explicit env var override
  if (process.env.CLAUDE_CODE_PATH && fs.existsSync(process.env.CLAUDE_CODE_PATH)) {
    return process.env.CLAUDE_CODE_PATH;
  }

  // 2. `which claude` in the daemon's PATH
  try {
    var result = require("child_process").execSync("which claude", { encoding: "utf8", timeout: 5000 }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch (e) {}

  // 3. Common per-user and system locations (best-effort fallback for the daemon user)
  var home = process.env.HOME || "";
  var candidates = [];
  if (home) {
    candidates.push(home + "/.npm-global/bin/claude");
    candidates.push(home + "/.local/bin/claude");
    candidates.push(home + "/.volta/bin/claude");
    candidates.push(home + "/.bun/bin/claude");
    candidates.push(home + "/bin/claude");
  }
  candidates.push("/usr/local/bin/claude");
  candidates.push("/usr/bin/claude");
  candidates.push("/opt/homebrew/bin/claude");
  for (var i = 0; i < candidates.length; i++) {
    try { if (fs.existsSync(candidates[i])) return candidates[i]; } catch (e) {}
  }

  // 4. Bundled CLI entry from the SDK's peer
  try {
    var resolved = require.resolve("@anthropic-ai/claude-code/cli.js");
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch (e) {}

  return null;
}

function createClaudeAdapter(opts) {
  var _cwd = (opts && opts.cwd) || process.cwd();
  var _cachedModels = [];
  var _claudeBinaryPath = resolveClaudeBinaryPath();

  // Path to the worker script (for OS-level user isolation)
  var workerScriptPath = path.join(__dirname, "claude-worker.js");

  var adapter = {
    vendor: "claude",

    // Path to worker script (sdk-bridge uses this to spawn worker processes)
    workerScriptPath: workerScriptPath,

    /**
     * Return cached list of supported models.
     * @returns {Promise<string[]>}
     */
    supportedModels: function() {
      return Promise.resolve(_cachedModels.slice());
    },

    /**
     * Create a tool server from runtime-agnostic definitions.
     * Synchronous because MCP servers are created during project setup.
     *
     * @param {object} def
     * @param {string} def.name
     * @param {string} def.version
     * @param {Array} def.tools - [{ name, description, inputSchema, handler }]
     * @returns {object|null} Opaque MCP server config
     */
    createToolServer: function(def) {
      var sdk = loadSDKSync();
      if (!sdk || !sdk.createSdkMcpServer || !sdk.tool) {
        console.error("[yoke/claude] SDK not available for createToolServer");
        return null;
      }

      var sdkTools = [];
      for (var i = 0; i < def.tools.length; i++) {
        var t = def.tools[i];
        sdkTools.push(sdk.tool(t.name, t.description, t.inputSchema, t.handler));
      }
      return sdk.createSdkMcpServer({
        name: def.name,
        version: def.version,
        tools: sdkTools,
      });
    },

    /**
     * Create a new query. Returns a QueryHandle (async iterable + control methods).
     *
     * If adapterOptions.CLAUDE.linuxUser is set, creates a worker-based query.
     * Otherwise, creates an in-process query.
     *
     * The caller must push the first message via handle.pushMessage()
     * and then iterate the handle for events.
     *
     * @param {object} queryOpts
     * @param {string}   [queryOpts.cwd]
     * @param {string}   [queryOpts.systemPrompt]
     * @param {string}   [queryOpts.model]
     * @param {string}   [queryOpts.effort]
     * @param {object}   [queryOpts.toolServers]  - mcpServers config object
     * @param {Function} [queryOpts.canUseTool]
     * @param {Function} [queryOpts.onElicitation]
     * @param {string}   [queryOpts.resumeSessionId]
     * @param {AbortController} [queryOpts.abortController] - Phase 3: pass full controller
     * @param {object}   [queryOpts.adapterOptions] - { CLAUDE: { ... } }
     * @returns {Promise<QueryHandle>}
     */
    createQuery: async function(queryOpts) {
      var co = (queryOpts.adapterOptions && queryOpts.adapterOptions.CLAUDE) || {};
      var linuxUser = co.linuxUser;

      // Worker path: OS-level user isolation
      if (linuxUser) {
        return createWorkerQuery(queryOpts, co, linuxUser);
      }

      // In-process path
      var sdk = await loadSDK();
      var mq = createMessageQueue();
      var ac = queryOpts.abortController || new AbortController();

      // Build SDK-specific options
      var sdkOptions = {
        cwd: queryOpts.cwd || _cwd,
        abortController: ac,
      };
      if (_claudeBinaryPath) sdkOptions.pathToClaudeCodeExecutable = _claudeBinaryPath;

      // YOKE standard options -> SDK options
      if (queryOpts.systemPrompt) sdkOptions.systemPrompt = queryOpts.systemPrompt;
      if (queryOpts.model) sdkOptions.model = queryOpts.model;
      if (queryOpts.effort) sdkOptions.effort = queryOpts.effort;
      if (queryOpts.toolServers) sdkOptions.mcpServers = queryOpts.toolServers;
      if (queryOpts.canUseTool) sdkOptions.canUseTool = queryOpts.canUseTool;
      if (queryOpts.onElicitation) sdkOptions.onElicitation = queryOpts.onElicitation;
      if (queryOpts.resumeSessionId) sdkOptions.resume = queryOpts.resumeSessionId;

      // Claude-specific options from adapterOptions.CLAUDE
      if (co.settingSources) sdkOptions.settingSources = co.settingSources;
      if (co.includePartialMessages != null) sdkOptions.includePartialMessages = co.includePartialMessages;
      if (co.enableFileCheckpointing != null) sdkOptions.enableFileCheckpointing = co.enableFileCheckpointing;
      if (co.extraArgs) sdkOptions.extraArgs = co.extraArgs;
      if (co.promptSuggestions != null) sdkOptions.promptSuggestions = co.promptSuggestions;
      if (co.agentProgressSummaries != null) sdkOptions.agentProgressSummaries = co.agentProgressSummaries;
      if (co.agent) sdkOptions.agent = co.agent;
      if (co.agents) sdkOptions.agents = co.agents;
      // lr-5bd7: systemPrompt from co (adapterOptions.CLAUDE) takes precedence over
      // queryOpts.systemPrompt so named-agent body injection wins over caller defaults.
      if (co.systemPrompt) sdkOptions.systemPrompt = co.systemPrompt;
      if (co.thinking) sdkOptions.thinking = co.thinking;
      if (co.betas && co.betas.length > 0) sdkOptions.betas = co.betas;
      if (co.permissionMode) sdkOptions.permissionMode = co.permissionMode;
      if (co.allowDangerouslySkipPermissions) sdkOptions.allowDangerouslySkipPermissions = true;
      if (co.resumeSessionAt) sdkOptions.resumeSessionAt = co.resumeSessionAt;
      if (co.settings) sdkOptions.settings = co.settings;

      var rawQuery = sdk.query({ prompt: mq, options: sdkOptions });
      return createQueryHandle(rawQuery, mq, ac);
    },

    // --- Title generation ---
    generateTitle: async function(messages, opts) {
      console.log("[auto-title/claude] generateTitle called with " + messages.length + " messages");
      var systemPrompt = "You are a title generator. Output only a short title (3-8 words). No quotes, no punctuation at the end, no explanation.";
      var prompt = "Below is a conversation between a user and an AI assistant. Generate a short, descriptive title (3-8 words) that captures the main topic. Reply with ONLY the title, nothing else.\n\n";
      for (var i = 0; i < messages.length; i++) {
        prompt += "User message " + (i + 1) + ": " + messages[i] + "\n";
      }
      var ac = new AbortController();
      console.log("[auto-title/claude] Creating query with model=haiku...");
      var handle = await adapter.createQuery({
        cwd: (opts && opts.cwd) || _cwd,
        systemPrompt: systemPrompt,
        model: "haiku",
        adapterOptions: {
          CLAUDE: {
            settingSources: ["user"],
            permissionMode: "bypassPermissions",
          }
        },
        abortController: ac,
      });
      console.log("[auto-title/claude] Query created, pushing message...");
      handle.pushMessage(prompt);
      var title = "";
      var streamed = false;
      try {
        for await (var msg of handle) {
          if (msg.yokeType === "text_delta" && msg.text) {
            streamed = true;
            title += msg.text;
          } else if (msg.yokeType === "message" && msg.messageRole === "assistant" && !streamed && msg.content) {
            // Fallback: extract text from non-streamed message content
            var content = msg.content;
            if (Array.isArray(content)) {
              for (var ci = 0; ci < content.length; ci++) {
                if (content[ci].type === "text" && content[ci].text) {
                  title += content[ci].text;
                }
              }
            }
          } else if (msg.yokeType === "result") {
            break;
          }
        }
      } finally {
        handle.close();
      }
      console.log("[auto-title/claude] Generated: " + title.substring(0, 80));
      return title.replace(/[\r\n]+/g, " ").replace(/^["'\s]+|["'\s.]+$/g, "").trim();
    },

    // --- Session management ---
    // These delegate to SDK module-level functions.

    getSessionInfo: function(sessionId, sessionOpts) {
      return loadSDK().then(function(sdk) {
        return sdk.getSessionInfo(sessionId, sessionOpts);
      });
    },

    listSessions: function(sessionOpts) {
      return loadSDK().then(function(sdk) {
        return sdk.listSessions(sessionOpts);
      });
    },

    renameSession: function(sessionId, title, sessionOpts) {
      return loadSDK().then(function(sdk) {
        return sdk.renameSession(sessionId, title, sessionOpts);
      });
    },

    forkSession: function(sessionId, sessionOpts) {
      return loadSDK().then(function(sdk) {
        return sdk.forkSession(sessionId, sessionOpts);
      });
    },

    // --- Internal (Phase 3 transition) ---
    // These are NOT part of the YOKE interface. They exist to support
    // incremental migration and will be removed in later phases.

    /**
     * Get the raw SDK module (async). Used by sdk-message-processor.js during transition.
     * @returns {Promise<object>}
     */
    _loadSDK: loadSDK,
  };

  // --- Worker query creation (internal) ---

  async function createWorkerQuery(queryOpts, claudeOpts, linuxUser) {
    var workerCwd = queryOpts.cwd || _cwd;

    // Check for previous worker state (reuse pattern)
    var workerState = claudeOpts._workerState;
    var worker;
    var reusingWorker = false;

    // Wait for previous worker exit if needed
    if (workerState && workerState.exitPromise && !workerState.worker) {
      await Promise.race([
        workerState.exitPromise,
        new Promise(function(resolve) { setTimeout(resolve, 3000); }),
      ]);
    }

    // Reuse existing worker if alive
    if (workerState && workerState.worker && workerState.worker.ready &&
        workerState.worker.process && !workerState.worker.process.killed) {
      worker = workerState.worker;
      reusingWorker = true;
      // Clear old message handlers so they don't fire for the new query
      worker.messageHandlers = [];
      worker._queryEnded = false;
      worker._abortSent = false;
    } else {
      worker = spawnWorker(linuxUser, workerScriptPath, workerCwd);
    }

    // Create the worker query handle (sets up message handler on worker)
    var handle = createWorkerQueryHandle(worker, queryOpts.canUseTool, queryOpts.onElicitation, queryOpts.callMcpTool);

    // Wait for worker to be ready before sending query_start.
    // A 30s timeout ensures spawn failures surface as errors rather than
    // hanging forever (worker._readyReject fires on early exit, but the
    // timeout guards against silent stalls such as a socket that never
    // connects without the process dying).
    if (!reusingWorker) {
      await Promise.race([
        worker.readyPromise,
        new Promise(function(_, reject) {
          setTimeout(function() {
            console.warn("[yoke/claude] Worker ready timeout (30s) for " + linuxUser + " — spawn may have stalled");
            reject(new Error("Worker ready timeout: worker did not become ready within 30s"));
          }, 30000);
        }),
      ]);
    }

    // Build serializable query options (no callbacks, no AbortController)
    var queryOptions = {
      cwd: workerCwd,
    };
    if (claudeOpts.settingSources) queryOptions.settingSources = claudeOpts.settingSources;
    if (claudeOpts.includePartialMessages != null) queryOptions.includePartialMessages = claudeOpts.includePartialMessages;
    if (claudeOpts.enableFileCheckpointing != null) queryOptions.enableFileCheckpointing = claudeOpts.enableFileCheckpointing;
    if (claudeOpts.extraArgs) queryOptions.extraArgs = claudeOpts.extraArgs;
    if (claudeOpts.promptSuggestions != null) queryOptions.promptSuggestions = claudeOpts.promptSuggestions;
    if (claudeOpts.agentProgressSummaries != null) queryOptions.agentProgressSummaries = claudeOpts.agentProgressSummaries;
    if (claudeOpts.agent) queryOptions.agent = claudeOpts.agent;
    if (claudeOpts.agents) queryOptions.agents = claudeOpts.agents;
    // lr-5bd7: forward systemPrompt to the worker so named-agent body injection reaches the SDK.
    if (claudeOpts.systemPrompt) queryOptions.systemPrompt = claudeOpts.systemPrompt;
    if (claudeOpts.thinking) queryOptions.thinking = claudeOpts.thinking;
    if (claudeOpts.betas && claudeOpts.betas.length > 0) queryOptions.betas = claudeOpts.betas;
    if (claudeOpts.permissionMode) queryOptions.permissionMode = claudeOpts.permissionMode;
    if (claudeOpts.allowDangerouslySkipPermissions) queryOptions.allowDangerouslySkipPermissions = true;
    if (claudeOpts.settings) queryOptions.settings = claudeOpts.settings;

    if (queryOpts.toolServerDescriptors) queryOptions.mcpServerDescriptors = queryOpts.toolServerDescriptors;
    if (queryOpts.model) queryOptions.model = queryOpts.model;
    if (queryOpts.effort) queryOptions.effort = queryOpts.effort;
    if (queryOpts.resumeSessionId) queryOptions.resume = queryOpts.resumeSessionId;
    if (claudeOpts.resumeSessionAt) queryOptions.resumeSessionAt = claudeOpts.resumeSessionAt;

    // Send query_start; the caller pushes the initial message via handle.pushMessage()
    // which routes through worker IPC.
    // NOTE: We do NOT send query_start with a prompt here. The caller (sdk-bridge)
    // will push the initial message and the worker receives it via push_message.
    // Instead, we send query_start with no prompt; the worker starts a query with
    // the message queue, and the first push_message will arrive.
    worker.send({
      type: "query_start",
      prompt: null,
      options: queryOptions,
      singleTurn: !!claudeOpts.singleTurn,
      originalHome: claudeOpts.originalHome || null,
      projectPath: claudeOpts.projectPath || null,
      _perfT0: claudeOpts._perfT0 || Date.now(),
    });

    return handle;
  }

  adapter.init = async function(initOpts) {
    var linuxUser = initOpts && initOpts.linuxUser;
    if (!linuxUser) {
      // In-process warmup
      var sdk = await loadSDK();
      var ac = new AbortController();
      var mq = createMessageQueue();
      mq.push({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
      mq.end();

      var warmupOptions = {
        cwd: (initOpts && initOpts.cwd) || _cwd,
        settingSources: ["user", "project", "local"],
        abortController: ac,
        settings: { disableAllHooks: true },
      };
      if (_claudeBinaryPath) warmupOptions.pathToClaudeCodeExecutable = _claudeBinaryPath;

      if (initOpts && initOpts.dangerouslySkipPermissions) {
        warmupOptions.permissionMode = "bypassPermissions";
        warmupOptions.allowDangerouslySkipPermissions = true;
      }

      var result = {
        models: [],
        defaultModel: "",
        skills: [],
        slashCommands: [],
        fastModeState: null,
        capabilities: {
          thinking: true,
          betas: true,
          rewind: true,
          sessionResume: true,
          promptSuggestions: true,
          elicitation: true,
          fileCheckpointing: true,
          contextCompacting: true,
          toolPolicy: ["ask", "allow-all"],
        },
      };

      try {
        var stream = sdk.query({ prompt: mq, options: warmupOptions });

        for await (var msg of stream) {
          if (msg.type === "system" && msg.subtype === "init") {
            result.skills = msg.skills || [];
            result.defaultModel = msg.model || "";
            result.slashCommands = msg.slash_commands || [];
            result.fastModeState = msg.fast_mode_state || null;

            try {
              var models = await stream.supportedModels();
              result.models = enrichClaudeModelsWithCatalog(models || []);
              _cachedModels = result.models;
            } catch (e) {
              // supportedModels may fail, models list will be empty
            }

            ac.abort();
            break;
          }
        }
      } catch (e) {
        if (e && e.name !== "AbortError" && !(e.message && e.message.indexOf("aborted") !== -1)) {
          throw e;
        }
      }

      return result;
    }

    // Worker-based warmup
    var worker;
    var workerCwd = (initOpts && initOpts.cwd) || _cwd;
    try {
      worker = spawnWorker(linuxUser, workerScriptPath, workerCwd);
    } catch (e) {
      throw new Error("Failed to spawn warmup worker for " + linuxUser + ": " + (e.message || e));
    }

    try {
      await Promise.race([
        worker.readyPromise,
        new Promise(function(_, reject) {
          setTimeout(function() {
            console.warn("[yoke/claude] Warmup worker ready timeout (30s) for " + linuxUser + " — spawn may have stalled");
            reject(new Error("Warmup worker ready timeout: worker did not become ready within 30s"));
          }, 30000);
        }),
      ]);
    } catch (e) {
      cleanupWorker(worker);
      throw new Error("Warmup worker failed to connect: " + (e.message || e));
    }

    var warmupOptions = { cwd: workerCwd, settingSources: ["user", "project", "local"], settings: { disableAllHooks: true } };
    if (_claudeBinaryPath) warmupOptions.pathToClaudeCodeExecutable = _claudeBinaryPath;
    if (initOpts && initOpts.dangerouslySkipPermissions) {
      warmupOptions.permissionMode = "bypassPermissions";
      warmupOptions.allowDangerouslySkipPermissions = true;
    }

    return new Promise(function(resolve, reject) {
      var warmupDone = false;

      worker.onMessage(function(msg) {
        if (msg.type === "warmup_done" && !warmupDone) {
          warmupDone = true;
          var r = msg.result || {};
          var enrichedModels = enrichClaudeModelsWithCatalog(r.models || []);
          _cachedModels = enrichedModels;
          resolve({
            models: enrichedModels,
            defaultModel: r.model || "",
            skills: r.skills || [],
            slashCommands: r.slashCommands || [],
            fastModeState: r.fastModeState || null,
            capabilities: {
              thinking: true,
              betas: true,
              rewind: true,
              sessionResume: true,
              promptSuggestions: true,
              elicitation: true,
              fileCheckpointing: true,
              contextCompacting: true,
              toolPolicy: ["ask", "allow-all"],
            },
          });
          worker.kill();
        } else if (msg.type === "warmup_error" && !warmupDone) {
          warmupDone = true;
          worker.kill();
          reject(new Error(msg.error || "Warmup failed"));
        }
      });

      worker.send({ type: "warmup", options: warmupOptions });
    });
  };

  return adapter;
}

module.exports = {
  createClaudeAdapter: createClaudeAdapter,
  createMessageQueue: createMessageQueue,
  _test_handleWorkerEarlyExit: _test_handleWorkerEarlyExit,
  // Test seam for hop-A diagnostic routing (lr-0868): allows test/diagnostic-routing-lr-0868.test.js
  // to call flattenEvent directly without spawning a worker process.
  _test_flattenEvent: flattenEvent,
  // Test seams for lr-e03635 latest/older model tiering: exercise the pure
  // enrichment/derivation functions directly without spinning up the SDK.
  _test_enrichClaudeModels: enrichClaudeModels,
  _test_enrichClaudeModel: enrichClaudeModel,
  _test_deriveClaudeLatestTiers: deriveClaudeLatestTiers,
  // Test seams for lr-f22787 (behavior corrected by lr-d3817f): static
  // catalog merge, exercised directly without touching the filesystem-
  // backed catalog loader or spinning up the SDK. (Alias/description
  // reconciliation, reconcileAliasesWithCatalogIds, was removed by
  // lr-d3817f — the collapsed picker view must show the vendor's own
  // alias untouched, not a substituted concrete ID.)
  _test_mergeStaticCatalog: mergeStaticCatalog,
  _test_enrichClaudeModelsWithCatalog: enrichClaudeModelsWithCatalog,
};


// Codex App-Server Protocol Client
// ---------------------------------
// Manages a codex app-server child process with bidirectional JSON-RPC
// communication over stdin/stdout. Replaces the SDK exec mode to enable
// interactive approval flows. The binary is the Codex the user installed
// (codex-binary.js resolves it); the console bundles none.

var readline = require("readline");
var { spawnCodex } = require("./codex-command");

// --- Config serialization ---
// Flattens a nested config object into --config key=value pairs.
// Values are serialized as TOML literals (strings quoted, others raw).
// e.g. { mcp_servers: { "clay-tools": { command: "node", args: ["a.js"] } } }
// -> ["mcp_servers.clay-tools.command=\"node\"", "mcp_servers.clay-tools.args=[\"a.js\"]"]

// A TOML key segment that is not made of letters, digits, "_" and "-" (a
// project path, say) must be quoted, or its dots and slashes split the key.
function tomlKeySegment(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function serializeConfig(obj, prefix) {
  var result = [];
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var val = obj[key];
    var fullKey = prefix ? prefix + "." + tomlKeySegment(key) : tomlKeySegment(key);

    if (val === null || val === undefined) continue;

    if (typeof val === "object" && !Array.isArray(val)) {
      // Recurse for nested objects
      var nested = serializeConfig(val, fullKey);
      for (var j = 0; j < nested.length; j++) {
        result.push(nested[j]);
      }
    } else {
      // Leaf value: serialize as TOML
      result.push(fullKey + "=" + toTomlValue(val));
    }
  }
  return result;
}

function toTomlValue(val) {
  if (typeof val === "string") return JSON.stringify(val);
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  if (Array.isArray(val)) return "[" + val.map(function(v) { return toTomlValue(v); }).join(", ") + "]";
  return JSON.stringify(val);
}

// --- CodexAppServer ---

// executablePath is the resolved Codex binary (codex-binary.js). Without one
// the user's installed Codex is resolved here, and a Codex that is absent or
// too old fails construction with a named error.
//
// opts: { cwd, env, config }
//   env      the environment laid over the daemon's own
function CodexAppServer(executablePath, opts) {
  this.proc = null;
  this.rl = null;
  this.nextId = 1;
  // Keyed by ids the app-server echoes back: no prototype to answer for them.
  this.pendingRequests = Object.create(null);  // id -> { resolve, reject, timer }
  // eventHandler kept for backward-compat but superseded by the multiplexer below.
  // Use addEventHandler / removeEventHandler instead of setting this directly.
  this.eventHandler = null;
  this._eventHandlers = [];   // [{ threadId: string|null, fn: function }]
  this.opts = opts || {};
  // What resolving the binary found (path, version), when it was resolved here.
  this.resolution = null;
  if (!executablePath) {
    this.resolution = require("./codex-binary").requireCodex();
    executablePath = this.resolution.path;
  }
  this.executablePath = executablePath;
  this.started = false;
  this._stderrBuf = "";
}

CodexAppServer.prototype.start = function() {
  var self = this;

  return new Promise(function(resolve, reject) {
    try {
      var args = ["app-server"];
      var env = Object.assign({}, process.env, self.opts.env || {});

      // Pass config overrides via --config key=value flags
      if (self.opts.config) {
        var configArgs = serializeConfig(self.opts.config, "");
        for (var ci = 0; ci < configArgs.length; ci++) {
          args.push("--config", configArgs[ci]);
        }
      }

      console.log("[codex-app-server] Spawning:", self.executablePath, args.join(" "));

      // spawnCodex runs a Windows .cmd/.bat shim through the command interpreter.
      self.proc = spawnCodex(self.executablePath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: env,
        cwd: self.opts.cwd || process.cwd(),
      }, self.opts.commandDeps);

      self.proc.on("error", function(err) {
        console.error("[codex-app-server] Process error:", err.message);
        if (!self.started) {
          reject(err);
        }
        self._rejectAllPending(err);
      });

      self.proc.on("exit", function(code, signal) {
        console.log("[codex-app-server] Process exited: code=" + code + " signal=" + signal);
        self.started = false;
        self._rejectAllPending(new Error("Process exited: code=" + code));
      });

      // Collect stderr for debugging
      self.proc.stderr.on("data", function(chunk) {
        var text = chunk.toString();
        self._stderrBuf += text;
        // Print stderr lines as they come
        var lines = self._stderrBuf.split("\n");
        while (lines.length > 1) {
          var line = lines.shift();
          if (line.trim()) console.log("[codex-app-server stderr]", line);
        }
        self._stderrBuf = lines[0] || "";
      });

      // Set up line-based JSON-RPC reading from stdout
      self.rl = readline.createInterface({
        input: self.proc.stdout,
        crlfDelay: Infinity,
      });

      self.rl.on("line", function(line) {
        if (!line.trim()) return;
        try {
          var msg = JSON.parse(line);
          self._handleMessage(msg);
        } catch (e) {
          console.error("[codex-app-server] Failed to parse line:", line.substring(0, 200));
        }
      });

      self.rl.on("close", function() {
        console.log("[codex-app-server] stdout closed");
      });

      self.started = true;
      resolve();
    } catch (e) {
      reject(e);
    }
  });
};

CodexAppServer.prototype._handleMessage = function(msg) {
  // Response to a request we sent
  if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined)) {
    var pending = this.pendingRequests[msg.id];
    if (pending) {
      delete this.pendingRequests[msg.id];
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
    }
    return;
  }

  // Server-initiated request (has id + method) or notification (has method, no id)
  if (msg.method) {
    var threadId = (msg.params && msg.params.threadId) || null;
    var dispatched = false;

    // Multiplexed handlers (registered via addEventHandler).
    // A handler with a known threadId only receives events for that thread.
    // A handler with threadId=null receives all events (used during thread/start
    // before the threadId is known, then updated once it is).
    var handlers = this._eventHandlers;
    for (var hi = 0; hi < handlers.length; hi++) {
      var entry = handlers[hi];
      if (entry.threadId === null || entry.threadId === threadId) {
        entry.fn(msg);
        dispatched = true;
      }
    }

    // Legacy single-handler fallback (only used if no multiplexed handlers registered)
    if (!dispatched) {
      if (this.eventHandler) {
        this.eventHandler(msg);
      } else {
        console.log("[codex-app-server] Unhandled event:", msg.method);
      }
    }
  }
};

// Send a JSON-RPC request (expects a response)
CodexAppServer.prototype.send = function(method, params, timeoutMs) {
  var self = this;
  var id = this.nextId++;
  timeoutMs = timeoutMs || 30000;

  return new Promise(function(resolve, reject) {
    if (!self.proc || !self.started) {
      return reject(new Error("App-server not started"));
    }

    var timer = setTimeout(function() {
      delete self.pendingRequests[id];
      reject(new Error("Request timeout: " + method + " (id=" + id + ")"));
    }, timeoutMs);

    self.pendingRequests[id] = { resolve: resolve, reject: reject, timer: timer };

    var msg = { jsonrpc: "2.0", id: id, method: method };
    if (params !== undefined) msg.params = params;

    self._write(msg);
  });
};

// Send a JSON-RPC notification (no response expected)
CodexAppServer.prototype.notify = function(method, params) {
  if (!this.proc || !this.started) return;

  var msg = { jsonrpc: "2.0", method: method };
  if (params !== undefined) msg.params = params;

  this._write(msg);
};

// Respond to a server-initiated request
CodexAppServer.prototype.respond = function(id, result) {
  if (!this.proc || !this.started) return;

  var msg = { jsonrpc: "2.0", id: id, result: result };
  this._write(msg);
};

// Respond with an error to a server-initiated request
CodexAppServer.prototype.respondError = function(id, code, message) {
  if (!this.proc || !this.started) return;

  var msg = { jsonrpc: "2.0", id: id, error: { code: code || -1, message: message || "Error" } };
  this._write(msg);
};

CodexAppServer.prototype._write = function(msg) {
  if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return;
  try {
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  } catch (e) {
    console.error("[codex-app-server] Write error:", e.message);
  }
};

CodexAppServer.prototype._rejectAllPending = function(err) {
  var ids = Object.keys(this.pendingRequests);
  for (var i = 0; i < ids.length; i++) {
    var pending = this.pendingRequests[ids[i]];
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(err);
  }
  this.pendingRequests = Object.create(null);
};

// Register an event handler for a specific thread (or null to receive all events).
// Returns a handle object that can be passed to removeEventHandler or updateHandlerThreadId.
CodexAppServer.prototype.addEventHandler = function(fn, threadId) {
  var entry = { fn: fn, threadId: threadId || null };
  this._eventHandlers.push(entry);
  return entry;
};

// Remove a previously registered handler.
CodexAppServer.prototype.removeEventHandler = function(entry) {
  var next = [];
  for (var i = 0; i < this._eventHandlers.length; i++) {
    if (this._eventHandlers[i] !== entry) next.push(this._eventHandlers[i]);
  }
  this._eventHandlers = next;
};

// Update the threadId filter on a handler once the thread ID is known.
// Until called, the handler receives all events (threadId=null).
CodexAppServer.prototype.updateHandlerThreadId = function(entry, threadId) {
  entry.threadId = threadId || null;
};

CodexAppServer.prototype.stop = function() {
  this.started = false;
  this._rejectAllPending(new Error("Stopped"));

  if (this.rl) {
    this.rl.close();
    this.rl = null;
  }

  if (this.proc) {
    try {
      this.proc.stdin.end();
    } catch (e) {}
    try {
      this.proc.kill("SIGTERM");
    } catch (e) {}
    this.proc = null;
  }
};

module.exports = {
  CodexAppServer: CodexAppServer,
  serializeConfig: serializeConfig,
};

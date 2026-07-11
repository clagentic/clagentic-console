var net = require("net");
var fs = require("fs");

/**
 * Connect-probe a Unix domain socket to see whether a live process is
 * listening on it. Mirrors config.js's checkOldDaemon/isDaemonAliveAsync
 * pattern: absence of the socket file, a connect error, or a timeout are all
 * treated as "not alive" so a genuinely stale socket can still be reclaimed.
 * Resolves true only on a successful TCP-level connect to the socket.
 */
function probeSocket(sockPath, timeoutMs) {
  return new Promise(function (resolve) {
    if (!fs.existsSync(sockPath)) return resolve(false);

    var client = net.connect(sockPath);
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      client.destroy();
      resolve(false);
    }, timeoutMs || 1000);

    client.on("connect", function () {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.destroy();
      resolve(true);
    });

    client.on("error", function () {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Create IPC server on a Unix domain socket.
 * handler(msg) should return a response object (or a Promise of one).
 *
 * Before binding, connect-probes sockPath (like checkOldDaemon). If a live
 * process answers, this refuses to start rather than unlinking the socket
 * out from under it — stealing a live daemon's socket left --shutdown/
 * --restart/--add all "not responding" against the orphaned original process
 * (lr-1bdb item A). onLiveDaemon (optional) is invoked in that case instead
 * of binding; callers should treat it as a fatal startup condition. A socket
 * file that exists but nothing answers on is genuinely stale and is unlinked
 * as before.
 */
function createIPCServer(sockPath, handler, onLiveDaemon) {
  // Ensure the socket's parent directory exists (e.g. ~/.clagentic/console/).
  // The daemon may start without a prior CLI invocation, so it must be self-sufficient.
  if (process.platform !== "win32") {
    try { fs.mkdirSync(require("path").dirname(sockPath), { recursive: true }); } catch (e) {}
  }

  // Returned synchronously so callers (e.g. daemon.js's gracefulShutdown) can
  // always call .close() safely, even if invoked before the async probe below
  // resolves and the real server binds.
  var _server = null;
  var handle = {
    close: function () {
      if (_server) _server.close();
      if (process.platform !== "win32") {
        try { fs.unlinkSync(sockPath); } catch (e) {}
      }
    },
  };

  function doBind() {
    var server = net.createServer(function (conn) {
      var buffer = "";
      conn.setEncoding("utf8");

      conn.on("data", function (chunk) {
        buffer += chunk;
        var lines = buffer.split("\n");
        buffer = lines.pop(); // keep incomplete line

        for (var i = 0; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          try {
            var msg = JSON.parse(lines[i]);
            var result = handler(msg);
            // Support both sync and async handlers
            if (result && typeof result.then === "function") {
              (function (c) {
                result.then(function (res) {
                  try { c.write(JSON.stringify(res) + "\n"); } catch (e) {}
                }).catch(function (err) {
                  try { c.write(JSON.stringify({ ok: false, error: err.message }) + "\n"); } catch (e) {}
                });
              })(conn);
            } else {
              conn.write(JSON.stringify(result) + "\n");
            }
          } catch (e) {
            try { conn.write(JSON.stringify({ ok: false, error: "parse error" }) + "\n"); } catch (e2) {}
          }
        }
      });

      conn.on("error", function () {});
    });

    var retried = false;
    server.on("error", function (err) {
      if (err.code === "EADDRINUSE" && !retried) {
        retried = true;
        console.log("[ipc] Socket in use, removing stale socket and retrying...");
        try { fs.unlinkSync(sockPath); } catch (e) {}
        server.listen(sockPath);
      } else if (err.code === "ENOENT" && !retried) {
        // Parent directory missing — create it and retry once.
        retried = true;
        console.log("[ipc] Socket directory missing, creating and retrying...");
        try { fs.mkdirSync(require("path").dirname(sockPath), { recursive: true }); } catch (e) {}
        server.listen(sockPath);
      } else {
        console.error("[ipc] Failed to bind socket:", err.message);
        process.exit(1);
      }
    });
    server.listen(sockPath);
    _server = server;
  }

  if (process.platform !== "win32") {
    probeSocket(sockPath).then(function (alive) {
      if (alive) {
        console.error("[ipc] Refusing to start: a live daemon is already listening on " + sockPath);
        if (typeof onLiveDaemon === "function") {
          onLiveDaemon();
        } else {
          process.exit(1);
        }
        return;
      }
      // Socket file (if any) is genuinely stale — safe to remove before binding.
      try { fs.unlinkSync(sockPath); } catch (e) {}
      doBind();
    });
  } else {
    doBind();
  }

  return handle;
}

/**
 * Send a command to the daemon IPC server and wait for response.
 * Returns a Promise resolving to the parsed response.
 */
function sendIPCCommand(sockPath, message, timeout) {
  var timeoutMs = timeout || 3000;
  return new Promise(function (resolve) {
    var client = net.connect(sockPath);
    var buffer = "";
    var done = false;

    var timer = setTimeout(function () {
      if (!done) {
        done = true;
        client.destroy();
        resolve({ ok: false, error: "timeout" });
      }
    }, timeoutMs);

    client.on("connect", function () {
      client.write(JSON.stringify(message) + "\n");
    });

    client.on("data", function (chunk) {
      buffer += chunk;
      var idx = buffer.indexOf("\n");
      if (idx !== -1 && !done) {
        done = true;
        clearTimeout(timer);
        try {
          var resp = JSON.parse(buffer.substring(0, idx));
          resolve(resp);
        } catch (e) {
          resolve({ ok: false, error: "invalid response" });
        }
        client.destroy();
      }
    });

    client.on("error", function (err) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, error: err.code === "ECONNREFUSED" ? "daemon not responding" : err.message });
      }
    });
  });
}

module.exports = {
  createIPCServer: createIPCServer,
  sendIPCCommand: sendIPCCommand,
  probeSocket: probeSocket,
};

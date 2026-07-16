// lib/cli/ipc-subcommands.js
//
// One-shot IPC subcommand handlers for bin/cli.js: --shutdown, --restart,
// --add <path>, --remove <path>, --list. Each of these talks to the running
// daemon over the Unix socket and exits the process directly (they never
// return control to the caller) — extracted verbatim from bin/cli.js
// (lr-4e49 Part 1), no behavior change.

var fs = require("fs");
var path = require("path");

var { loadConfig, socketPath, isDaemonAliveAsync, checkOldDaemon, clearStaleConfig } = require("../config");
var { sendIPCCommand } = require("../ipc");

function handleShutdown() {
  var shutdownConfig = loadConfig();
  isDaemonAliveAsync(shutdownConfig).then(function (alive) {
    if (alive) {
      return sendIPCCommand(socketPath(), { cmd: "shutdown" }).then(function (resp) {
        if (resp && resp.ok) {
          console.log("Server stopped.");
          clearStaleConfig();
          process.exit(0);
        } else {
          var pid = shutdownConfig && shutdownConfig.pid;
          console.error("Shutdown failed: daemon did not acknowledge the command.");
          if (pid) console.error("  Daemon PID: " + pid + "  (try: kill " + pid + ")");
          console.error("  Or: systemctl restart clagentic-console");
          process.exit(1);
        }
      });
    }
    // New socket not alive — check whether a pre-1.5 daemon is on the old path
    return checkOldDaemon().then(function (old) {
      if (old && old.alive) {
        console.log("[migration] Sending shutdown to pre-1.5 daemon at " + old.sockPath);
        return sendIPCCommand(old.sockPath, { cmd: "shutdown" }).then(function (resp) {
          if (resp && resp.ok) {
            console.log("Server stopped.");
            process.exit(0);
          } else {
            var oldPid = shutdownConfig && shutdownConfig.pid;
            console.error("Shutdown of pre-1.5 daemon failed: no acknowledgement from " + old.sockPath);
            if (oldPid) console.error("  Daemon PID: " + oldPid + "  (try: kill " + oldPid + ")");
            console.error("  Or: systemctl restart clagentic-console");
            process.exit(1);
          }
        });
      }
      console.error("No running daemon found.");
      process.exit(1);
    });
  });
}

function handleRestart() {
  var restartConfig = loadConfig();
  isDaemonAliveAsync(restartConfig).then(function (alive) {
    if (alive) {
      return sendIPCCommand(socketPath(), { cmd: "restart" }).then(function (resp) {
        if (resp && resp.ok) {
          console.log("Server restarted.");
          process.exit(0);
        } else {
          var pid = restartConfig && restartConfig.pid;
          console.error("Restart failed: daemon did not acknowledge the command.");
          if (pid) console.error("  Daemon PID: " + pid + "  (try: kill " + pid + " && clagentic-console)");
          console.error("  Or: systemctl restart clagentic-console");
          process.exit(1);
        }
      });
    }
    // New socket not alive — check whether a pre-1.5 daemon is on the old path
    return checkOldDaemon().then(function (old) {
      if (old && old.alive) {
        // Pre-1.5 daemon does not understand {cmd:"restart"} for the CLI restart
        // flow (it would restart on the old socket path). Shut it down instead so
        // the caller can re-run without a port conflict.
        console.log("[migration] Pre-1.5 daemon found at " + old.sockPath + " — shutting it down so a fresh start can proceed.");
        return sendIPCCommand(old.sockPath, { cmd: "shutdown" }).then(function (resp) {
          if (resp && resp.ok) {
            console.log("Pre-1.5 daemon stopped. Run clagentic-console to start the updated daemon.");
            process.exit(0);
          } else {
            var oldPid = restartConfig && restartConfig.pid;
            console.error("Shutdown of pre-1.5 daemon failed: no acknowledgement from " + old.sockPath);
            if (oldPid) console.error("  Daemon PID: " + oldPid + "  (try: kill " + oldPid + ")");
            console.error("  Or: systemctl restart clagentic-console");
            process.exit(1);
          }
        });
      }
      console.error("No running daemon found.");
      process.exit(1);
    });
  });
}

function handleAdd(addPath) {
  var absAdd = path.resolve(addPath);
  try {
    var stat = fs.statSync(absAdd);
    if (!stat.isDirectory()) {
      console.error("Not a directory: " + absAdd);
      process.exit(1);
    }
  } catch (e) {
    console.error("Directory not found: " + absAdd);
    process.exit(1);
  }
  var addConfig = loadConfig();
  isDaemonAliveAsync(addConfig).then(function (alive) {
    if (!alive) {
      console.error("No running daemon. Start with: npx @clagentic/console");
      process.exit(1);
    }
    sendIPCCommand(socketPath(), { cmd: "add_project", path: absAdd }).then(function (res) {
      if (res.ok) {
        if (res.existing) {
          console.log("Already registered: " + res.slug);
        } else {
          console.log("Added: " + res.slug + " → " + absAdd);
        }
        process.exit(0);
      } else {
        console.error("Failed: " + (res.error || "unknown error"));
        process.exit(1);
      }
    });
  });
}

function handleRemove(removePath) {
  var absRemove = path.resolve(removePath);
  var removeConfig = loadConfig();
  isDaemonAliveAsync(removeConfig).then(function (alive) {
    if (!alive) {
      console.error("No running daemon. Start with: npx @clagentic/console");
      process.exit(1);
    }
    sendIPCCommand(socketPath(), { cmd: "remove_project", path: absRemove }).then(function (res) {
      if (res.ok) {
        console.log("Removed: " + path.basename(absRemove));
        process.exit(0);
      } else {
        console.error("Failed: " + (res.error || "project not found"));
        process.exit(1);
      }
    });
  });
}

function handleList() {
  var listConfig = loadConfig();
  isDaemonAliveAsync(listConfig).then(function (alive) {
    if (!alive) {
      console.error("No running daemon. Start with: npx @clagentic/console");
      process.exit(1);
    }
    sendIPCCommand(socketPath(), { cmd: "get_status" }).then(function (res) {
      if (!res.ok || !res.projects || res.projects.length === 0) {
        console.log("No projects registered.");
        process.exit(0);
        return;
      }
      console.log("Projects (" + res.projects.length + "):\n");
      for (var p = 0; p < res.projects.length; p++) {
        var proj = res.projects[p];
        var label = "  " + proj.slug;
        if (proj.title) label += " (" + proj.title + ")";
        label += "\n    " + proj.path;
        console.log(label);
      }
      console.log("");
      process.exit(0);
    });
  });
}

module.exports = {
  handleShutdown: handleShutdown,
  handleRestart: handleRestart,
  handleAdd: handleAdd,
  handleRemove: handleRemove,
  handleList: handleList,
};

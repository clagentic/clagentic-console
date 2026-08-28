// lib/cli/ipc-subcommands.js
//
// One-shot IPC subcommand handlers for bin/cli.js: --shutdown, --restart,
// --add <path>, --remove <path>, --list, --activity-diagnostics. Each of
// these talks to the running daemon over the Unix socket and exits the
// process directly (they never return control to the caller) —
// --shutdown/--restart/--add/--remove/--list extracted verbatim from
// bin/cli.js (lr-4e49 Part 1), no behavior change.
// --activity-diagnostics added by lr-8b476f: the only agent-readable
// (Bash+Read, no browser/WS/devtools) retrieval path for the lr-58c813
// server-side activity-divergence probe. Prints raw JSON to stdout so a
// read-only crew agent can run this directly.
// --process-build-status added by lr-dc9a3b: reports the build SHA the
// RUNNING daemon actually loaded at startup (distinct from the on-disk
// artifact's build-sha.json), so scripts/verify-installed-build.js can gate
// on process build identity, not just artifact build identity.

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

// lr-dc9a3b: prints the running process's build-identity status (same data
// lib/daemon.js's "get_build_status" IPC case returns) as raw JSON to
// stdout. This is the retrieval path scripts/verify-installed-build.js uses
// to check what the RUNNING daemon loaded, distinct from what the ON-DISK
// artifact contains (see that script's own header comment for the
// artifact-vs-process distinction this exists to close):
// `clagentic-console --process-build-status`.
function handleProcessBuildStatus() {
  var statusConfig = loadConfig();
  isDaemonAliveAsync(statusConfig).then(function (alive) {
    if (!alive) {
      // No running daemon is not itself an error here -- a caller comparing
      // artifact vs. process needs to be able to tell "nothing to compare
      // against" apart from "compared and it mismatched". Distinguish via
      // ok:false + a stable error string rather than a bare non-zero exit
      // with no machine-readable reason.
      console.log(JSON.stringify({ ok: false, error: "no running daemon" }, null, 2));
      process.exit(1);
      return;
    }
    sendIPCCommand(socketPath(), { cmd: "get_build_status" }).then(function (res) {
      if (!res.ok) {
        console.error("Failed: " + (res.error || "unknown error"));
        process.exit(1);
        return;
      }
      // Raw JSON to stdout -- the point is machine readability for a gate
      // script, not a human-formatted summary (contrast handleList's
      // formatted output).
      console.log(JSON.stringify({
        loadedBuildSha: res.loadedBuildSha,
        staleInodes: res.staleInodes,
        pid: res.pid,
      }, null, 2));
      process.exit(0);
    });
  });
}

// lr-8b476f: prints the activity-divergence probe totals (same data
// process_stats's WS response folds in, see lib/daemon.js's
// "get_activity_diagnostics" IPC case) as raw JSON to stdout. This is the
// retrieval path for a read-only crew agent (Bash+Read only, no browser,
// no WS client, no devtools): `clagentic-console --activity-diagnostics`.
function handleActivityDiagnostics() {
  var diagConfig = loadConfig();
  isDaemonAliveAsync(diagConfig).then(function (alive) {
    if (!alive) {
      console.error("No running daemon. Start with: npx @clagentic/console");
      process.exit(1);
    }
    sendIPCCommand(socketPath(), { cmd: "get_activity_diagnostics" }).then(function (res) {
      if (!res.ok) {
        console.error("Failed: " + (res.error || "unknown error"));
        process.exit(1);
        return;
      }
      // Raw JSON to stdout — the point is machine readability, not a
      // human-formatted summary (contrast handleList's formatted output).
      console.log(JSON.stringify({
        activeLiveCount: res.activeLiveCount,
        activityDivergenceCount: res.activityDivergenceCount,
        activityDivergenceRecentSamples: res.activityDivergenceRecentSamples,
      }, null, 2));
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
  handleActivityDiagnostics: handleActivityDiagnostics,
  handleProcessBuildStatus: handleProcessBuildStatus,
};

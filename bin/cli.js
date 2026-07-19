#!/usr/bin/env node

// --- Node version check (must run before any require that may use Node 20+ features) ---
var _nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
if (_nodeMajor < 20) {
  console.error("");
  console.error("\x1b[31m[clagentic-console] Node.js 20+ is required (current: " + process.version + ")\x1b[0m");
  console.error("[clagentic-console] The Claude Agent SDK 0.2.40+ requires Node 20 for Symbol.dispose support.");
  console.error("");
  console.error("  Upgrade Node:  nvm install 22 && nvm use 22");
  console.error("");
  process.exit(78);
}

var fs = require("fs");
var path = require("path");

// Detect dev mode — dev and prod use separate daemon files so they can run simultaneously
var _isDev = (process.argv[1] && path.basename(process.argv[1]) === "clagentic-dev") || process.argv.includes("--dev");
if (_isDev) {
  process.env.CLAGENTIC_DEV = "1";
}

// Preserve console output in dev/debug mode so logs remain readable
if (_isDev || process.argv.includes("--debug")) {
  console.clear = function() {};
}

var { loadConfig, socketPath, isDaemonAliveAsync, checkOldDaemon, clearStaleConfig, loadClayrc } = require("../lib/config");
var { sendIPCCommand } = require("../lib/ipc");

var { forkDaemon, devMode, setDaemonWatcherOpts } = require("../lib/cli/daemon-launch");
var { setup, promptRestoreProjects, showMainMenu } = require("../lib/cli/menus");
var { getLocalIP } = require("../lib/cli/net-detect");
var { log, a, sym } = require("../lib/cli/tui");
var { handleShutdown, handleRestart, handleAdd, handleRemove, handleList } = require("../lib/cli/ipc-subcommands");

var args = process.argv.slice(2);

// --- `release` subcommand group (release-engineering helpers, lr-01c6) ---
// Positional subcommand, handled before flag parsing: `clagentic-console release list-betas`.
if (args[0] === "release") {
  var releaseSub = args[1];
  if (releaseSub === "list-betas") {
    var releaseList = require("../lib/release-list");
    var betasResult = releaseList.readBetasFile(process.cwd());
    var betasLines = releaseList.formatBetasOutput(betasResult);
    for (var bl = 0; bl < betasLines.length; bl++) {
      console.log(betasLines[bl]);
    }
    process.exit(betasResult.ok ? 0 : 1);
  } else {
    console.error("Unknown release subcommand: " + (releaseSub || "(none)"));
    console.error("Usage: clagentic-console release list-betas");
    process.exit(1);
  }
}

var port = _isDev ? 2635 : 2633;
var useHttps = true;
var forceMkcert = false;
var skipUpdate = false;
var debugMode = false;
var autoYes = false;
var cliPin = null;
var shutdownMode = false;
var restartMode = false;
var noRestart = false;
var addPath = null;
var removePath = null;
var listMode = false;
var dangerouslySkipPermissions = false;
var headlessMode = false;
var watchMode = false;
var host = null;
var multiUserMode = false;
var osUsersMode = false;

for (var i = 0; i < args.length; i++) {
  if (args[i] === "-p" || args[i] === "--port") {
    port = parseInt(args[i + 1], 10);
    if (isNaN(port)) {
      console.error("Invalid port number");
      process.exit(1);
    }
    i++;
  } else if (args[i] === "--host" || args[i] === "--bind") {
    host = args[i + 1] || null;
    i++;
  } else if (args[i] === "--no-https") {
    useHttps = false;
  } else if (args[i] === "--local-cert") {
    forceMkcert = true;
  } else if (args[i] === "--no-update" || args[i] === "--skip-update") {
    skipUpdate = true;
  } else if (args[i] === "--dev") {
    // Already handled above for CLAGENTIC_HOME, just skip
  } else if (args[i] === "--watch" || args[i] === "-w") {
    watchMode = true;
  } else if (args[i] === "--debug") {
    debugMode = true;
  } else if (args[i] === "-y" || args[i] === "--yes") {
    autoYes = true;
  } else if (args[i] === "--pin") {
    cliPin = args[i + 1] || null;
    i++;
  } else if (args[i] === "--shutdown") {
    shutdownMode = true;
  } else if (args[i] === "--restart") {
    restartMode = true;
  } else if (args[i] === "--no-restart") {
    noRestart = true;
  } else if (args[i] === "--add") {
    addPath = args[i + 1] || ".";
    i++;
  } else if (args[i] === "--remove") {
    removePath = args[i + 1] || null;
    i++;
  } else if (args[i] === "--list") {
    listMode = true;
  } else if (args[i] === "--headless") {
    headlessMode = true;
    autoYes = true;
  } else if (args[i] === "--dangerously-skip-permissions") {
    dangerouslySkipPermissions = true;
  } else if (args[i] === "--multi-user") {
    multiUserMode = true;
  } else if (args[i] === "--os-users") {
    osUsersMode = true;
  } else if (args[i] === "-h" || args[i] === "--help") {
  console.log("Usage: clagentic-console [-p|--port <port>] [--host <address>] [--no-https] [--no-update] [--debug] [-y|--yes] [--pin <pin>] [--shutdown] [--restart] [--no-restart]");
  console.log("       clagentic-console --add <path>     Add a project to the running daemon");
  console.log("       clagentic-console --remove <path>  Remove a project from the running daemon");
  console.log("       clagentic-console --list            List registered projects");
  console.log("       clagentic-console release list-betas  List promotable beta versions (maintainer/release-engineering)");
    console.log("");
    console.log("Options:");
    console.log("  -p, --port <port>  Port to listen on (default: 2633)");
    console.log("  --host <address>   Address to bind to (default: 0.0.0.0)");
    console.log("  --no-https         Disable HTTPS (enabled by default)");
    console.log("  --local-cert       Use local certificate (mkcert), suppress migration notice");
    console.log("  --no-update        Skip auto-update check on startup");
    console.log("  --debug            Enable debug panel in the web UI");
    console.log("  -y, --yes          Skip interactive prompts (accept defaults)");
    console.log("  --pin <pin>        Set 6-digit PIN (use with --yes)");
    console.log("  --shutdown         Shut down the running relay daemon");
    console.log("  --restart          Restart the running relay daemon");
    console.log("  --no-restart       Do not auto-restart on crash (useful for debugging crash state)");
    console.log("  --add <path>       Add a project directory (use '.' for current)");
    console.log("  --remove <path>    Remove a project directory");
    console.log("  --list             List all registered projects");
    console.log("  --headless         Start daemon and exit immediately (implies --yes)");
    console.log("  --multi-user       Start in multi-user mode (use with --yes for headless)");
    console.log("  --os-users         Enable OS-level user isolation (Linux, requires root + --multi-user)");
    console.log("  --dangerously-skip-permissions");
    console.log("                     Bypass all permission prompts");
    process.exit(0);
  }
}

// Dev mode implies debug + skip update
if (_isDev) {
  debugMode = true;
  skipUpdate = true;
}

// --- Handle --shutdown before anything else ---
if (shutdownMode) {
  handleShutdown();
  return;
}

// --- Handle --restart before anything else ---
if (restartMode) {
  handleRestart();
  return;
}

// --- Handle --add before anything else ---
if (addPath !== null) {
  handleAdd(addPath);
  return;
}

// --- Handle --remove before anything else ---
if (removePath !== null) {
  handleRemove(removePath);
  return;
}

// --- Handle --list before anything else ---
if (listMode) {
  handleList();
  return;
}

// --multi-user / --os-users are now handled in the main entry flow (setup wizard or repeat run)
// Flags are parsed above and applied during forkDaemon()

var cwd = process.cwd();

/**
 * cliOpts bundles the parsed CLI flags that lib/cli/daemon-launch.js and
 * lib/cli/menus.js need but no longer own (arg parsing stays here).
 */
function currentCliOpts() {
  return {
    port: port,
    host: host,
    useHttps: useHttps,
    forceMkcert: forceMkcert,
    debugMode: debugMode,
    headlessMode: headlessMode,
    dangerouslySkipPermissions: dangerouslySkipPermissions,
    osUsersMode: osUsersMode,
    cliPin: cliPin,
    watchMode: watchMode,
    noRestart: noRestart,
    cwd: cwd,
  };
}

// Wire lib/cli/daemon-launch.js's crash-recovery path and lib/cli/menus.js's
// "re-run setup wizard" re-fork to the CLI's parsed flags (--no-restart,
// --debug, --no-https, --local-cert, --port, ...) without those modules
// owning arg parsing. daemon-launch.js exposes this bundle back out via
// getCliOpts() for menus.js to read.
setDaemonWatcherOpts(currentCliOpts());

// ==============================
// Main entry: daemon alive?
// ==============================
var { checkAndUpdate } = require("../lib/updater");
var currentVersion = require("../package.json").version;

(async function () {
  // Read update channel from saved config (best-effort — may not exist yet on first run)
  var _startupConfig = null;
  try { _startupConfig = loadConfig(); } catch (e) {}
  var _updateChannel = (_startupConfig && _startupConfig.updateChannel) || (currentVersion.includes("-") ? "beta" : "stable");
  var updated = await checkAndUpdate(currentVersion, skipUpdate, _updateChannel);
  if (updated) return;

  // Dev mode — foreground daemon with file watching
  if (_isDev) {
    var devConfig = loadConfig();
    var devAlive = devConfig ? await isDaemonAliveAsync(devConfig) : false;
    if (devAlive) {
      console.log("\x1b[38;2;0;183;133m[dev]\x1b[0m Shutting down existing daemon...");
      await sendIPCCommand(socketPath(), { cmd: "shutdown" });
      clearStaleConfig();
      await new Promise(function (resolve) { setTimeout(resolve, 500); });
    }
    // No running daemon — clear config so setup runs fresh
    if (!devAlive && devConfig) {
      if (devConfig.pid) clearStaleConfig();
      devConfig = null;
    }
    // No config — go through setup (disclaimer, port, mode, etc.)
    if (!devConfig) {
      setup(function (mode, keepAwake, wantOsUsers, chosenPort) {
        port = chosenPort;
        devMode(mode, keepAwake, null, wantOsUsers, currentCliOpts());
      }, port, { host: host, dangerouslySkipPermissions: dangerouslySkipPermissions });
    } else {
      // Reuse existing config (repeat run)
      await devMode(devConfig.mode || "single", devConfig.keepAwake || false, devConfig.pinHash || null, devConfig.osUsers || false, currentCliOpts());
    }
    return;
  }

  var config = loadConfig();
  var alive = config ? await isDaemonAliveAsync(config) : false;

  if (!alive && config && config.pid) {
    // Stale config
    clearStaleConfig();
    config = null;
  }

  if (alive) {
    // Headless mode — daemon already running, just report and exit
    if (headlessMode) {
      var protocol = config.tls ? "https" : "http";
      var ip = getLocalIP();
      var url = protocol + "://" + ip + ":" + config.port;
      console.log("  " + sym.done + "  Daemon already running (PID " + config.pid + ")");
      console.log("  " + sym.done + "  " + url);
      process.exit(0);
      return;
    }

    // Daemon is running — auto-add cwd if needed, then show menu
    var ip = getLocalIP();

    var status = await sendIPCCommand(socketPath(), { cmd: "get_status" });
    if (!status.ok) {
      log(a.red + "Daemon not responding" + a.reset);
      clearStaleConfig();
      process.exit(1);
      return;
    }

    // Check if cwd needs to be added
    var projs = status.projects || [];
    var cwdRegistered = false;
    for (var j = 0; j < projs.length; j++) {
      if (projs[j].path === cwd) {
        cwdRegistered = true;
        break;
      }
    }

    if (!cwdRegistered) {
      var slug = path.basename(cwd).toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "project";
      var { printLogo, promptSelect } = require("../lib/cli/tui");
      console.clear();
      printLogo();
      log("");
      log(sym.pointer + "  " + a.bold + "Add this project?" + a.reset);
      log(sym.bar);
      log(sym.bar + "  " + a.dim + cwd + a.reset);
      log(sym.bar);
      promptSelect("Add " + a.green + slug + a.reset + " to relay?", [
        { label: "Yes", value: "yes" },
        { label: "No", value: "no" },
      ], function (answer) {
        if (answer === "yes") {
          sendIPCCommand(socketPath(), { cmd: "add_project", path: cwd }).then(function (res) {
            if (res.ok) {
              config = loadConfig() || config;
              log(sym.done + "  " + a.green + "Added: " + (res.slug || slug) + a.reset);
            }
            log("");
            showMainMenu(config || { pid: status.pid, port: status.port, tls: status.tls }, ip);
          });
        } else {
          showMainMenu(config || { pid: status.pid, port: status.port, tls: status.tls }, ip);
        }
      });
    } else {
      showMainMenu(config || { pid: status.pid, port: status.port, tls: status.tls }, ip);
    }
  } else {
    // No daemon running — check for saved config (repeat run)
    var savedConfig = loadConfig();
    var isRepeatRun = savedConfig && savedConfig.setupCompleted;

    // --multi-user / --os-users CLI flags set config directly for headless/scripted usage
    if (multiUserMode) {
      if (!savedConfig) savedConfig = {};
      savedConfig.mode = "multi";
      savedConfig.setupCompleted = true;
    }
    if (osUsersMode) {
      if (!savedConfig) savedConfig = {};
      savedConfig.osUsers = true;
      savedConfig.mode = "multi";
      savedConfig.setupCompleted = true;
    }
    isRepeatRun = savedConfig && savedConfig.setupCompleted;

    if (isRepeatRun || autoYes) {
      // Repeat run or --yes: skip wizard, reuse saved config
      var savedMode = (savedConfig && savedConfig.mode) || "single";
      var savedKeepAwake = (savedConfig && savedConfig.keepAwake) || false;
      var savedOsUsers = (savedConfig && savedConfig.osUsers) || false;

      // os-users requires root
      if (savedOsUsers && typeof process.getuid === "function" && process.getuid() !== 0) {
        console.error(a.red + "OS user isolation requires root." + a.reset);
        console.error("Run:  " + a.bold + "sudo npx @clagentic/console" + a.reset);
        process.exit(1);
        return;
      }

      // os-users requires setfacl (ACL package)
      if (savedOsUsers && process.platform === "linux") {
        var { checkAclSupport } = require("../lib/os-users");
        var aclCheck = checkAclSupport();
        if (!aclCheck.available) {
          console.error(a.red + "OS user isolation requires the 'acl' package (setfacl)." + a.reset);
          console.error("");
          console.error("Install it:  " + a.bold + aclCheck.installCmd + a.reset);
          console.error("");
          console.error("Then restart Clagentic: Console.");
          process.exit(1);
          return;
        }
      }

      if (savedConfig && savedConfig.port) port = savedConfig.port;
      if (savedConfig && savedConfig.host) host = savedConfig.host;
      if (savedConfig && savedConfig.dangerouslySkipPermissions) dangerouslySkipPermissions = true;
      // Re-sync: port/host/dangerouslySkipPermissions above may have just
      // changed after the initial setDaemonWatcherOpts() call at module
      // load — keep the crash-watcher/getCliOpts() snapshot current so a
      // later crash-restart or "re-run setup" re-fork doesn't use stale values.
      setDaemonWatcherOpts(currentCliOpts());

      if (autoYes) {
        console.log("  " + sym.done + "  Auto-accepted disclaimer");
        console.log("  " + sym.done + "  Mode: " + savedMode);
        if (dangerouslySkipPermissions) {
          console.log("  " + sym.warn + "  " + a.yellow + "Skip permissions mode enabled" + a.reset);
        }
      }

      var autoRc = loadClayrc();
      var autoRestorable = (autoRc.recentProjects || []).filter(function (p) {
        return p.path !== cwd && fs.existsSync(p.path);
      });
      if (autoRestorable.length > 0 && autoYes) {
        console.log("  " + sym.done + "  Restoring " + autoRestorable.length + " previous project(s)");
      }
      // Add cwd if it has history in .clagentic-rc, or if there are no other projects to restore
      var cwdInRc = (autoRc.recentProjects || []).some(function (p) {
        return p.path === cwd;
      });
      var addCwd = cwdInRc || autoRestorable.length === 0;
      await forkDaemon(savedMode, savedKeepAwake, autoRestorable.length > 0 ? autoRestorable : undefined, addCwd, savedOsUsers, currentCliOpts());
    } else {
      // First run: interactive wizard
      setup(function (mode, keepAwake, wantOsUsers, chosenPort) {
        port = chosenPort;
        // Keep the crash-watcher/getCliOpts() snapshot current now that the
        // wizard has chosen a port (see the analogous re-sync above).
        setDaemonWatcherOpts(currentCliOpts());
        // Check ~/.clagentic-rc for previous projects to restore
        var rc = loadClayrc();
        var restorable = (rc.recentProjects || []).filter(function (p) {
          return p.path !== cwd && fs.existsSync(p.path);
        });

        if (restorable.length > 0) {
          promptRestoreProjects(restorable, function (selected) {
            forkDaemon(mode, keepAwake, selected, false, wantOsUsers, currentCliOpts());
          });
        } else {
          log(sym.bar);
          log(sym.end + "  " + a.dim + "Starting relay..." + a.reset);
          log("");
          forkDaemon(mode, keepAwake, undefined, true, wantOsUsers, currentCliOpts());
        }
      }, port, { host: host, dangerouslySkipPermissions: dangerouslySkipPermissions });
    }
  }
})();

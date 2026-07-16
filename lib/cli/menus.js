// lib/cli/menus.js
//
// Interactive CLI menus for bin/cli.js: first-run setup wizard, project
// restore prompt, and the main/settings management menus shown once the
// daemon is up. Extracted verbatim from bin/cli.js (lr-4e49 Part 1), no
// behavior change.
//
// This module and lib/cli/daemon-launch.js reference each other's exports
// (menu actions re-fork/restart the daemon; daemon-launch shows the menu
// after a successful (re)start). Both requires are done lazily inside
// functions to avoid a load-time circular-require ordering issue.

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var qrcode = require("qrcode-terminal");

var {
  loadConfig, saveConfig, socketPath, logPath, clearStaleConfig,
  loadClayrc, saveClayrc, REAL_HOME,
} = require("../config");
var { sendIPCCommand } = require("../ipc");
var { hasAdmin, getSetupCode, hashPin } = require("../users");
var {
  log, sym, a, printLogo,
  promptToggle, promptText, promptSelect, promptMultiSelect,
} = require("./tui");
var { getLocalIP, isPortFree } = require("./net-detect");

// ==============================
// Restore projects from ~/.clagentic-rc
// ==============================
function promptRestoreProjects(projects, callback) {
  log(sym.bar);
  log(sym.pointer + "  " + a.bold + "Previous projects found" + a.reset);
  log(sym.bar + "  " + a.dim + "Restore projects from your last session?" + a.reset);
  log(sym.bar);

  var items = projects.map(function (p) {
    var name = p.title || path.basename(p.path);
    return {
      label: a.bold + name + a.reset + "  " + a.dim + p.path + a.reset,
      value: p,
      checked: true,
    };
  });

  promptMultiSelect("Restore projects", items, function (selected) {
    // Remove unselected projects from ~/.clagentic-rc
    if (selected.length < projects.length) {
      var selectedPaths = {};
      for (var si = 0; si < selected.length; si++) {
        selectedPaths[selected[si].path] = true;
      }
      try {
        var rc = loadClayrc();
        rc.recentProjects = (rc.recentProjects || []).filter(function (p) {
          return selectedPaths[p.path];
        });
        saveClayrc(rc);
      } catch (e) {}
    }

    log(sym.bar);
    if (selected.length > 0) {
      log(sym.done + "  " + a.green + "Restoring " + selected.length + (selected.length === 1 ? " project" : " projects") + a.reset);
    } else {
      log(sym.done + "  " + a.dim + "Starting fresh" + a.reset);
    }
    log(sym.end + "  " + a.dim + "Starting relay..." + a.reset);
    log("");
    callback(selected);
  });
}

// ==============================
// First-run setup (no daemon)
// ==============================
/**
 * `defaultPort` seeds the port prompt (mirrors the CLI's --port / default
 * value). `cliOpts`: { host, dangerouslySkipPermissions } — preserved onto
 * the config when OS-user isolation is requested without root, mirroring
 * the original bin/cli.js behavior of reading those from parsed CLI flags.
 */
function setup(callback, defaultPort, cliOpts) {
  cliOpts = cliOpts || {};
  var port = defaultPort;
  console.clear();
  printLogo();
  log("");
  log(sym.pointer + "  " + a.bold + "Clagentic: Console" + a.reset + a.dim + "  ·  Unofficial, open-source project" + a.reset);
  log(sym.bar);
  log(sym.bar + "  " + a.yellow + sym.warn + " Disclaimer" + a.reset);
  log(sym.bar);
  log(sym.bar + "  " + a.dim + "This is an independent project and is not affiliated with Anthropic." + a.reset);
  log(sym.bar + "  " + a.dim + "Claude is a trademark of Anthropic." + a.reset);
  log(sym.bar);
  log(sym.bar + "  " + a.dim + "Clagentic: Console is provided \"as is\" without warranty of any kind. Users are" + a.reset);
  log(sym.bar + "  " + a.dim + "responsible for complying with the terms of service of underlying AI" + a.reset);
  log(sym.bar + "  " + a.dim + "providers (e.g., Anthropic, OpenAI) and all applicable terms of any" + a.reset);
  log(sym.bar + "  " + a.dim + "third-party services." + a.reset);
  log(sym.bar);
  log(sym.bar + "  " + a.dim + "Features such as multi-user mode are experimental and may involve" + a.reset);
  log(sym.bar + "  " + a.dim + "sharing access to API-based services. Before enabling such features," + a.reset);
  log(sym.bar + "  " + a.dim + "review your provider's usage policies regarding account sharing," + a.reset);
  log(sym.bar + "  " + a.dim + "acceptable use, and any applicable rate limits or restrictions." + a.reset);
  log(sym.bar);
  log(sym.bar + "  " + a.dim + "The authors assume no liability for misuse or violations arising" + a.reset);
  log(sym.bar + "  " + a.dim + "from the use of this software." + a.reset);
  log(sym.bar);
  log(sym.bar + "  Type " + a.bold + "agree" + a.reset + " to accept and continue.");
  log(sym.bar);

  promptText("", "", function (val) {
    if (!val || val.trim().toLowerCase() !== "agree") {
      log(sym.end + "  " + a.dim + "Aborted." + a.reset);
      log("");
      process.exit(0);
      return;
    }
    log(sym.bar);

    function askPort() {
      promptText("Port", String(port), function (val) {
        if (val === null) {
          log(sym.end + "  " + a.dim + "Aborted." + a.reset);
          log("");
          process.exit(0);
          return;
        }
        var p = parseInt(val, 10);
        if (!p || p < 1 || p > 65535) {
          log(sym.warn + "  " + a.red + "Invalid port number" + a.reset);
          askPort();
          return;
        }
        isPortFree(p).then(function (free) {
          if (!free) {
            log(sym.warn + "  " + a.yellow + "Port " + p + " is already in use" + a.reset);
            askPort();
            return;
          }
          port = p;
          log(sym.bar);
          // Single-user mode removed (lr-bd9f). All new installs are multi-user.
          // Existing single-user installs continue to work until the full removal
          // lands — see task lr-bd9f-redux.
          askOsUsers("multi");
        });
      });
    }

    function askOsUsers(mode) {
      // Only offer OS user isolation on Linux
      if (process.platform !== "linux") {
        finishSetup(mode, false);
        return;
      }
      log(sym.bar);
      promptSelect("Enable OS-level user isolation?", [
        { label: "Yes", value: "yes" },
        { label: "No", value: "no" },
      ], function (choice) {
        if (choice !== "yes") {
          finishSetup(mode, false);
          return;
        }
        log(sym.bar);
        log(sym.bar + "  " + a.yellow + sym.warn + " OS-Level User Isolation" + a.reset);
        log(sym.bar);
        log(sym.bar + "  " + a.dim + "This feature maps each Clagentic: Console user to a Linux OS user account." + a.reset);
        log(sym.bar + "  " + a.dim + "The daemon must run as root and will spawn processes (SDK workers," + a.reset);
        log(sym.bar + "  " + a.dim + "terminals, file operations) as the mapped Linux user." + a.reset);
        log(sym.bar);
        log(sym.bar + "  " + a.dim + "What this means:" + a.reset);
        log(sym.bar + "  " + a.dim + "- Each mapped user uses their own ~/.claude/ credentials" + a.reset);
        log(sym.bar + "  " + a.dim + "- Terminals and file access follow Linux permissions" + a.reset);
        log(sym.bar + "  " + a.dim + "- Linux user accounts are created automatically (clay-username)" + a.reset);
        log(sym.bar);
        log(sym.bar + "  " + a.dim + "Recommended: Run on a dedicated Clagentic: Console server or cloud instance," + a.reset);
        log(sym.bar + "  " + a.dim + "not on a personal computer or general-purpose server." + a.reset);
        log(sym.bar);
        promptSelect("Confirm", [
          { label: "Enable OS-level user isolation", value: "confirm" },
          { label: "Cancel", value: "cancel" },
        ], function (confirmChoice) {
          if (confirmChoice !== "confirm") {
            finishSetup(mode, false);
            return;
          }
          var isRoot = typeof process.getuid === "function" && process.getuid() === 0;
          if (!isRoot) {
            // Merge into existing config (preserve projects, TLS, etc.)
            var existingCfg = loadConfig() || {};
            existingCfg.port = port;
            existingCfg.host = cliOpts.host;
            existingCfg.mode = "multi";
            existingCfg.osUsers = true;
            existingCfg.setupCompleted = true;
            if (cliOpts.dangerouslySkipPermissions) existingCfg.dangerouslySkipPermissions = true;
            saveConfig(existingCfg);
            log(sym.bar);
            log(sym.warn + "  " + a.yellow + "OS user isolation requires root." + a.reset);
            log(sym.bar + "  Run:");
            log(sym.bar + "    " + a.bold + "sudo npx @clagentic/console" + a.reset);
            log(sym.end);
            log("");
            process.exit(0);
            return;
          }
          finishSetup(mode, true);
        });
      });
    }

    function finishSetup(mode, wantOsUsers) {
      if (process.platform === "darwin") {
        log(sym.bar);
        promptToggle("Keep awake", "Prevent system sleep while relay is running", false, function (keepAwake) {
          callback(mode, keepAwake, wantOsUsers, port);
        });
      } else {
        callback(mode, false, wantOsUsers, port);
      }
    }

    askPort();
  });
}

// ==============================
// Show server started info
// ==============================
function showServerStarted(config, ip, setupCode) {
  showMainMenu(config, ip, setupCode);
}

// ==============================
// Main management menu
// ==============================
function showMainMenu(config, ip, setupCode) {
  var { startDaemonWatcher } = require("./daemon-launch");
  startDaemonWatcher();
  var protocol = config.tls ? "https" : "http";
  var url = protocol + "://" + ip + ":" + config.port;
  var currentVersion = require("../../package.json").version;

  sendIPCCommand(socketPath(), { cmd: "get_status" }).then(function (status) {
    var projs = (status && status.projects) || [];
    var totalSessions = 0;
    var totalAwaiting = 0;
    for (var i = 0; i < projs.length; i++) {
      totalSessions += projs[i].sessions || 0;
      if (projs[i].isProcessing) totalAwaiting++;
    }

    console.clear();
    printLogo();
    log("");

    function afterQr() {
      // Status line
      log("  " + a.dim + "Clagentic: Console" + a.reset + " " + a.dim + "v" + currentVersion + a.reset + a.dim + " — " + url + a.reset);
      var parts = [];
      parts.push(a.bold + projs.length + a.reset + a.dim + (projs.length === 1 ? " project" : " projects"));
      parts.push(a.reset + a.bold + totalSessions + a.reset + a.dim + (totalSessions === 1 ? " session" : " sessions"));
      if (totalAwaiting > 0) {
        parts.push(a.reset + a.yellow + a.bold + totalAwaiting + a.reset + a.yellow + " awaiting" + a.reset + a.dim);
      }
      log("  " + a.dim + parts.join(a.reset + a.dim + " · ") + a.reset);
      log("  " + a.dim + "~/.clagentic → " + path.join(REAL_HOME, ".clagentic") + a.reset);
      log("  Press " + a.bold + "o" + a.reset + " to open in browser");
      log("");

      showMenuItems();
    }

    if (ip !== "localhost") {
      qrcode.generate(url, { small: !require("./tui").isBasicTerm }, function (code) {
        var lines = code.split("\n").map(function (l) { return "  " + l; }).join("\n");
        console.log(lines);
        afterQr();
      });
    } else {
      log(a.bold + "  " + url + a.reset);
      log("");
      afterQr();
    }

    function showMenuItems() {
      var items = [
        { label: "Settings", value: "settings" },
        { label: "Shut down server", value: "shutdown" },
        { label: "Keep server alive & exit", value: "exit" },
      ];

      promptSelect("What would you like to do?", items, function (choice) {
        switch (choice) {
          case "settings":
            showSettingsMenu(config, ip);
            break;

          case "shutdown":
            log(sym.bar);
            log(sym.bar + "  " + a.yellow + "This will stop the server completely." + a.reset);
            log(sym.bar + "  " + a.dim + "All connected sessions will be disconnected." + a.reset);
            log(sym.bar);
            promptSelect("Are you sure?", [
              { label: "Cancel", value: "cancel" },
              { label: "Shut down", value: "confirm" },
            ], function (confirm) {
              if (confirm === "confirm") {
                var { stopDaemonWatcher } = require("./daemon-launch");
                stopDaemonWatcher();
                sendIPCCommand(socketPath(), { cmd: "shutdown" }).then(function () {
                  log(sym.done + "  " + a.green + "Server stopped." + a.reset);
                  log("");
                  clearStaleConfig();
                  process.exit(0);
                });
              } else {
                showMainMenu(config, ip);
              }
            });
            break;

          case "exit":
            log("");
            log("  " + a.bold + "Bye!" + a.reset + "  " + a.dim + "Server is still running in background." + a.reset);
            log("  " + a.dim + "Run " + a.reset + "npx @clagentic/console" + a.dim + " to come back here." + a.reset);
            log("");
            process.exit(0);
            break;
        }
      }, {
        hint: [
          "Run npx @clagentic/console in other directories to add more projects.",        ],
        keys: [
          { key: "o", onKey: function () {
            openUrl(url);
            showMainMenu(config, ip);
          }},
          { key: "s", onKey: function () {
            openUrl("https://github.com/clagentic/clagentic-console");
            showMainMenu(config, ip);
          }},
        ],
      });
    }
  });
}

/**
 * Open a URL in the platform default browser (best-effort, ignores errors).
 * Used by the "o" / "s" hotkeys in showMainMenu.
 */
function openUrl(url) {
  var spawn = require("child_process").spawn;
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true, windowsHide: true }).unref();
    } else {
      var cmd = process.platform === "darwin" ? "open" : "xdg-open";
      spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch (e) {}
}

// ==============================
// Settings sub-menu
// ==============================
function showSettingsMenu(config, ip) {
  var cwd = process.cwd();
  sendIPCCommand(socketPath(), { cmd: "get_status" }).then(function (status) {
    var isAwake = status && status.keepAwake;
    var isOsUsers = status && status.osUsers;

    console.clear();
    printLogo();
    log("");
    log(sym.pointer + "  " + a.bold + "Settings" + a.reset);
    log(sym.bar);

    // Detect current state
    var tlsStatus = config.tls
      ? a.green + "Enabled" + a.reset
      : a.dim + "Disabled" + a.reset;
    var pinStatus = config.pinHash
      ? a.green + "Enabled" + a.reset
      : a.dim + "Off" + a.reset;
    var awakeStatus = isAwake
      ? a.green + "On" + a.reset
      : a.dim + "Off" + a.reset;

    log(sym.bar + "  HTTPS        " + tlsStatus);

    // Multi-user mode is always on (single-user mode was removed, lr-ec2d).
    log(sym.bar + "  Mode         " + a.indigo + "Multi-user" + a.reset);
    log(sym.bar + "  PIN          " + pinStatus);
    var osUsersStatus = isOsUsers
      ? a.green + "Enabled" + a.reset
      : a.dim + "Off" + a.reset;
    log(sym.bar + "  OS users     " + osUsersStatus);
    if (process.platform === "darwin") {
      log(sym.bar + "  Keep awake   " + awakeStatus);
    }
    log(sym.bar);

    // Build items
    var items = [];

    if (isOsUsers) {
      items.push({ label: "Disable OS-level user isolation", value: "disable_os_users" });
    } else {
      items.push({ label: "Enable OS-level user isolation", value: "os_users" });
    }
    items.push({ label: "Show setup code", value: "show_setup_code" });
    if (hasAdmin()) {
      items.push({ label: "Recover admin password", value: "recover_admin" });
    }
    if (process.platform === "darwin") {
      items.push({ label: isAwake ? "Disable keep awake" : "Enable keep awake", value: "awake" });
    }
    items.push({ label: "View logs", value: "logs" });
    items.push({ label: "Re-run setup wizard", value: "rerun_setup" });
    items.push({ label: "Back", value: "back" });

  promptSelect("Select", items, function (choice) {
    switch (choice) {
      case "pin": {
        var { promptPin } = require("./tui");
        log(sym.bar);
        promptPin(function (pin) {
          if (pin) {
            var hash = hashPin(pin);
            sendIPCCommand(socketPath(), { cmd: "set_pin", pinHash: hash }).then(function () {
              config.pinHash = hash;
              log(sym.done + "  " + a.green + "PIN updated" + a.reset);
              log("");
              showSettingsMenu(config, ip);
            });
          } else {
            showSettingsMenu(config, ip);
          }
        });
        break;
      }

      case "remove_pin":
        sendIPCCommand(socketPath(), { cmd: "set_pin", pinHash: null }).then(function () {
          config.pinHash = null;
          log(sym.done + "  " + a.dim + "PIN removed" + a.reset);
          log("");
          showSettingsMenu(config, ip);
        });
        break;

      case "os_users":
        if (process.platform === "win32") {
          log(sym.bar);
          log(sym.bar + "  " + a.red + "OS-level user isolation is not supported on Windows." + a.reset);
          log(sym.bar);
          promptSelect("Back?", [{ label: "Back", value: "back" }], function () {
            showSettingsMenu(config, ip);
          });
          break;
        }
        if (process.getuid() !== 0) {
          log(sym.bar);
          log(sym.bar + "  " + a.red + sym.warn + " OS user isolation requires root." + a.reset);
          log(sym.bar + "  " + a.dim + "Shut down this server, then restart with:" + a.reset);
          log(sym.bar + "    " + a.bold + "sudo npx @clagentic/console" + a.reset);
          log(sym.bar);
          promptSelect("Back?", [{ label: "Back", value: "back" }], function () {
            showSettingsMenu(config, ip);
          });
          break;
        }
        if (process.platform !== "linux") {
          log(sym.bar);
          log(sym.bar + "  " + a.red + sym.warn + " OS-level user isolation requires Linux." + a.reset);
          log(sym.bar + "  " + a.dim + "This feature depends on setfacl, getent, and uid/gid process spawning." + a.reset);
          log(sym.bar + "  " + a.dim + "Use Docker or a Linux VM to run Clagentic: Console with OS user isolation." + a.reset);
          log(sym.bar);
          showSettingsMenu(config, ip);
          return;
        }
        log(sym.bar);
        log(sym.bar + "  " + a.yellow + sym.warn + " OS-Level User Isolation" + a.reset);
        log(sym.bar);
        log(sym.bar + "  " + a.dim + "This feature maps each Clagentic: Console user to a Linux OS user account." + a.reset);
        log(sym.bar + "  " + a.dim + "The daemon must run as root and will spawn processes (SDK workers," + a.reset);
        log(sym.bar + "  " + a.dim + "terminals, file operations) as the mapped Linux user." + a.reset);
        log(sym.bar);
        log(sym.bar + "  " + a.dim + "What this means:" + a.reset);
        log(sym.bar + "  " + a.dim + "- Each mapped user uses their own ~/.claude/ credentials" + a.reset);
        log(sym.bar + "  " + a.dim + "- Terminals and file access follow Linux permissions" + a.reset);
        log(sym.bar + "  " + a.dim + "- Linux user accounts are created automatically (clay-username)" + a.reset);
        log(sym.bar);
        log(sym.bar + "  " + a.dim + "Recommended: Run on a dedicated Clagentic: Console server or cloud instance," + a.reset);
        log(sym.bar + "  " + a.dim + "not on a personal computer or general-purpose server." + a.reset);
        log(sym.bar);
        promptSelect("Select", [
          { label: "Enable OS-level user isolation", value: "confirm" },
          { label: "Cancel", value: "cancel" },
        ], function (confirmChoice) {
          if (confirmChoice === "confirm") {
            sendIPCCommand(socketPath(), { cmd: "set_os_users", value: true }).then(function (res) {
              if (res.error === "acl_not_installed") {
                log(sym.bar);
                log(sym.bar + "  " + a.red + sym.warn + " setfacl is not installed." + a.reset);
                log(sym.bar);
                log(sym.bar + "  OS user isolation requires the ACL (Access Control List) package");
                log(sym.bar + "  to manage per-user file permissions on shared projects.");
                log(sym.bar);
                log(sym.bar + "  " + a.bold + "Install it:" + a.reset);
                log(sym.bar + "  " + a.cyan + res.installCmd + a.reset);
                log(sym.bar);
                log(sym.bar + "  " + a.dim + "Then try enabling OS user isolation again." + a.reset);
                log(sym.bar);
                showSettingsMenu(config, ip);
                return;
              } else if (res.error) {
                log(sym.bar);
                log(sym.bar + "  " + a.red + sym.warn + " Failed to enable OS users: " + res.error + a.reset);
                log(sym.bar);
                showSettingsMenu(config, ip);
                return;
              } else if (!res.ok) {
                log(sym.bar);
                log(sym.bar + "  " + a.red + sym.warn + " Unexpected response from daemon." + a.reset);
                log(sym.bar + "  " + a.dim + JSON.stringify(res) + a.reset);
                log(sym.bar);
                showSettingsMenu(config, ip);
                return;
              }
              // Daemon saved the flag. Now provision from CLI with live progress.
              config.osUsers = true;
              log(sym.bar);
              log(sym.done + "  " + a.green + "OS-level user isolation enabled." + a.reset);
              log(sym.bar);

              // Provision Linux accounts from CLI (we have root + terminal)
              var osUsersLib = require("../os-users");
              var usersLib = require("../users");

              try { osUsersLib.ensureProjectsDir(); } catch (e) {
                log(sym.bar + "  " + a.yellow + sym.warn + " Failed to create projects dir: " + e.message + a.reset);
              }

              var allUsers = usersLib.getAllUsers();
              if (allUsers.length === 0) {
                log(sym.bar + "  " + a.dim + "No users to provision yet. Accounts will be created when users register." + a.reset);
              } else {
                log(sym.bar + "  " + a.dim + "Provisioning " + allUsers.length + " user(s)..." + a.reset);
                for (var ui = 0; ui < allUsers.length; ui++) {
                  var usr = allUsers[ui];
                  if (usr.linuxUser && osUsersLib.linuxUserExists(usr.linuxUser)) {
                    log(sym.bar + "    " + a.dim + sym.done + " " + usr.username + " -> " + usr.linuxUser + " (exists)" + a.reset);
                    continue;
                  }
                  log(sym.bar + "    " + a.dim + "Creating Linux account for " + usr.username + "..." + a.reset);
                  var provision = osUsersLib.provisionLinuxUser(usr.username);
                  if (provision.ok) {
                    usersLib.updateLinuxUser(usr.id, provision.linuxUser);
                    log(sym.bar + "    " + a.green + sym.done + " " + usr.username + " -> " + provision.linuxUser + a.reset);
                  } else {
                    log(sym.bar + "    " + a.red + sym.warn + " " + usr.username + ": " + (provision.error || "unknown error") + a.reset);
                  }
                }
              }

              // Set up ACLs for existing projects
              var cfg = loadConfig() || {};
              var cfgProjects = cfg.projects || [];
              if (cfgProjects.length > 0) {
                log(sym.bar);
                log(sym.bar + "  " + a.dim + "Setting ACLs for " + cfgProjects.length + " project(s)..." + a.reset);
                for (var pi = 0; pi < cfgProjects.length; pi++) {
                  var proj = cfgProjects[pi];
                  if (osUsersLib.isHomeDirectory(proj.path)) {
                    log(sym.bar + "    " + a.dim + "~ " + (proj.slug || proj.path) + " (home dir, skipped)" + a.reset);
                    continue;
                  }
                  try {
                    if (proj.visibility === "public") {
                      osUsersLib.grantAllUsersAccess(proj.path, usersLib);
                    }
                    if (proj.ownerId) {
                      var ownerUser = usersLib.findUserById(proj.ownerId);
                      if (ownerUser && ownerUser.linuxUser) {
                        osUsersLib.grantProjectAccess(proj.path, ownerUser.linuxUser);
                      }
                    }
                    log(sym.bar + "    " + a.dim + sym.done + " " + (proj.slug || proj.path) + a.reset);
                  } catch (aclErr) {
                    log(sym.bar + "    " + a.yellow + sym.warn + " " + (proj.slug || proj.path) + ": " + aclErr.message + a.reset);
                  }
                }
              }

              log(sym.bar);
              log(sym.bar + "  " + a.dim + "Restart the daemon for full effect." + a.reset);
              log(sym.bar);
              showSettingsMenu(config, ip);
            }).catch(function (err) {
              log(sym.bar);
              log(sym.bar + "  " + a.red + sym.warn + " IPC error: " + (err.message || err) + a.reset);
              log(sym.bar);
              showSettingsMenu(config, ip);
            });
          } else {
            showSettingsMenu(config, ip);
          }
        });
        break;

      case "disable_os_users":
        log(sym.bar);
        log(sym.bar + "  " + a.yellow + sym.warn + " Disable OS-level user isolation?" + a.reset);
        log(sym.bar);
        log(sym.bar + "  " + a.dim + "Processes will no longer be spawned as mapped Linux users." + a.reset);
        log(sym.bar + "  " + a.dim + "User mappings will be preserved and restored if re-enabled." + a.reset);
        log(sym.bar);
        promptSelect("Confirm", [
          { label: "Disable OS-level user isolation", value: "confirm" },
          { label: "Cancel", value: "cancel" },
        ], function (confirmChoice) {
          if (confirmChoice === "confirm") {
            sendIPCCommand(socketPath(), { cmd: "set_os_users", value: false }).then(function (res) {
              if (res.ok) {
                config.osUsers = false;
                log(sym.bar);
                log(sym.done + "  " + a.green + "OS-level user isolation disabled." + a.reset);
                log(sym.bar + "  " + a.dim + "Restart the daemon for changes to take full effect." + a.reset);
                log(sym.bar);
              }
              showSettingsMenu(config, ip);
            });
          } else {
            showSettingsMenu(config, ip);
          }
        });
        break;

      case "rerun_setup":
        log(sym.bar);
        log(sym.bar + "  " + a.yellow + sym.warn + " Re-run setup wizard?" + a.reset);
        log(sym.bar);
        log(sym.bar + "  " + a.dim + "This will shut down the running daemon, reset your setup" + a.reset);
        log(sym.bar + "  " + a.dim + "preferences (mode, port), and walk you through the wizard again." + a.reset);
        log(sym.bar + "  " + a.dim + "Your projects and user accounts will be preserved." + a.reset);
        log(sym.bar);
        promptSelect("Confirm", [
          { label: "Re-run setup wizard", value: "confirm" },
          { label: "Cancel", value: "cancel" },
        ], function (confirmChoice) {
          if (confirmChoice === "confirm") {
            var { forkDaemon, getCliOpts } = require("./daemon-launch");
            // Save old PID before clearing, so we can force-kill if needed
            var cfg = loadConfig() || {};
            var oldPid = cfg.pid;
            var oldPort = cfg.port || config.port;
            // Clear setupCompleted so setup() runs fresh
            delete cfg.setupCompleted;
            delete cfg.mode;
            cfg.pid = null;
            saveConfig(cfg);

            // Helper: wait for port to be free, force-kill if needed
            function waitForPortFree(cb) {
              var attempts = 0;
              var maxAttempts = 12; // 6 seconds total
              function check() {
                isPortFree(oldPort).then(function (free) {
                  if (free) return cb();
                  attempts++;
                  if (attempts >= maxAttempts) {
                    // Port still busy, force-kill old daemon
                    if (oldPid) {
                      try { process.kill(oldPid, "SIGKILL"); } catch (e) {}
                    }
                    // Wait a bit more after SIGKILL
                    setTimeout(function () {
                      isPortFree(oldPort).then(function (free2) {
                        if (!free2) {
                          log(sym.warn + "  " + a.yellow + "Port " + oldPort + " still in use. Kill the process manually:" + a.reset);
                          log(sym.bar + "    " + a.bold + "lsof -ti:" + oldPort + " | xargs kill -9" + a.reset);
                        }
                        cb();
                      });
                    }, 1000);
                    return;
                  }
                  setTimeout(check, 500);
                });
              }
              check();
            }

            // Helper: run setup wizard after daemon is dead
            function proceedWithSetup() {
              clearStaleConfig();
              setup(function (mode, keepAwake, wantOsUsers, chosenPort) {
                var rc = loadClayrc();
                var restorable = (rc.recentProjects || []).filter(function (p) {
                  return p.path !== cwd && fs.existsSync(p.path);
                });
                // Reuse the CLI's original flags (--no-https, --local-cert, etc.)
                // rather than assuming defaults — this is a re-fork, not a fresh
                // process, so bin/cli.js's parsed argv is the source of truth.
                var cliOpts = Object.assign({}, getCliOpts(), { port: chosenPort, cwd: cwd });
                if (restorable.length > 0) {
                  promptRestoreProjects(restorable, function (selected) {
                    forkDaemon(mode, keepAwake, selected, false, wantOsUsers, cliOpts);
                  });
                } else {
                  log(sym.bar);
                  log(sym.end + "  " + a.dim + "Starting relay..." + a.reset);
                  log("");
                  forkDaemon(mode, keepAwake, undefined, true, wantOsUsers, cliOpts);
                }
              }, oldPort);
            }

            // Shut down the daemon, then wait for port to be free
            sendIPCCommand(socketPath(), { cmd: "shutdown" }).then(function () {
              waitForPortFree(proceedWithSetup);
            }).catch(function () {
              // IPC failed, daemon may be unresponsive. Try SIGTERM, then wait.
              if (oldPid) {
                try { process.kill(oldPid, "SIGTERM"); } catch (e) {}
              }
              waitForPortFree(proceedWithSetup);
            });
          } else {
            showSettingsMenu(config, ip);
          }
        });
        break;

      case "show_setup_code":
        // getSetupCode() auto-generates if multi-user is on and no code exists
        var currentCode = getSetupCode();
        log(sym.bar);
        if (currentCode) {
          log(sym.bar + "  " + a.yellow + sym.warn + " Setup code:  " + a.bold + currentCode + a.reset);
          if (hasAdmin()) {
            log(sym.bar + "  " + a.dim + "Admin account exists. This code is for adding the next admin." + a.reset);
          } else {
            log(sym.bar + "  " + a.dim + "Enter this code in the browser to create the admin account." + a.reset);
          }
        } else {
          log(sym.bar + "  " + a.dim + "Multi-user mode is not enabled." + a.reset);
        }
        log(sym.bar);
        promptSelect("Back?", [{ label: "Back", value: "back" }], function () {
          showSettingsMenu(config, ip);
        });
        break;

      case "logs":
        console.clear();
        log(a.bold + "Daemon logs" + a.reset + " " + a.dim + "(" + logPath() + ")" + a.reset);
        log("");
        try {
          var logContent = fs.readFileSync(logPath(), "utf8");
          var logLines = logContent.split("\n").slice(-30);
          for (var li = 0; li < logLines.length; li++) {
            log(a.dim + logLines[li] + a.reset);
          }
        } catch (e) {
          log(a.dim + "(empty)" + a.reset);
        }
        log("");
        promptSelect("Back?", [{ label: "Back", value: "back" }], function () {
          showSettingsMenu(config, ip);
        });
        break;

      case "awake":
        sendIPCCommand(socketPath(), { cmd: "set_keep_awake", value: !isAwake }).then(function (res) {
          if (res.ok) {
            config.keepAwake = !isAwake;
          }
          showSettingsMenu(config, ip);
        });
        break;

      case "recover_admin": {
        var recoveryUrlPath = crypto.randomBytes(16).toString("hex");
        var recoveryPassword = crypto.randomBytes(8).toString("base64url");
        sendIPCCommand(socketPath(), { cmd: "enable_recovery", urlPath: recoveryUrlPath, password: recoveryPassword }).then(function (res) {
          if (!res.ok) {
            log(sym.bar + "  " + a.red + "Failed to enable recovery mode." + a.reset);
            log(sym.bar);
            showSettingsMenu(config, ip);
            return;
          }
          var protocol = config.tls ? "https" : "http";
          var recoveryUrl = config.builtinCert
            ? toClayStudioUrl(ip, config.port, protocol) + "/recover/" + recoveryUrlPath
            : protocol + "://" + ip + ":" + config.port + "/recover/" + recoveryUrlPath;
          log(sym.bar);
          log(sym.bar + "  " + a.yellow + sym.warn + " Admin Password Recovery" + a.reset);
          log(sym.bar);
          log(sym.bar + "  " + a.dim + "Recovery URL:" + a.reset);
          log(sym.bar + "  " + a.bold + recoveryUrl + a.reset);
          log(sym.bar);
          log(sym.bar + "  " + a.dim + "Recovery password:" + a.reset);
          log(sym.bar + "  " + a.bold + recoveryPassword + a.reset);
          log(sym.bar);
          log(sym.bar + "  " + a.dim + "Open the URL in a browser and enter the password above." + a.reset);
          log(sym.bar + "  " + a.dim + "This link is single-use and will expire when the PIN is reset." + a.reset);
          log(sym.bar);
          promptSelect("Done?", [
            { label: "Disable recovery link", value: "disable" },
            { label: "Back (keep link active)", value: "back" },
          ], function (rc) {
            if (rc === "disable") {
              sendIPCCommand(socketPath(), { cmd: "disable_recovery" }).then(function () {
                log(sym.done + "  " + a.dim + "Recovery link disabled." + a.reset);
                log("");
                showSettingsMenu(config, ip);
              });
            } else {
              showSettingsMenu(config, ip);
            }
          });
        });
        break;
      }

      case "back":
        showMainMenu(config, ip);
        break;
    }
  });
  });
}

module.exports = {
  promptRestoreProjects: promptRestoreProjects,
  setup: setup,
  showServerStarted: showServerStarted,
  showMainMenu: showMainMenu,
  showSettingsMenu: showSettingsMenu,
  openUrl: openUrl,
};

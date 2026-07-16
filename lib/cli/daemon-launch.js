// lib/cli/daemon-launch.js
//
// Daemon lifecycle for bin/cli.js: forking the daemon (fresh start + dev
// mode), restarting it (plain restart-from-config and restart-with-TLS), the
// daemon-liveness watcher, and crash-recovery/backoff. Extracted verbatim
// from bin/cli.js (lr-4e49 Part 1), no behavior change.
//
// This module and lib/cli/menus.js reference each other's exports (showing
// the main menu after a successful (re)start, and re-entering setup/fork from
// menu actions). Both requires are done lazily inside functions to avoid a
// load-time circular-require ordering issue; by the time either function
// actually runs, both modules have finished initializing.

var fs = require("fs");
var path = require("path");
var net = require("net");
var spawn = require("child_process").spawn;

var {
  loadConfig, saveConfig, configPath, socketPath, logPath, ensureConfigDir,
  isDaemonAliveAsync, checkOldDaemon, generateSlug, clearStaleConfig,
  loadClayrc, readCrashInfo, CONFIG_DIR, CLAGENTIC_HOME,
} = require("../config");
var { sendIPCCommand } = require("../ipc");
var { hasAdmin, getSetupCode, hashPin } = require("../users");
var { log, sym, a } = require("./tui");
var { getLocalIP, ensureCerts, isPortFree } = require("./net-detect");

// --- Daemon watcher ---
// Polls daemon socket; if connection fails, the server is down.
var _daemonWatcher = null;
// Parsed CLI flags (port, useHttps, forceMkcert, noRestart, debugMode, ...)
// captured once at CLI startup via setDaemonWatcherOpts(), since bin/cli.js
// owns arg parsing but several async callbacks in this module (the crash
// watcher's onDaemonDied(), and lib/cli/menus.js's "re-run setup wizard"
// re-fork) fire long after parsing and have no other way to see the original
// flags. getCliOpts() exposes the same bundle read-only for other lib/cli/*
// modules.
var _watcherOpts = {};

function setDaemonWatcherOpts(opts) {
  _watcherOpts = opts || {};
}

function getCliOpts() {
  return _watcherOpts;
}

function startDaemonWatcher() {
  if (_daemonWatcher) return;
  _daemonWatcher = setInterval(function () {
    var client = net.connect(socketPath());
    var timer = setTimeout(function () {
      client.destroy();
      onDaemonDied(_watcherOpts);
    }, 1500);
    client.on("connect", function () {
      clearTimeout(timer);
      client.destroy();
    });
    client.on("error", function () {
      clearTimeout(timer);
      client.destroy();
      onDaemonDied(_watcherOpts);
    });
  }, 3000);
}

function stopDaemonWatcher() {
  if (_daemonWatcher) {
    clearInterval(_daemonWatcher);
    _daemonWatcher = null;
  }
}

var _restartAttempts = 0;
var MAX_RESTART_ATTEMPTS = 5;
var _restartBackoffStart = 0;

/**
 * Called when the daemon watcher detects the daemon has died. `opts` carries
 * the CLI flags that shape recovery behavior (noRestart) — passed explicitly
 * rather than read from module-level CLI state, since this module no longer
 * owns arg parsing.
 */
function onDaemonDied(opts) {
  opts = opts || {};
  stopDaemonWatcher();
  // Clean up stdin in case a prompt is active
  try {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdin.removeAllListeners("data");
  } catch (e) {}

  // Check if this was a crash (crash.json exists) vs intentional shutdown
  var crashInfo = readCrashInfo();
  if (!crashInfo) {
    // Intentional shutdown, no restart
    log("");
    log(sym.warn + "  " + a.yellow + "Server has been shut down." + a.reset);
    log(a.dim + "     Run " + a.reset + "npx @clagentic/console" + a.dim + " to start again." + a.reset);
    log("");
    process.exit(0);
    return;
  }

  // --no-restart: leave the daemon dead so the developer can inspect crash state
  if (opts.noRestart) {
    log("");
    log(sym.warn + "  " + a.yellow + "Server crashed. --no-restart is set — not restarting." + a.reset);
    if (crashInfo.reason) {
      log(a.dim + "     " + crashInfo.reason.split("\n")[0] + a.reset);
    }
    log(a.dim + "     Check logs: " + a.reset + logPath());
    log("");
    process.exit(1);
    return;
  }

  // Reset backoff counter if enough time has passed since last restart burst
  var now = Date.now();
  if (_restartBackoffStart && now - _restartBackoffStart > 60000) {
    _restartAttempts = 0;
  }

  _restartAttempts++;
  if (_restartAttempts > MAX_RESTART_ATTEMPTS) {
    log("");
    log(sym.warn + "  " + a.red + "Server crashed too many times (" + MAX_RESTART_ATTEMPTS + " attempts). Giving up." + a.reset);
    if (crashInfo.reason) {
      log(a.dim + "     " + crashInfo.reason.split("\n")[0] + a.reset);
    }
    log(a.dim + "     Check logs: " + a.reset + logPath());
    log("");
    process.exit(1);
    return;
  }

  if (_restartAttempts === 1) _restartBackoffStart = now;

  log("");
  log(sym.warn + "  " + a.yellow + "Server crashed. Restarting... (" + _restartAttempts + "/" + MAX_RESTART_ATTEMPTS + ")" + a.reset);
  if (crashInfo.reason) {
    log(a.dim + "     " + crashInfo.reason.split("\n")[0] + a.reset);
  }

  // Re-fork the daemon from saved config
  restartDaemonFromConfig(opts);
}

/**
 * `opts`: { port, debugMode }. port is the CLI's fallback port (used only if
 * no saved config exists yet); debugMode mirrors the --debug flag.
 */
async function restartDaemonFromConfig(opts) {
  opts = opts || {};
  var lastConfig = loadConfig();
  if (!lastConfig || !lastConfig.projects) {
    log(a.red + "     No config found. Cannot restart." + a.reset);
    process.exit(1);
    return;
  }

  clearStaleConfig();

  // Wait for port to be released
  var targetPort = lastConfig.port || opts.port;
  var waited = 0;
  while (waited < 3000) {
    var free = await isPortFree(targetPort);
    if (free) break;
    await new Promise(function (resolve) { setTimeout(resolve, 300); });
    waited += 300;
  }

  // Rebuild config (preserve everything except pid)
  var newConfig = Object.assign({}, lastConfig, {
    pid: null,
    port: targetPort,
    projects: (lastConfig.projects || []).filter(function (p) {
      return fs.existsSync(p.path);
    })
  });

  ensureConfigDir();
  saveConfig(newConfig);

  var daemonScript = path.join(__dirname, "..", "..", "lib", "daemon.js");

  // Debug mode: run in foreground with logs to stdout
  if (opts.debugMode) {
    process.env.CLAGENTIC_CONFIG = configPath();
    process.env.CLAGENTIC_HOME = CLAGENTIC_HOME;
    newConfig.pid = process.pid;
    saveConfig(newConfig);
    require(daemonScript);
    return;
  }

  var logFile = logPath();
  var logFd = fs.openSync(logFile, "a");

  var child = spawn(process.execPath, [daemonScript], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
    env: Object.assign({}, process.env, {
      CLAGENTIC_CONFIG: configPath(),
      CLAGENTIC_HOME: CLAGENTIC_HOME,
    }),
  });
  child.unref();
  fs.closeSync(logFd);

  newConfig.pid = child.pid;
  saveConfig(newConfig);

  // Wait and verify (retry up to 5 seconds)
  var alive = false;
  for (var rc = 0; rc < 10; rc++) {
    await new Promise(function (resolve) { setTimeout(resolve, 500); });
    alive = await isDaemonAliveAsync(newConfig);
    if (alive) break;
  }
  if (!alive) {
    log(a.red + "     Restart failed. Check logs: " + a.reset + logFile);
    process.exit(1);
    return;
  }
  var ip = getLocalIP();
  log(sym.done + "  " + a.green + "Server restarted successfully." + a.reset);
  log("");
  var { showMainMenu } = require("./menus");
  showMainMenu(newConfig, ip);
}

// ==============================
// Fork the daemon process
// ==============================
/**
 * `cliOpts`: { port, useHttps, forceMkcert, debugMode, headlessMode,
 * dangerouslySkipPermissions, osUsersMode, cliPin, cwd } — the subset of
 * parsed CLI flags that shape daemon startup. Passed explicitly since this
 * module no longer owns arg parsing (that stays in bin/cli.js).
 */
async function forkDaemon(mode, keepAwake, extraProjects, addCwd, wantOsUsers, cliOpts) {
  cliOpts = cliOpts || {};
  var port = cliOpts.port;
  var cwd = cliOpts.cwd;
  var cliPin = cliOpts.cliPin;
  var ip = getLocalIP();
  var hasTls = false;
  var mkcertDetected = false;

  if (cliOpts.useHttps) {
    var certPaths = ensureCerts(ip, CONFIG_DIR, cliOpts.forceMkcert);
    if (certPaths) {
      hasTls = true;
      if (certPaths.mkcertDetected) mkcertDetected = true;
    } else {
      log(sym.warn + "  " + a.yellow + "HTTPS unavailable" + a.reset + a.dim + " · mkcert not installed" + a.reset);
    }
  }

  // Migration shim: detect and shut down a pre-1.5 daemon holding the old socket
  // path. This prevents the port-in-use dead-end on upgrade. (lr-6ed3)
  if (process.platform !== "win32") {
    var oldCheck = await checkOldDaemon();
    if (oldCheck && oldCheck.alive) {
      log(sym.warn + "  " + a.yellow + "Pre-1.5 daemon detected at " + oldCheck.sockPath + " — shutting it down..." + a.reset);
      await sendIPCCommand(oldCheck.sockPath, { cmd: "shutdown" });
      // Wait up to 5 s for the port to be released
      var migWaited = 0;
      while (migWaited < 5000) {
        await new Promise(function (resolve) { setTimeout(resolve, 300); });
        migWaited += 300;
        if (await isPortFree(port)) break;
      }
      log(sym.done + "  " + a.green + "Pre-1.5 daemon stopped. Continuing startup..." + a.reset);
    } else if (oldCheck && !oldCheck.alive && fs.existsSync(oldCheck.sockPath)) {
      // Stale socket not yet cleaned up by ensureConfigDir (e.g. ensureConfigDir not
      // called yet on this path). Remove it now so nothing trips on it later.
      try { fs.unlinkSync(oldCheck.sockPath); } catch (e) {}
    }
  }

  // Check port availability
  var portFree = await isPortFree(port);
  if (!portFree) {
    log(a.red + "Port " + port + " is already in use." + a.reset);
    log(a.dim + "Another process is holding this port." + a.reset);
    log(a.dim + "If a pre-1.5 daemon is running, clagentic-console --shutdown will stop it." + a.reset);
    process.exit(1);
    return;
  }

  var allProjects = [];
  var usedSlugs = [];

  // Load previous config to preserve per-project settings (visibility, allowedUsers)
  var prevConfig = loadConfig();
  var prevProjectMap = {};
  if (prevConfig && prevConfig.projects) {
    for (var pi = 0; pi < prevConfig.projects.length; pi++) {
      prevProjectMap[prevConfig.projects[pi].path] = prevConfig.projects[pi];
    }
  }

  // Only include cwd if explicitly requested
  if (addCwd) {
    var slug = generateSlug(cwd, []);
    var cwdEntry = { path: cwd, slug: slug, addedAt: Date.now() };
    // Restore title/icon from .clagentic-rc if available
    var cwdRc = loadClayrc();
    var cwdRecent = cwdRc.recentProjects || [];
    for (var cr = 0; cr < cwdRecent.length; cr++) {
      if (cwdRecent[cr].path === cwd) {
        if (cwdRecent[cr].title) cwdEntry.title = cwdRecent[cr].title;
        if (cwdRecent[cr].icon) cwdEntry.icon = cwdRecent[cr].icon;
        break;
      }
    }
    // Restore project-level settings from previous config
    if (prevProjectMap[cwd]) {
      cwdEntry = Object.assign({}, prevProjectMap[cwd], cwdEntry);
    }
    allProjects.push(cwdEntry);
    usedSlugs.push(slug);
  }

  // Add restored projects (from ~/.clagentic-rc)
  if (extraProjects && extraProjects.length > 0) {
    for (var ep = 0; ep < extraProjects.length; ep++) {
      var rp = extraProjects[ep];
      if (rp.path === cwd) continue; // skip if same as cwd
      if (!fs.existsSync(rp.path)) continue; // skip missing directories
      var rpSlug = generateSlug(rp.path, usedSlugs);
      usedSlugs.push(rpSlug);
      var rpEntry = { path: rp.path, slug: rpSlug, title: rp.title || undefined, icon: rp.icon || undefined, addedAt: rp.addedAt || Date.now() };
      // Restore project-level settings from previous config
      if (prevProjectMap[rp.path]) {
        rpEntry = Object.assign({}, prevProjectMap[rp.path], rpEntry);
      }
      allProjects.push(rpEntry);
    }
  }

  var config = Object.assign({}, prevConfig || {}, {
    pid: null,
    port: port,
    host: cliOpts.host,
    pinHash: mode === "multi" && cliPin ? hashPin(cliPin) : (prevConfig && prevConfig.pinHash) || null,
    tls: hasTls,
    mkcertDetected: mkcertDetected,
    debug: cliOpts.debugMode,
    headless: cliOpts.headlessMode,
    keepAwake: keepAwake,
    dangerouslySkipPermissions: cliOpts.dangerouslySkipPermissions,
    osUsers: wantOsUsers || cliOpts.osUsersMode,
    mode: mode || "multi",
    setupCompleted: true,
    projects: allProjects,
  });

  ensureConfigDir();
  saveConfig(config);

  // Fork daemon
  var daemonScript = path.join(__dirname, "..", "..", "lib", "daemon.js");

  // Debug mode: run in foreground with logs to stdout
  if (cliOpts.debugMode) {
    process.env.CLAGENTIC_CONFIG = configPath();
    process.env.CLAGENTIC_HOME = CLAGENTIC_HOME;
    config.pid = process.pid;
    saveConfig(config);
    require(daemonScript);
    return;
  }

  var logFile = logPath();
  var logFd = fs.openSync(logFile, "a");

  var child = spawn(process.execPath, [daemonScript], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
    env: Object.assign({}, process.env, {
      CLAGENTIC_CONFIG: configPath(),
      CLAGENTIC_HOME: CLAGENTIC_HOME,
    }),
  });
  child.unref();
  fs.closeSync(logFd);

  // Update config with PID
  config.pid = child.pid;
  saveConfig(config);

  // Wait for daemon to start (retry up to 5 seconds)
  var alive = false;
  for (var attempt = 0; attempt < 10; attempt++) {
    await new Promise(function (resolve) { setTimeout(resolve, 500); });
    alive = await isDaemonAliveAsync(config);
    if (alive) break;
  }
  if (!alive) {
    log(a.red + "Failed to start daemon. Check logs:" + a.reset);
    log(a.dim + logFile + a.reset);
    clearStaleConfig();
    process.exit(1);
    return;
  }

  // Multi-user mode is always on (single-user mode was removed, lr-ec2d).
  // getSetupCode() auto-generates a code when there's no admin yet.
  var _pendingSetupCode = hasAdmin() ? null : getSetupCode();

  // Headless mode — print status and exit immediately
  if (cliOpts.headlessMode) {
    var protocol = config.tls ? "https" : "http";
    var url = protocol + "://" + ip + ":" + config.port;
    console.log("  " + sym.done + "  Daemon started (PID " + config.pid + ")");
    console.log("  " + sym.done + "  " + url);
    if (_pendingSetupCode) {
      console.log("");
      console.log("  " + sym.done + "  " + a.green + "Multi-user mode enabled." + a.reset);
      console.log("  " + sym.bar + "  Setup code:  " + a.bold + _pendingSetupCode + a.reset);
      console.log("  " + sym.bar + "  Open Clagentic: Console in your browser and enter this code to create the admin account.");
    }
    console.log("  " + sym.done + "  Headless mode — exiting CLI");
    process.exit(0);
    return;
  }

  // Show success + QR
  var { showServerStarted } = require("./menus");
  showServerStarted(config, ip, _pendingSetupCode);
}

// ==============================
// Dev mode — foreground daemon with file watching
// ==============================
/**
 * `cliOpts`: { port, useHttps, dangerouslySkipPermissions, watchMode,
 * noRestart, cwd }.
 */
async function devMode(mode, keepAwake, existingPinHash, wantOsUsers, cliOpts) {
  cliOpts = cliOpts || {};
  var port = cliOpts.port;
  var cwd = cliOpts.cwd;
  var ip = getLocalIP();
  var hasTls = false;
  var mkcertDetected = false;

  if (cliOpts.useHttps) {
    var certPaths = ensureCerts(ip, CONFIG_DIR, cliOpts.forceMkcert);
    if (certPaths) {
      hasTls = true;
      if (certPaths.mkcertDetected) mkcertDetected = true;
    }
  }

  // Migration shim: detect and shut down a pre-1.5 daemon on the old (dev) socket
  // path before checking port availability — mirrors what forkDaemon() does. (lr-6ed3)
  if (process.platform !== "win32") {
    var devOldCheck = await checkOldDaemon();
    if (devOldCheck && devOldCheck.alive) {
      log(sym.warn + "  " + a.yellow + "Pre-1.5 daemon detected at " + devOldCheck.sockPath + " — shutting it down..." + a.reset);
      await sendIPCCommand(devOldCheck.sockPath, { cmd: "shutdown" });
      var devMigWaited = 0;
      while (devMigWaited < 5000) {
        await new Promise(function (resolve) { setTimeout(resolve, 300); });
        devMigWaited += 300;
        if (await isPortFree(port)) break;
      }
      log(sym.done + "  " + a.green + "Pre-1.5 daemon stopped. Continuing startup..." + a.reset);
    } else if (devOldCheck && !devOldCheck.alive && fs.existsSync(devOldCheck.sockPath)) {
      try { fs.unlinkSync(devOldCheck.sockPath); } catch (e) {}
    }
  }

  var portFree = await isPortFree(port);
  if (!portFree) {
    console.log("\x1b[31m[dev] Port " + port + " is already in use.\x1b[0m");
    process.exit(1);
    return;
  }

  var slug = generateSlug(cwd, []);
  var cwdDevEntry = { path: cwd, slug: slug, addedAt: Date.now() };

  // Load previous config to preserve per-project settings (visibility, allowedUsers)
  var prevDevConfig = loadConfig();
  var prevDevProjectMap = {};
  if (prevDevConfig && prevDevConfig.projects) {
    for (var pdi = 0; pdi < prevDevConfig.projects.length; pdi++) {
      prevDevProjectMap[prevDevConfig.projects[pdi].path] = prevDevConfig.projects[pdi];
    }
  }

  // Restore previous projects
  var rc = loadClayrc();
  var restorable = (rc.recentProjects || []).filter(function (p) {
    return p.path !== cwd && fs.existsSync(p.path);
  });
  // Restore title/icon for cwd from .clagentic-rc
  var rcAll = rc.recentProjects || [];
  for (var ci = 0; ci < rcAll.length; ci++) {
    if (rcAll[ci].path === cwd) {
      if (rcAll[ci].title) cwdDevEntry.title = rcAll[ci].title;
      if (rcAll[ci].icon) cwdDevEntry.icon = rcAll[ci].icon;
      break;
    }
  }
  // Restore access settings for cwd from previous config
  if (prevDevProjectMap[cwd]) {
    cwdDevEntry = Object.assign({}, prevDevProjectMap[cwd], cwdDevEntry);
  }
  var allProjects = [cwdDevEntry];
  var usedSlugs = [slug];
  for (var ri = 0; ri < restorable.length; ri++) {
    var rp = restorable[ri];
    var rpSlug = generateSlug(rp.path, usedSlugs);
    usedSlugs.push(rpSlug);
    var rpDevEntry = { path: rp.path, slug: rpSlug, title: rp.title || undefined, icon: rp.icon || undefined, addedAt: rp.addedAt || Date.now() };
    // Restore project-level settings from previous config
    if (prevDevProjectMap[rp.path]) {
      rpDevEntry = Object.assign({}, prevDevProjectMap[rp.path], rpDevEntry);
    }
    allProjects.push(rpDevEntry);
  }

  var config = Object.assign({}, prevDevConfig || {}, {
    pid: null,
    port: port,
    host: cliOpts.host,
    pinHash: existingPinHash || null,
    tls: hasTls,
    mkcertDetected: mkcertDetected,
    debug: true,
    keepAwake: keepAwake || false,
    dangerouslySkipPermissions: cliOpts.dangerouslySkipPermissions,
    mode: mode || "multi",
    setupCompleted: true,
    projects: allProjects,
    osUsers: wantOsUsers || (prevDevConfig ? (prevDevConfig.osUsers || false) : false),
  });

  ensureConfigDir();
  saveConfig(config);

  // Multi-user mode is always on (single-user mode was removed, lr-ec2d).
  // getSetupCode() auto-generates a code when there's no admin yet.
  if (!hasAdmin()) {
    var devSetupCode = getSetupCode();
    if (devSetupCode) {
      console.log("\x1b[38;2;0;183;133m[dev]\x1b[0m Multi-user mode enabled. Setup code: " + devSetupCode);
    }
  }

  var daemonScript = path.join(__dirname, "..", "..", "lib", "daemon.js");
  var libDir = path.join(__dirname, "..", "..", "lib");
  var child = null;
  var intentionalKill = false;
  var debounceTimer = null;

  function spawnDaemon() {
    child = spawn(process.execPath, [daemonScript], {
      stdio: ["ignore", "inherit", "inherit"],
      env: Object.assign({}, process.env, {
        CLAGENTIC_CONFIG: configPath(),
        CLAGENTIC_HOME: CLAGENTIC_HOME,
      }),
    });

    child.on("exit", function (code) {
      child = null;
      if (intentionalKill) {
        intentionalKill = false;
        return;
      }
      // Exit code 120 = update restart — respawn daemon with current dev code
      if (code === 120) {
        console.log("\x1b[38;2;0;183;133m[dev]\x1b[0m Update restart — respawning daemon...");
        console.log("");
        setTimeout(spawnDaemon, 500);
        return;
      }
      // Exit code 78 = fatal config error (e.g. Node version too old) — don't restart
      if (code === 78) {
        console.log("\x1b[31m[dev] Daemon exited with fatal error (code 78). Not restarting.\x1b[0m");
        process.exit(78);
        return;
      }
      // Unexpected exit — auto restart (suppressed when --no-restart is set)
      if (cliOpts.noRestart) {
        console.log("\x1b[33m[dev] Daemon exited (code " + code + "). --no-restart is set — not restarting.\x1b[0m");
        process.exit(code || 1);
        return;
      }
      console.log("\x1b[33m[dev] Daemon exited (code " + code + "), restarting...\x1b[0m");
      setTimeout(spawnDaemon, 500);
    });
  }

  function restartDaemon() {
    intentionalKill = true;
    if (child) {
      child.kill("SIGTERM");
      // Give it a moment to shut down, then spawn
      setTimeout(spawnDaemon, 300);
    } else {
      intentionalKill = false;
      spawnDaemon();
    }
  }

  console.log("\x1b[38;2;0;183;133m[dev]\x1b[0m Starting relay on port " + port + "...");
  if (cliOpts.watchMode) {
    console.log("\x1b[38;2;0;183;133m[dev]\x1b[0m Watching lib/ for changes (excluding lib/public/)");
  }
  console.log("");

  spawnDaemon();

  // Wait for daemon to be ready, then show CLI menu
  config.pid = child ? child.pid : null;
  saveConfig(config);

  var daemonReady = false;
  for (var da = 0; da < 10; da++) {
    await new Promise(function (resolve) { setTimeout(resolve, 500); });
    daemonReady = await isDaemonAliveAsync(config);
    if (daemonReady) break;
  }
  if (daemonReady) {
    var { showServerStarted } = require("./menus");
    showServerStarted(config, ip);
  }

  // Watch lib/ for server-side file changes (only with --watch)
  var watcher = null;
  if (cliOpts.watchMode) {
    watcher = fs.watch(libDir, { recursive: true }, function (eventType, filename) {
      if (!filename) return;
      // Skip client-side files — they're served from disk
      if (filename.startsWith("public" + path.sep) || filename.startsWith("public/")) return;
      // Skip non-JS files
      if (!filename.endsWith(".js")) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        console.log("\x1b[38;2;0;183;133m[dev]\x1b[0m File changed: lib/" + filename);
        console.log("\x1b[38;2;0;183;133m[dev]\x1b[0m Restarting...");
        console.log("");
        restartDaemon();
      }, 300);
    });
  }

  // Clean exit on Ctrl+C
  var shuttingDown = false;
  process.on("SIGINT", function () {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n\x1b[38;2;0;183;133m[dev]\x1b[0m Shutting down...");
    if (watcher) watcher.close();
    if (debounceTimer) clearTimeout(debounceTimer);
    intentionalKill = true;
    if (child) {
      child.kill("SIGTERM");
      child.on("exit", function () {
        clearStaleConfig();
        process.exit(0);
      });
      // Force kill after 3s
      setTimeout(function () { process.exit(0); }, 3000);
    } else {
      clearStaleConfig();
      process.exit(0);
    }
  });
}

// ==============================
// Restart daemon with TLS enabled
// ==============================
function restartDaemonWithTLS(config, callback, cliOpts) {
  return _restartDaemonWithTLS(config, callback, cliOpts || {});
}

async function _restartDaemonWithTLS(config, callback, cliOpts) {
  var ip = getLocalIP();
  var certPaths = ensureCerts(ip, CONFIG_DIR, cliOpts.forceMkcert);
  if (!certPaths) {
    callback(config);
    return;
  }
  var mkcertDetected = !!(certPaths && certPaths.mkcertDetected);

  // Shut down old daemon
  stopDaemonWatcher();
  try {
    await sendIPCCommand(socketPath(), { cmd: "shutdown" });
  } catch (e) {}

  // Wait for port to be released
  var waited = 0;
  while (waited < 5000) {
    await new Promise(function (resolve) { setTimeout(resolve, 300); });
    waited += 300;
    var free = await isPortFree(config.port);
    if (free) break;
  }
  clearStaleConfig();

  // Re-fork with TLS (preserve all existing config fields)
  var newConfig = Object.assign({}, config, {
    pid: null,
    tls: true,
    mkcertDetected: mkcertDetected,
  });

  ensureConfigDir();
  saveConfig(newConfig);

  var daemonScript = path.join(__dirname, "..", "..", "lib", "daemon.js");
  var logFile = logPath();
  var logFd = fs.openSync(logFile, "a");

  var child = spawn(process.execPath, [daemonScript], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
    env: Object.assign({}, process.env, {
      CLAGENTIC_CONFIG: configPath(),
      CLAGENTIC_HOME: CLAGENTIC_HOME,
    }),
  });
  child.unref();
  fs.closeSync(logFd);

  newConfig.pid = child.pid;
  saveConfig(newConfig);

  var alive = false;
  for (var ra = 0; ra < 10; ra++) {
    await new Promise(function (resolve) { setTimeout(resolve, 500); });
    alive = await isDaemonAliveAsync(newConfig);
    if (alive) break;
  }
  if (!alive) {
    log(sym.warn + "  " + a.yellow + "Failed to restart with HTTPS, falling back to HTTP..." + a.reset);
    // Re-fork without TLS so the server is at least running
    newConfig.tls = false;
    saveConfig(newConfig);
    var logFd2 = fs.openSync(logFile, "a");
    var child2 = spawn(process.execPath, [daemonScript], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd2, logFd2],
      env: Object.assign({}, process.env, {
        CLAGENTIC_CONFIG: configPath(),
        CLAGENTIC_HOME: CLAGENTIC_HOME,
      }),
    });
    child2.unref();
    fs.closeSync(logFd2);
    newConfig.pid = child2.pid;
    saveConfig(newConfig);
    for (var rb = 0; rb < 10; rb++) {
      await new Promise(function (resolve) { setTimeout(resolve, 500); });
      var retryAlive = await isDaemonAliveAsync(newConfig);
      if (retryAlive) break;
    }
    startDaemonWatcher();
    callback(newConfig);
    return;
  }

  startDaemonWatcher();
  callback(newConfig);
}

module.exports = {
  startDaemonWatcher: startDaemonWatcher,
  stopDaemonWatcher: stopDaemonWatcher,
  onDaemonDied: onDaemonDied,
  restartDaemonFromConfig: restartDaemonFromConfig,
  forkDaemon: forkDaemon,
  devMode: devMode,
  restartDaemonWithTLS: restartDaemonWithTLS,
  setDaemonWatcherOpts: setDaemonWatcherOpts,
  getCliOpts: getCliOpts,
};

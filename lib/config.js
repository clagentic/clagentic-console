var fs = require("fs");
var path = require("path");
var os = require("os");
var net = require("net");
var execFileSync = require("child_process").execFileSync;
var _store = null; // lazy to avoid circular-require at module load time

function isSafeSystemUserName(name) {
  return typeof name === "string" && /^[a-z_][a-z0-9_-]*[$]?$/.test(name);
}

// When running under sudo, resolve the real user's home directory
// so that ~/.clagentic/ points to the original user's data, not /root/.clagentic/
function getRealHome() {
  var sudoUser = process.env.SUDO_USER;
  if (sudoUser && sudoUser !== "root" && isSafeSystemUserName(sudoUser)) {
    // 1. Try getent passwd (works on most Linux, may fail with some NSS configs)
    try {
      var entry = execFileSync("getent", ["passwd", sudoUser], { encoding: "utf8", timeout: 3000 }).trim();
      var home = entry.split(":")[5];
      if (home && fs.existsSync(home)) return home;
    } catch (e) {}
    // 2. Direct path fallback (GCE, cloud VMs)
    var directHome = "/home/" + sudoUser;
    if (fs.existsSync(directHome)) return directHome;
    // 3. SUDO_USER's original HOME (some sudo configs preserve it)
    if (process.env.SUDO_HOME && fs.existsSync(process.env.SUDO_HOME)) return process.env.SUDO_HOME;
  }
  return os.homedir();
}

var REAL_HOME = getRealHome();

// Data dir: ~/.clagentic/  (prev: ~/.clay/ — migrated on first run)
// If CLAGENTIC_CONFIG is set (daemon mode), derive CLAGENTIC_HOME from it.
// CLAY_HOME and CLAY_CONFIG accepted as fallbacks for one release.
var CLAGENTIC_HOME = process.env.CLAGENTIC_HOME
  || process.env.CLAY_HOME
  || (process.env.CLAGENTIC_CONFIG ? path.dirname(process.env.CLAGENTIC_CONFIG) : null)
  || (process.env.CLAY_CONFIG ? path.dirname(process.env.CLAY_CONFIG) : null)
  || path.join(REAL_HOME, ".clagentic");

// One-time migration: copy ~/.clay/ → ~/.clagentic/ if clagentic dir absent
var OLD_CLAY_HOME = path.join(REAL_HOME, ".clay");
if (!fs.existsSync(CLAGENTIC_HOME) && fs.existsSync(OLD_CLAY_HOME)) {
  try {
    fs.cpSync(OLD_CLAY_HOME, CLAGENTIC_HOME, { recursive: true });
    console.log("[config] Migrated " + OLD_CLAY_HOME + " → " + CLAGENTIC_HOME + " — ~/.clay/ can be deleted when verified");
  } catch (e) {
    console.error("[config] Migration failed:", e.message);
  }
}

var CONFIG_DIR = CLAGENTIC_HOME;
var EXTERNAL_TRIGGERS_DIR = path.join(CONFIG_DIR, "external-triggers");
var OLD_CLAYRC = path.join(REAL_HOME, ".clayrc");
var CLAGENTIC_RC_PATH = path.join(REAL_HOME, ".clagentic-rc");
// One-time migration: copy .clayrc → .clagentic-rc if new file absent
if (!fs.existsSync(CLAGENTIC_RC_PATH) && fs.existsSync(OLD_CLAYRC)) {
  try { fs.copyFileSync(OLD_CLAYRC, CLAGENTIC_RC_PATH); } catch (e) {}
}
var CRASH_INFO_PATH = path.join(CONFIG_DIR, "crash.json");

// Dev mode uses separate daemon files so dev and prod can run simultaneously
var _devMode = !!(process.env.CLAGENTIC_DEV || process.env.CLAY_DEV);

function configPath() {
  return path.join(CONFIG_DIR, _devMode ? "daemon-dev.json" : "daemon.json");
}

function socketPath() {
  if (process.platform === "win32") {
    var pipeName = _devMode ? "clagentic-daemon-dev" : "clagentic-daemon";
    return "\\\\.\\pipe\\" + pipeName;
  }
  return path.join(CONFIG_DIR, "console", _devMode ? "daemon-dev.sock" : "daemon.sock");
}

function logPath() {
  return path.join(CONFIG_DIR, _devMode ? "daemon-dev.log" : "daemon.log");
}

function chmodSafe(filePath, mode) {
  if (process.platform === "win32") return;
  try { fs.chmodSync(filePath, mode); } catch (e) {}
}

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  chmodSafe(CONFIG_DIR, 0o700);
  fs.mkdirSync(path.join(CONFIG_DIR, "console"), { recursive: true });
  chmodSafe(path.join(CONFIG_DIR, "console"), 0o700);
  // One-time migration warning: old socket path was directly under CONFIG_DIR
  var oldSock = path.join(CONFIG_DIR, _devMode ? "daemon-dev.sock" : "daemon.sock");
  if (fs.existsSync(oldSock)) {
    console.warn("[config] daemon.sock has moved to ~/.clagentic/console/daemon.sock — update any scripts or CLAGENTIC_CONSOLE_HOME settings using the old path");
  }
}

function loadConfig() {
  try {
    var data = fs.readFileSync(configPath(), "utf8");
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

function saveConfig(config) {
  // Async atomic write through store.js (queued per path, 0o600). Fire-and-forget.
  // The daemon.json path varies by dev mode, so we use writeJsonAt with the full path.
  ensureConfigDir();
  if (!_store) _store = require("./store");
  _store.writeJsonAt(configPath(), config).catch(function (err) {
    process.stderr.write("[config] saveConfig failed: " + (err && err.message ? err.message : err) + "\n");
  });
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function isDaemonAlive(config) {
  if (!config || !config.pid) return false;
  if (!isPidAlive(config.pid)) {
    clearStaleConfig();
    return false;
  }
  // Named pipes on Windows can't be stat'd, just check PID
  if (process.platform === "win32") return true;
  try {
    fs.statSync(socketPath());
    return true;
  } catch (e) {
    return false;
  }
}

function isDaemonAliveAsync(config) {
  return new Promise(function (resolve) {
    if (!config || !config.pid) return resolve(false);
    if (!isPidAlive(config.pid)) {
      clearStaleConfig();
      return resolve(false);
    }

    var sock = socketPath();
    var client = net.connect(sock);
    var timer = setTimeout(function () {
      client.destroy();
      resolve(false);
    }, 1000);

    client.on("connect", function () {
      clearTimeout(timer);
      client.destroy();
      resolve(true);
    });
    client.on("error", function () {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function generateSlug(projectPath, existingSlugs) {
  var base = path.basename(projectPath).toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!base) base = "project";
  if (!existingSlugs || existingSlugs.indexOf(base) === -1) return base;
  for (var i = 2; i < 100; i++) {
    var candidate = base + "-" + i;
    if (existingSlugs.indexOf(candidate) === -1) return candidate;
  }
  return base + "-" + Date.now();
}

function clearStaleConfig() {
  // Clear pid from config instead of deleting the file (preserves project settings).
  // Write via store.js (async, queued, 0o600). Fire-and-forget.
  try {
    var data = fs.readFileSync(configPath(), "utf8");
    var cfg = JSON.parse(data);
    cfg.pid = null;
    if (!_store) _store = require("./store");
    _store.writeJsonAt(configPath(), cfg).catch(function () {});
  } catch (e) {}
  if (process.platform !== "win32") {
    try { fs.unlinkSync(socketPath()); } catch (e) {}
  }
}

// --- Crash info ---

function crashInfoPath() {
  return CRASH_INFO_PATH;
}

function writeCrashInfo(info) {
  try {
    ensureConfigDir();
    fs.writeFileSync(CRASH_INFO_PATH, JSON.stringify(info));
  } catch (e) {}
}

function readCrashInfo() {
  try {
    var data = fs.readFileSync(CRASH_INFO_PATH, "utf8");
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

function clearCrashInfo() {
  try { fs.unlinkSync(CRASH_INFO_PATH); } catch (e) {}
}

// --- ~/.clagentic-rc (recent projects persistence) ---

function clagentic_rcPath() {
  return CLAGENTIC_RC_PATH;
}

function loadClayrc() {
  try {
    var data = fs.readFileSync(CLAGENTIC_RC_PATH, "utf8");
    return JSON.parse(data);
  } catch (e) {
    return { recentProjects: [] };
  }
}

function saveClayrc(rc) {
  var tmpPath = CLAGENTIC_RC_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(rc, null, 2) + "\n");
  fs.renameSync(tmpPath, CLAGENTIC_RC_PATH);
}

/**
 * Update ~/.clagentic-rc with the current project list from daemon config.
 * Merges with existing entries (preserves addedAt, updates lastUsed).
 */
function syncClayrc(projects) {
  var rc = loadClayrc();
  var existing = rc.recentProjects || [];

  // Build a map by path for quick lookup
  var byPath = {};
  for (var i = 0; i < existing.length; i++) {
    byPath[existing[i].path] = existing[i];
  }

  // Update/add current projects
  for (var j = 0; j < projects.length; j++) {
    var p = projects[j];
    if (byPath[p.path]) {
      // Update existing entry
      byPath[p.path].slug = p.slug;
      byPath[p.path].lastUsed = Date.now();
      if (p.title) byPath[p.path].title = p.title;
      else if ("title" in p) delete byPath[p.path].title;
      if (p.icon) byPath[p.path].icon = p.icon;
      else if ("icon" in p) delete byPath[p.path].icon;
    } else {
      // New entry
      byPath[p.path] = {
        path: p.path,
        slug: p.slug,
        title: p.title || undefined,
        icon: p.icon || undefined,
        addedAt: p.addedAt || Date.now(),
        lastUsed: Date.now(),
      };
    }
  }

  // Active projects first, preserving config order (user's drag-and-drop order),
  // then inactive recent projects sorted by lastUsed descending
  var activePaths = {};
  var ordered = [];
  for (var k = 0; k < projects.length; k++) {
    activePaths[projects[k].path] = true;
    if (byPath[projects[k].path]) ordered.push(byPath[projects[k].path]);
  }
  var inactive = [];
  var paths = Object.keys(byPath);
  for (var m = 0; m < paths.length; m++) {
    if (!activePaths[paths[m]]) inactive.push(byPath[paths[m]]);
  }
  inactive.sort(function (a, b) { return (b.lastUsed || 0) - (a.lastUsed || 0); });
  var all = ordered.concat(inactive);

  // Keep at most 20 recent projects
  rc.recentProjects = all.slice(0, 20);
  saveClayrc(rc);
}

function removeFromClayrc(projectPath) {
  var rc = loadClayrc();
  var before = (rc.recentProjects || []).length;
  rc.recentProjects = (rc.recentProjects || []).filter(function (p) {
    return p.path !== projectPath;
  });
  if (rc.recentProjects.length !== before) saveClayrc(rc);
}

module.exports = {
  CONFIG_DIR: CONFIG_DIR,
  EXTERNAL_TRIGGERS_DIR: EXTERNAL_TRIGGERS_DIR,
  configPath: configPath,
  socketPath: socketPath,
  logPath: logPath,
  ensureConfigDir: ensureConfigDir,
  loadConfig: loadConfig,
  saveConfig: saveConfig,
  isPidAlive: isPidAlive,
  isDaemonAlive: isDaemonAlive,
  isDaemonAliveAsync: isDaemonAliveAsync,
  generateSlug: generateSlug,
  clearStaleConfig: clearStaleConfig,
  crashInfoPath: crashInfoPath,
  writeCrashInfo: writeCrashInfo,
  readCrashInfo: readCrashInfo,
  clearCrashInfo: clearCrashInfo,
  clayrcPath: clagentic_rcPath,
  loadClayrc: loadClayrc,
  saveClayrc: saveClayrc,
  syncClayrc: syncClayrc,
  removeFromClayrc: removeFromClayrc,
  chmodSafe: chmodSafe,
  isDevMode: _devMode,
  REAL_HOME: REAL_HOME,
  OLD_CLAY_HOME: OLD_CLAY_HOME,
};


#!/usr/bin/env node

// --- Node version check ---
var nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
if (nodeMajor < 20) {
  console.error("\x1b[31m[clagentic-console] Node.js 20+ is required (current: " + process.version + ")\x1b[0m");
  console.error("[clagentic-console] The Claude Agent SDK 0.2.40+ requires Node 20 for Symbol.dispose support.");
  console.error("");
  console.error("  Upgrade Node:  nvm install 22 && nvm use 22");
  process.exit(78); // EX_CONFIG — fatal config error, don't auto-restart
}

// Polyfill Symbol.dispose/asyncDispose if missing (Node 20.x may not have it)
if (!Symbol.dispose) Symbol.dispose = Symbol("Symbol.dispose");
if (!Symbol.asyncDispose) Symbol.asyncDispose = Symbol("Symbol.asyncDispose");

// Increase listener limit for projects with many worktrees
process.setMaxListeners(50);

// Remove CLAUDECODE env var so the SDK can spawn Claude Code child processes
// (prevents "cannot be launched inside another Claude Code session" error)
delete process.env.CLAUDECODE;

var fs = require("fs");
var path = require("path");
var { loadConfig, saveConfig, socketPath, ensureConfigDir, generateSlug, syncClayrc, removeFromClayrc, writeCrashInfo, readCrashInfo, clearCrashInfo, isPidAlive, clearStaleConfig, REAL_HOME, CONFIG_DIR, CLAGENTIC_HOME } = require("./config");
var { createIPCServer } = require("./ipc");
var { createServer } = require("./server");
var { checkAclSupport, grantProjectAccess, revokeProjectAccess, provisionAllUsers, provisionLinuxUser, grantAllUsersAccess, deactivateLinuxUser, ensureProjectsDir } = require("./os-users");
var usersModule = require("./users");
var { createWorktree, removeWorktree, isWorktree } = require("./worktree");
var { isWorktreeSlug, scanAndRegisterWorktrees, rescanWorktrees, cleanupWorktreesForParent, getFilteredRemovedProjects, registerWorktreeSlug, unregisterWorktreeSlug } = require("./daemon-projects");
var { validateCloneUrl, buildCloneArgs } = require("./clone-validate");
var { DEFAULT_MEM_AVAILABLE_MIN_MB, DEFAULT_TOKENS_PER_MB_HEADROOM, getActiveLiveCount } = require("./sdk-bridge");
var { startMemoryHighWatcher } = require("./memory-limits");
var { createDrain } = require("./drain");
var liteDetect = require("./lite-detect");
var { execFile: liteExecFile } = require("child_process");
var { SLUG_RE: CUSTOM_ICON_SLUG_RE, CUSTOM_EMOJI_CT } = require("./server-settings");

var daemonVersion = require("../package.json").version;
var configFile = process.env.CLAGENTIC_CONFIG || process.env.CLAY_CONFIG || require("./config").configPath();
var config;

// Ensure dirs exist before any file access — daemon must be self-sufficient when
// launched directly by systemd/supervisor with no prior CLI run.
ensureConfigDir();

try {
  config = JSON.parse(fs.readFileSync(configFile, "utf8"));
} catch (e) {
  if (e.code === "ENOENT") {
    // Guard: if CLAGENTIC_HOME was erroneously set to the socket subdirectory
    // (e.g. ~/.clagentic/console instead of ~/.clagentic), a real daemon.json
    // will exist one level above CLAGENTIC_HOME. Detect this and refuse to
    // bootstrap an empty config — that would silently discard all projects.
    var { CLAGENTIC_HOME: _cgHome } = require("./config");
    var _siblingConfig = path.join(path.dirname(_cgHome), "daemon.json");
    try {
      var _sibling = JSON.parse(fs.readFileSync(_siblingConfig, "utf8"));
      if (_sibling && Array.isArray(_sibling.projects) && _sibling.projects.length > 0) {
        console.error("[daemon] ERROR: CLAGENTIC_HOME appears to point at the console/ socket subdirectory (" + _cgHome + ").");
        console.error("[daemon] A populated daemon.json with " + _sibling.projects.length + " project(s) exists at " + _siblingConfig + ".");
        console.error("[daemon] Set CLAGENTIC_HOME to the parent directory (" + path.dirname(_cgHome) + ") to use the correct config.");
        process.exit(78); // EX_CONFIG — do not auto-restart
      }
    } catch (_e) { /* sibling check is best-effort; fall through to normal bootstrap */ }

    // No config file yet (fresh install, systemd-only start). Bootstrap minimal defaults.
    console.warn("[daemon] No config file found at " + configFile + " — bootstrapping defaults. Run clagentic-console to configure projects.");
    var _isDev = !!(process.env.CLAGENTIC_DEV || process.env.CLAY_DEV);
    config = { port: _isDev ? 2635 : 2633, projects: [], mode: "single", setupCompleted: false };
    // Persist so subsequent reads succeed.
    try {
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    } catch (writeErr) {
      console.error("[daemon] Failed to persist bootstrap config:", writeErr.message);
      process.exit(1);
    }
  } else {
    console.error("[daemon] Failed to read config:", e.message);
    process.exit(1);
  }
}
console.log("[daemon] v" + daemonVersion + " PID " + process.pid + " config " + configFile);

console.log("[daemon] Config: " + configFile);
console.log("[daemon] Users: " + usersModule.USERS_FILE);
if (process.env.SUDO_USER) console.log("[daemon] SUDO_USER: " + process.env.SUDO_USER);
console.log("[daemon] UID: " + (typeof process.getuid === "function" ? process.getuid() : "N/A"));

// Stale-code check: if this process holds deleted inodes, the on-disk JS was
// replaced by a newer install while we were running. Warn loudly so operators
// know a restart is needed to load the new code.
function checkStaleInodes() {
  if (process.platform !== 'linux') return false;
  try {
    var mapsContent = fs.readFileSync('/proc/self/maps', 'utf8');
    return mapsContent.split('\n').some(function(line) {
      return line.includes(' (deleted)');
    });
  } catch (_) {
    return false;
  }
}

if (checkStaleInodes()) {
  console.warn('[daemon] WARNING: this process is serving STALE code — on-disk JS has been replaced');
  console.warn('[daemon] WARNING: restart the daemon to load the new build:');
  console.warn('[daemon] WARNING:   systemctl restart clagentic-console');
  console.warn('[daemon] WARNING:   — or — clagentic-console --restart');
}


// --- Single-user to multi-user migration (lr-ec2d) ---
function migrateSingleUserToMultiUser(cfg, data) {
  if (data.multiUser) return; // already migrated, no-op

  var fsMig = require("fs");
  var pathMig = require("path");
  var cryptoMig = require("crypto");
  var usersFilePath = usersModule.USERS_FILE;

  var hasPin = !!(cfg && cfg.pinHash);
  var hasAdmin = data.users && data.users.some(function (u) { return u.role === "admin"; });

  data.multiUser = true;

  // Generate setup code using the users module's exported function
  var setupCode = cryptoMig.randomBytes(4).toString("hex").toUpperCase();
  data.setupCode = setupCode;

  // Case A: PIN set, no users — create admin stub (PIN cannot be transferred, incompatible hash formats)
  if (hasPin && (!data.users || data.users.length === 0)) {
    var adminId = cryptoMig.randomUUID();
    data.users = [{
      id: adminId,
      username: "admin",
      email: null,
      displayName: "Admin",
      pinHash: null,          // PIN cannot be transferred — incompatible hash formats (lr-ec2d spec §7 risk 1)
      role: "admin",
      createdAt: Date.now(),
      mustChangePin: false,
      linuxUser: null,
      profile: {
        name: "Admin",
        lang: "en-US",
        avatarColor: "#7c3aed",
        avatarStyle: "thumbs",
        avatarSeed: cryptoMig.randomBytes(4).toString("hex"),
      },
    }];
  }
  // Case B: users present but no admin — set setupCode, keep existing users (done above)
  // Case C: no PIN, no users — set setupCode, users stay empty (done above)

  // Atomic synchronous write
  var tmpFile = usersFilePath + ".tmp." + process.pid;
  fsMig.writeFileSync(tmpFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  fsMig.renameSync(tmpFile, usersFilePath);

  // Prominent banner
  var port = (cfg && cfg.port) || 3000;
  var url = "http://localhost:" + port + "/auth/setup?setupCode=" + setupCode;
  console.log("");
  console.log("┌─────────────────────────────────────────────────────────────┐");
  console.log("│  Clagentic: Console — one-time upgrade step required        │");
  console.log("│                                                             │");
  console.log("│  Your install has been migrated to multi-user mode.        │");
  console.log("│  Open this URL to set your admin PIN:                      │");
  console.log("│                                                             │");
  console.log("│  " + url.padEnd(61) + "│");
  console.log("│                                                             │");
  console.log("│  Setup code also stored in ~/.clagentic/console/users.json │");
  console.log("│  Your previous PIN cannot be transferred (format change).  │");
  console.log("│  Set a new PIN via the setup URL above.                    │");
  console.log("└─────────────────────────────────────────────────────────────┘");
  console.log("");
}

var _usersDataForMigration = usersModule.loadUsers();
migrateSingleUserToMultiUser(config, _usersDataForMigration);

// --- OS users mode: check required system dependencies ---
if (config.osUsers) {
  var checkExec = require("child_process").execFileSync;
  var missing = [];
  try { checkExec("which", ["setfacl"], { stdio: "ignore" }); } catch (e) { missing.push("acl (setfacl)"); }
  try { checkExec("which", ["git"], { stdio: "ignore" }); } catch (e) { missing.push("git"); }
  try { checkExec("which", ["useradd"], { stdio: "ignore" }); } catch (e) { missing.push("useradd"); }
  if (missing.length > 0) {
    console.error("[daemon] OS users mode requires missing system packages: " + missing.join(", "));
    console.error("[daemon] Install with:  sudo apt install " + missing.map(function (m) { return m.split(" ")[0]; }).join(" "));
    process.exit(78); // EX_CONFIG
  }
}

// --- TLS ---
// One-time migration: certs dir moved from ~/.clagentic/certs/ → CONFIG_DIR/certs/ (lr-6204).
// Copy-not-rename: the old location stays so a rollback is safe.
// We run this before reading certs so a fresh start after upgrade picks them up immediately.
(function migrateCertsDir() {
  var oldCerts = path.join(CLAGENTIC_HOME, "certs");
  var newCerts = path.join(CONFIG_DIR, "certs");
  try {
    if (fs.existsSync(oldCerts) && !fs.existsSync(newCerts)) {
      fs.cpSync(oldCerts, newCerts, { recursive: true, preserveTimestamps: true });
      console.log("[daemon] Migrated certs/ → " + newCerts + " — root copy can be removed when verified");
    }
  } catch (e) {
    console.error("[daemon] Certs migration failed (non-fatal):", e.message);
  }
}());
var tlsOptions = null;
if (config.tls) {
  // User cert (CONFIG_DIR/certs/key.pem + cert.pem, generated by mkcert or supplied manually).
  // Old location was ~/.clagentic/certs/ — migrated above on first run.
  var certDir = path.join(CONFIG_DIR, "certs");
  var keyPath = path.join(certDir, "key.pem");
  var certPath = path.join(certDir, "cert.pem");

  try {
    tlsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
  } catch (e) {
    console.error("[daemon] TLS cert not found, falling back to HTTP");
  }
}

var caRoot = null;

// --- Resolve LAN IP for share URL ---
var os2 = require("os");
var lanIp = (function () {
  var ifaces = os2.networkInterfaces();
  for (var addrs of Object.values(ifaces)) {
    for (var i = 0; i < addrs.length; i++) {
      if (addrs[i].family === "IPv4" && !addrs[i].internal && addrs[i].address.startsWith("100.")) return addrs[i].address;
    }
  }
  for (var addrs of Object.values(ifaces)) {
    for (var i = 0; i < addrs.length; i++) {
      if (addrs[i].family === "IPv4" && !addrs[i].internal) return addrs[i].address;
    }
  }
  return null;
})();

// getFilteredRemovedProjects extracted to daemon-projects.js

// --- Create multi-project server ---
var listenHost = config.host || "0.0.0.0";

var relay = createServer({
  tlsOptions: tlsOptions,
  caPath: caRoot,
  builtinCert: config.builtinCert || false,
  port: config.port,
  debug: config.debug || false,
  dangerouslySkipPermissions: config.dangerouslySkipPermissions || false,
  osUsers: config.osUsers || false,
  lanHost: lanIp ? lanIp + ":" + config.port : null,
  getRemovedProjects: function (userId) { return getFilteredRemovedProjects(config, userId); },
  getFolderMeta: function () { return config.folderMeta || {}; },
  onAddProject: function (absPath, wsUser) {
    // Check if already registered
    for (var j = 0; j < config.projects.length; j++) {
      if (config.projects[j].path === absPath) {
        return { ok: true, slug: config.projects[j].slug, existing: true };
      }
    }
    var slugs = config.projects.map(function (p) { return p.slug; });
    var slug = generateSlug(absPath, slugs);
    relay.addProject(absPath, slug, null, null, wsUser ? wsUser.id : null);
    var projectEntry = { path: absPath, slug: slug, addedAt: Date.now(), visibility: "private" };
    // The user who adds a project always becomes the owner
    if (wsUser && wsUser.id) {
      projectEntry.ownerId = wsUser.id;
    }
    config.projects.push(projectEntry);
    // Remove from removedProjects if present
    if (config.removedProjects) {
      config.removedProjects = config.removedProjects.filter(function (rp) { return rp.path !== absPath; });
    }
    saveConfig(config);
    try { syncClayrc(config.projects); } catch (e) {}
    console.log("[daemon] Added project (web):", slug, "→", absPath);
    // OS users mode: grant ACL to project owner
    if (config.osUsers) {
      var newProj = config.projects[config.projects.length - 1];
      if (newProj.ownerId) {
        var ownerUser = usersModule.findUserById(newProj.ownerId);
        if (ownerUser && ownerUser.linuxUser) {
          grantProjectAccess(absPath, ownerUser.linuxUser);
        }
      }
    }
    // Discover and register worktrees for the new project
    scanAndRegisterWorktrees(relay, absPath, slug, null, wsUser && wsUser.id && wsUser.role !== "admin" ? wsUser.id : null);
    // Auto-enroll in Clagentic: Lite if enabled and Lite is installed
    if (config.liteAutoEnroll) {
      var liteStatus = liteDetect.detectLite();
      if (liteStatus.installed && !liteDetect.isProjectEnrolled(absPath)) {
        liteExecFile("clagentic-lite", ["enroll", absPath], { timeout: 30000 }, function (err) {
          if (err) {
            console.warn("[daemon] Lite auto-enroll failed for " + absPath + ":", err.message);
          } else {
            console.log("[daemon] Lite auto-enrolled project:", absPath);
          }
        });
      }
    }
    // Broadcast updated project list to all clients
    relay.broadcastAll({
      type: "projects_updated",
      projects: relay.getProjects(),
      projectCount: config.projects.length,
      folderMeta: config.folderMeta || {},
    });
    return { ok: true, slug: slug };
  },
  onCreateProject: function (projectName, wsUser) {
    console.log("[daemon] onCreateProject wsUser:", JSON.stringify(wsUser ? { id: wsUser.id, role: wsUser.role, username: wsUser.username, linuxUser: wsUser.linuxUser } : null));
    var os = require("os");
    var execFileSync = require("child_process").execFileSync;
    var baseDir;
    if (config.osUsers) {
      baseDir = "/var/clagentic/projects";
    } else {
      baseDir = config.projectsDir || (function () {
        var newDir = path.join(REAL_HOME, "clagentic-projects");
        var oldDir = path.join(REAL_HOME, "clay-projects");
        // One-time migration: if new dir absent but old dir exists, rename it
        if (!fs.existsSync(newDir) && fs.existsSync(oldDir)) {
          try {
            fs.renameSync(oldDir, newDir);
            console.log("[config] Renamed " + oldDir + " → " + newDir);
          } catch (e) {
            // rename failed (e.g. cross-device) — fall back to old dir to avoid data loss
            return oldDir;
          }
        }
        return newDir;
      })();
    }
    try { fs.mkdirSync(baseDir, { recursive: true }); } catch (e) {}
    // Generate slug and deduplicate
    var slugs = config.projects.map(function (p) { return p.slug; });
    var slug = generateSlug(path.join(baseDir, projectName), slugs);
    var targetDir = path.join(baseDir, slug);
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      // Run git init
      if (config.osUsers && wsUser) {
        var linuxUser = wsUser.linuxUser;
        if (linuxUser) {
          var uidGid = null;
          try {
            uidGid = {
              uid: parseInt(execFileSync("id", ["-u", linuxUser], { encoding: "utf8", stdio: "pipe" }).trim(), 10),
              gid: parseInt(execFileSync("id", ["-g", linuxUser], { encoding: "utf8", stdio: "pipe" }).trim(), 10),
            };
          } catch (e) {}
          if (uidGid) {
            fs.chmodSync(targetDir, 0o700);
            execFileSync("chown", ["-R", linuxUser + ":" + linuxUser, targetDir]);
            execFileSync("git", ["init"], { cwd: targetDir, uid: uidGid.uid, gid: uidGid.gid, env: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
          } else {
            execFileSync("git", ["init"], { cwd: targetDir });
          }
        } else {
          execFileSync("git", ["init"], { cwd: targetDir });
        }
      } else {
        execFileSync("git", ["init"], { cwd: targetDir });
      }
    } catch (e) {
      try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (ce) {}
      return { ok: false, error: "Failed to create project: " + e.message };
    }
    // Register project - creator always becomes owner, default private
    var projectEntry = { path: targetDir, slug: slug, addedAt: Date.now(), visibility: "private" };
    if (wsUser && wsUser.id) {
      projectEntry.ownerId = wsUser.id;
    }
    relay.addProject(targetDir, slug, null, null, wsUser ? wsUser.id : null);
    config.projects.push(projectEntry);
    saveConfig(config);
    try { syncClayrc(config.projects); } catch (e) {}
    console.log("[daemon] Created project:", slug, "→", targetDir, "entry:", JSON.stringify({ ownerId: projectEntry.ownerId, visibility: projectEntry.visibility }));
    // OS users mode: grant ACL
    if (config.osUsers && wsUser && wsUser.linuxUser) {
      console.log("[daemon] Granting ACL:", targetDir, "→", wsUser.linuxUser);
      grantProjectAccess(targetDir, wsUser.linuxUser);
    } else if (config.osUsers) {
      console.log("[daemon] Skipping ACL grant: osUsers=true but linuxUser=", wsUser && wsUser.linuxUser);
    }
    // Auto-enroll in Clagentic: Lite if enabled and Lite is installed
    if (config.liteAutoEnroll) {
      var liteStatus = liteDetect.detectLite();
      if (liteStatus.installed && !liteDetect.isProjectEnrolled(targetDir)) {
        liteExecFile("clagentic-lite", ["enroll", targetDir], { timeout: 30000 }, function (err) {
          if (err) {
            console.warn("[daemon] Lite auto-enroll failed for " + targetDir + ":", err.message);
          } else {
            console.log("[daemon] Lite auto-enrolled project:", targetDir);
          }
        });
      }
    }
    relay.broadcastAll({
      type: "projects_updated",
      projects: relay.getProjects(),
      projectCount: config.projects.length,
      folderMeta: config.folderMeta || {},
    });
    return { ok: true, slug: slug };
  },
  onCloneProject: function (cloneUrl, wsUser, callback) {
    var os = require("os");
    var spawn = require("child_process").spawn;
    var execFileSync = require("child_process").execFileSync;
    var baseDir;
    if (config.osUsers) {
      baseDir = "/var/clagentic/projects";
    } else {
      baseDir = config.projectsDir || (function () {
        var newDir = path.join(REAL_HOME, "clagentic-projects");
        var oldDir = path.join(REAL_HOME, "clay-projects");
        // One-time migration: if new dir absent but old dir exists, rename it
        if (!fs.existsSync(newDir) && fs.existsSync(oldDir)) {
          try {
            fs.renameSync(oldDir, newDir);
            console.log("[config] Renamed " + oldDir + " → " + newDir);
          } catch (e) {
            // rename failed (e.g. cross-device) — fall back to old dir to avoid data loss
            return oldDir;
          }
        }
        return newDir;
      })();
    }
    try { fs.mkdirSync(baseDir, { recursive: true }); } catch (e) {}
    // Derive slug from repo URL
    var repoName = cloneUrl.replace(/\.git$/, "").split("/").pop() || "project";
    var slugs = config.projects.map(function (p) { return p.slug; });
    var slug = generateSlug(path.join(baseDir, repoName), slugs);
    var targetDir = path.join(baseDir, slug);
    // Clone as user to use their git credentials
    var spawnOpts = { cwd: baseDir };
    if (config.osUsers && wsUser && wsUser.linuxUser) {
      try {
        spawnOpts.uid = parseInt(execFileSync("id", ["-u", wsUser.linuxUser], { encoding: "utf8", stdio: "pipe" }).trim(), 10);
        spawnOpts.gid = parseInt(execFileSync("id", ["-g", wsUser.linuxUser], { encoding: "utf8", stdio: "pipe" }).trim(), 10);
        spawnOpts.env = Object.assign({}, process.env, {
          HOME: "/home/" + wsUser.linuxUser,
          USER: wsUser.linuxUser
        });
      } catch (e) {}
    }
    // Reserve targetDir atomically. mkdirSync (non-recursive) throws EEXIST
    // if the directory is already there, which also covers the case where
    // another concurrent clone_project of the same repo URL got there first
    // (the previous fs.existsSync + later mkdirSync had a TOCTOU gap that let
    // two callers both believe they owned targetDir — lr-1bdb item C). Only
    // the invocation whose mkdirSync actually created the directory is
    // allowed to rmSync it later on failure.
    var _createdTargetDir = false;
    try {
      fs.mkdirSync(targetDir, config.osUsers && wsUser && wsUser.linuxUser && spawnOpts.uid != null ? { mode: 0o700 } : undefined);
      _createdTargetDir = true;
    } catch (e) {
      if (e.code === "EEXIST") {
        callback({ ok: false, error: "Target directory already in use: " + targetDir });
      } else {
        callback({ ok: false, error: "Failed to prepare project directory: " + e.message });
      }
      return;
    }
    if (config.osUsers && wsUser && wsUser.linuxUser && spawnOpts.uid != null) {
      try {
        fs.chownSync(targetDir, spawnOpts.uid, spawnOpts.gid);
      } catch (e) {
        if (_createdTargetDir) { try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (ce) {} }
        callback({ ok: false, error: "Failed to prepare project directory: " + e.message });
        return;
      }
    }
    // Security: validate cloneUrl before passing to git spawn (lr-28b5).
    // validateCloneUrl rejects leading-dash (option injection) and non-allow-listed schemes.
    // buildCloneArgs adds the "--" argv terminator and GIT_ALLOW_PROTOCOL env restriction
    // as defence-in-depth even if future validation regressions let a bad URL through.
    var urlErr = validateCloneUrl(cloneUrl);
    if (urlErr) {
      callback({ ok: false, error: urlErr });
      return;
    }
    var cloneArgSpec = buildCloneArgs(cloneUrl, targetDir);
    spawnOpts.env = Object.assign({}, spawnOpts.env || process.env, cloneArgSpec.envOverrides);
    var proc = spawn("git", cloneArgSpec.args, spawnOpts);
    var stderrBuf = "";
    proc.stderr.on("data", function (chunk) { stderrBuf += chunk.toString(); });
    // 5 minute timeout
    var cloneTimeout = setTimeout(function () {
      proc.kill("SIGTERM");
    }, 5 * 60 * 1000);
    proc.on("close", function (code) {
      clearTimeout(cloneTimeout);
      if (code !== 0) {
        try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (ce) {}
        var errMsg = stderrBuf.trim().split("\n").pop() || "Clone failed (exit code " + code + ")";
        callback({ ok: false, error: errMsg });
        return;
      }
      // chown and restrict permissions if osUsers
      if (config.osUsers && wsUser && wsUser.linuxUser) {
        try {
          fs.chmodSync(targetDir, 0o700);
          execFileSync("chown", ["-R", wsUser.linuxUser + ":" + wsUser.linuxUser, targetDir]);
        } catch (e) {}
      }
      // Register project - creator always becomes owner
      // Creator always becomes owner, default private
      var projectEntry = { path: targetDir, slug: slug, addedAt: Date.now(), visibility: "private" };
      if (wsUser && wsUser.id) {
        projectEntry.ownerId = wsUser.id;
      }
      relay.addProject(targetDir, slug);
      config.projects.push(projectEntry);
      saveConfig(config);
      try { syncClayrc(config.projects); } catch (e) {}
      console.log("[daemon] Cloned project:", slug, "→", targetDir);
      if (config.osUsers && wsUser && wsUser.linuxUser) {
        grantProjectAccess(targetDir, wsUser.linuxUser);
      }
      relay.broadcastAll({
        type: "projects_updated",
        projects: relay.getProjects(),
        projectCount: config.projects.length,
      });
      callback({ ok: true, slug: slug });
    });
    proc.on("error", function (err) {
      clearTimeout(cloneTimeout);
      try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (ce) {}
      callback({ ok: false, error: "Failed to start git clone: " + err.message });
    });
  },
  onRemoveProject: function (slug, userId) {
    // Check if this is a worktree project (ephemeral)
    if (isWorktreeSlug(slug)) {
      var wtParent = slug.split("--")[0];
      var wtDirName = slug.split("--").slice(1).join("--");
      // Find parent project path
      var parentProject = null;
      for (var pi = 0; pi < config.projects.length; pi++) {
        if (config.projects[pi].slug === wtParent) { parentProject = config.projects[pi]; break; }
      }
      if (parentProject) {
        var rmResult = removeWorktree(parentProject.path, wtDirName);
        if (!rmResult.ok) {
          console.log("[daemon] Failed to remove worktree:", slug, rmResult.error);
          return { ok: false, error: rmResult.error };
        }
      }
      relay.removeProject(slug);
      unregisterWorktreeSlug(wtParent, slug);
      console.log("[daemon] Removed worktree (web):", slug);
      relay.broadcastAll({
        type: "projects_updated",
        projects: relay.getProjects(),
        projectCount: config.projects.length,
      });
      return { ok: true };
    }
    var found = null;
    for (var j = 0; j < config.projects.length; j++) {
      if (config.projects[j].slug === slug) { found = config.projects[j]; break; }
    }
    if (!found) return { ok: false, error: "Project not found" };
    // Cascade remove worktrees belonging to this parent
    cleanupWorktreesForParent(relay, slug);
    // Save to removedProjects for re-add functionality
    if (!config.removedProjects) config.removedProjects = [];
    config.removedProjects.push({
      path: found.path,
      title: found.title || null,
      icon: found.icon || null,
      userId: userId || null,
      removedAt: Date.now(),
    });
    // Cap at 20 entries (oldest first)
    if (config.removedProjects.length > 20) {
      config.removedProjects = config.removedProjects.slice(config.removedProjects.length - 20);
    }
    relay.removeProject(slug);
    config.projects = config.projects.filter(function (p) { return p.slug !== slug; });
    saveConfig(config);
    // Remove from .clayrc so it doesn't appear in restore prompt
    if (found.path) { try { removeFromClayrc(found.path); } catch (e) {} }
    try { syncClayrc(config.projects); } catch (e) {}
    console.log("[daemon] Removed project (web):", slug);
    relay.broadcastAll({
      type: "projects_updated",
      projects: relay.getProjects(),
      projectCount: config.projects.length,
      folderMeta: config.folderMeta || {},
    });
    return { ok: true };
  },
  onReorderProjects: function (slugs) {
    // Build a slug->project map from current projects
    var projectMap = {};
    for (var j = 0; j < config.projects.length; j++) {
      projectMap[config.projects[j].slug] = config.projects[j];
    }
    // Reorder based on the slugs array
    var reordered = [];
    for (var k = 0; k < slugs.length; k++) {
      if (projectMap[slugs[k]]) {
        reordered.push(projectMap[slugs[k]]);
        delete projectMap[slugs[k]];
      }
    }
    // Append any remaining projects not in slugs (safety)
    var remaining = Object.keys(projectMap);
    for (var m = 0; m < remaining.length; m++) {
      reordered.push(projectMap[remaining[m]]);
    }
    config.projects = reordered;
    saveConfig(config);
    try { syncClayrc(config.projects); } catch (e) {}
    // Also reorder the in-memory Map so getProjects() returns the new order
    relay.reorderProjects(slugs);
    relay.broadcastAll({
      type: "projects_updated",
      projects: relay.getProjects(),
      projectCount: config.projects.length,
      folderMeta: config.folderMeta || {},
    });
    return { ok: true };
  },
  onSetProjectTitle: function (slug, newTitle) {
    relay.setProjectTitle(slug, newTitle);
    for (var ti = 0; ti < config.projects.length; ti++) {
      if (config.projects[ti].slug === slug) {
        if (newTitle) {
          config.projects[ti].title = newTitle;
        } else {
          delete config.projects[ti].title;
        }
        break;
      }
    }
    saveConfig(config);
    try { syncClayrc(config.projects); } catch (e) {}
    relay.broadcastAll({
      type: "projects_updated",
      projects: relay.getProjects(),
      projectCount: config.projects.length,
      folderMeta: config.folderMeta || {},
    });
    return { ok: true };
  },
  onSetProjectIcon: function (slug, newIcon) {
    relay.setProjectIcon(slug, newIcon);
    for (var ii = 0; ii < config.projects.length; ii++) {
      if (config.projects[ii].slug === slug) {
        if (newIcon) {
          config.projects[ii].icon = newIcon;
        } else {
          delete config.projects[ii].icon;
        }
        break;
      }
    }
    saveConfig(config);
    try { syncClayrc(config.projects); } catch (e) {}
    relay.broadcastAll({
      type: "projects_updated",
      projects: relay.getProjects(),
      projectCount: config.projects.length,
      folderMeta: config.folderMeta || {},
    });
    return { ok: true };
  },
  onSetProjectPreferredAgent: function (slug, agent) {
    relay.setProjectPreferredAgent(slug, agent);
    for (var pai = 0; pai < config.projects.length; pai++) {
      if (config.projects[pai].slug === slug) {
        if (agent) {
          config.projects[pai].preferredAgent = agent;
        } else {
          delete config.projects[pai].preferredAgent;
        }
        break;
      }
    }
    saveConfig(config);
    relay.broadcastAll({
      type: "projects_updated",
      projects: relay.getProjects(),
      projectCount: config.projects.length,
      folderMeta: config.folderMeta || {},
    });
    return { ok: true };
  },
  onSetProjectFolder: function (slug, folderName) {
    relay.setProjectFolder(slug, folderName);
    for (var fpi = 0; fpi < config.projects.length; fpi++) {
      if (config.projects[fpi].slug === slug) {
        if (folderName) {
          config.projects[fpi].folderName = folderName;
        } else {
          delete config.projects[fpi].folderName;
        }
        break;
      }
    }
    saveConfig(config);
    relay.broadcastAll({
      type: "projects_updated",
      projects: relay.getProjects(),
      projectCount: config.projects.length,
      folderMeta: config.folderMeta || {},
    });
    return { ok: true };
  },
  onRenameProjectFolder: function (oldName, newName) {
    relay.setProjectFolderName(oldName, newName);
    if (!config.folderMeta) config.folderMeta = {};
    // Move icon from oldName to newName
    if (config.folderMeta[oldName]) {
      config.folderMeta[newName] = config.folderMeta[oldName];
      delete config.folderMeta[oldName];
    }
    for (var rfi = 0; rfi < config.projects.length; rfi++) {
      if (config.projects[rfi].folderName === oldName) {
        config.projects[rfi].folderName = newName;
      }
    }
    saveConfig(config);
    relay.broadcastAll({
      type: "projects_updated",
      projects: relay.getProjects(),
      projectCount: config.projects.length,
      folderMeta: config.folderMeta || {},
    });
    return { ok: true };
  },
  onSetFolderIcon: function (folderName, icon) {
    if (!config.folderMeta) config.folderMeta = {};
    if (!config.folderMeta[folderName]) config.folderMeta[folderName] = {};
    if (icon) {
      config.folderMeta[folderName].icon = icon;
    } else {
      delete config.folderMeta[folderName].icon;
    }
    saveConfig(config);
    relay.broadcastAll({
      type: "projects_updated",
      projects: relay.getProjects(),
      projectCount: config.projects.length,
      folderMeta: config.folderMeta || {},
    });
    return { ok: true };
  },
  // Rename a custom-icon upload: oldSlug -> newSlug. Rewrites every
  // config.projects[].icon and config.folderMeta[].icon reference that
  // pointed at the old ":oldSlug:" sentinel, renames the file on disk, and
  // broadcasts the updated project/folder list — all as one atomic op
  // (lr-d1d9, LOCKED DECISION: rewrite references, not block-on-in-use).
  // Doing this as a WS op (rather than a bare HTTP route) is what makes the
  // file-rename + reference-rewrite + broadcast atomic: the daemon holds both
  // the on-disk custom-emoji file and the in-memory config.projects/folderMeta
  // that reference it, so there's no window where they can observably diverge.
  onRenameCustomIcon: function (oldSlug, newSlug) {
    if (typeof oldSlug !== "string" || typeof newSlug !== "string") {
      return { ok: false, error: "Missing oldSlug or newSlug" };
    }
    if (!CUSTOM_ICON_SLUG_RE.test(oldSlug) || !CUSTOM_ICON_SLUG_RE.test(newSlug)) {
      return { ok: false, error: "Invalid slug" };
    }
    if (oldSlug === newSlug) {
      return { ok: false, error: "New slug must differ from the current slug" };
    }

    var customEmojiDir = path.join(CONFIG_DIR, "custom-emoji");
    var oldFile = null;
    var oldExt = null;
    var newSlugExists = false;
    try {
      // Scan the FULL directory (no early break) — the newSlug collision
      // check must run even when oldSlug's file happens to sort before
      // newSlug's file in readdirSync order (e.g. alphabetically).
      var existingFiles = fs.readdirSync(customEmojiDir);
      for (var efi = 0; efi < existingFiles.length; efi++) {
        var ef = existingFiles[efi];
        var efExt = path.extname(ef).slice(1);
        if (!CUSTOM_EMOJI_CT[efExt]) continue;
        var efBasename = path.basename(ef, "." + efExt);
        if (efBasename === oldSlug) { oldFile = ef; oldExt = efExt; }
        // A 409 on newSlug must catch a collision regardless of extension.
        if (efBasename === newSlug) { newSlugExists = true; }
      }
    } catch (e) {
      return { ok: false, error: "Custom icon storage unavailable" };
    }
    if (newSlugExists) {
      return { ok: false, error: "A custom icon named \"" + newSlug + "\" already exists" };
    }
    if (!oldFile) {
      return { ok: false, error: "Custom icon \"" + oldSlug + "\" not found" };
    }

    // Defense-in-depth: resolve both paths and confirm they stay within
    // customEmojiDir, mirroring the safePath/resolve-prefix guard used by the
    // existing POST/GET/DELETE routes in server-settings.js.
    var oldPath = path.join(customEmojiDir, oldFile);
    var newFile = newSlug + "." + oldExt;
    var newPath = path.join(customEmojiDir, newFile);
    var resolvedOld = path.resolve(customEmojiDir, oldFile);
    var resolvedNew = path.resolve(customEmojiDir, newFile);
    if (!resolvedOld.startsWith(customEmojiDir + path.sep) || !resolvedNew.startsWith(customEmojiDir + path.sep)) {
      return { ok: false, error: "Invalid path" };
    }

    try {
      fs.renameSync(oldPath, newPath);
    } catch (e) {
      return { ok: false, error: "Rename failed: " + e.message };
    }

    // Rewrite every reference to the old sentinel across projects + folders.
    var oldSentinel = ":" + oldSlug + ":";
    var newSentinel = ":" + newSlug + ":";
    for (var pi = 0; pi < config.projects.length; pi++) {
      if (config.projects[pi].icon === oldSentinel) {
        config.projects[pi].icon = newSentinel;
      }
    }
    if (config.folderMeta) {
      var folderNames = Object.keys(config.folderMeta);
      for (var fni = 0; fni < folderNames.length; fni++) {
        var fMeta = config.folderMeta[folderNames[fni]];
        if (fMeta && fMeta.icon === oldSentinel) {
          fMeta.icon = newSentinel;
        }
      }
    }
    saveConfig(config);
    try { syncClayrc(config.projects); } catch (e) {}
    relay.broadcastAll({
      type: "projects_updated",
      projects: relay.getProjects(),
      projectCount: config.projects.length,
      folderMeta: config.folderMeta || {},
    });
    return { ok: true, slug: newSlug, url: "/api/custom-emoji/" + newSlug };
  },
  onProjectOwnerChanged: function (slug, ownerId) {
    console.log("[daemon] onProjectOwnerChanged:", slug, "→", ownerId);
    var oldOwnerId = null;
    var projectIdx = -1;
    for (var oi = 0; oi < config.projects.length; oi++) {
      if (config.projects[oi].slug === slug) {
        oldOwnerId = config.projects[oi].ownerId || null;
        projectIdx = oi;
        if (ownerId) {
          config.projects[oi].ownerId = ownerId;
        } else {
          delete config.projects[oi].ownerId;
        }
        break;
      }
    }
    saveConfig(config);
    // OS users mode: revoke old owner ACL, grant new owner ACL
    if (config.osUsers && projectIdx >= 0) {
      var projectPath = config.projects[projectIdx].path;
      var allowed = config.projects[projectIdx].allowedUsers || [];
      var visibility = config.projects[projectIdx].visibility || "public";
      // Revoke old owner (if not in allowedUsers and project is not public)
      if (oldOwnerId && oldOwnerId !== ownerId) {
        var oldOwner = usersModule.findUserById(oldOwnerId);
        if (oldOwner && oldOwner.linuxUser && allowed.indexOf(oldOwnerId) === -1 && visibility !== "public") {
          revokeProjectAccess(projectPath, oldOwner.linuxUser);
        }
      }
      // Grant new owner
      if (ownerId) {
        var newOwner = usersModule.findUserById(ownerId);
        console.log("[daemon] Owner grant ACL:", ownerId, "linuxUser:", newOwner && newOwner.linuxUser, "path:", projectPath);
        if (newOwner && newOwner.linuxUser) {
          grantProjectAccess(projectPath, newOwner.linuxUser);
        }
      }
    }
    relay.broadcastAll({
      type: "projects_updated",
      projects: relay.getProjects(),
      projectCount: config.projects.length,
      folderMeta: config.folderMeta || {},
    });
    return { ok: true };
  },
  onGetProjectEnv: function (slug) {
    for (var ei = 0; ei < config.projects.length; ei++) {
      if (config.projects[ei].slug === slug) {
        return { envrc: config.projects[ei].envrc || "" };
      }
    }
    return { envrc: "" };
  },
  onSetProjectEnv: function (slug, envrc) {
    for (var ei = 0; ei < config.projects.length; ei++) {
      if (config.projects[ei].slug === slug) {
        if (envrc) {
          config.projects[ei].envrc = envrc;
        } else {
          delete config.projects[ei].envrc;
        }
        saveConfig(config);
        return { ok: true };
      }
    }
    return { ok: false, error: "Project not found" };
  },
  onGetSharedEnv: function () {
    return { envrc: config.sharedEnv || "" };
  },
  onSetSharedEnv: function (envrc) {
    if (envrc) {
      config.sharedEnv = envrc;
    } else {
      delete config.sharedEnv;
    }
    saveConfig(config);
    return { ok: true };
  },
  onGetServerDefaultEffort: function () {
    return { effort: config.defaultEffort || null };
  },
  onSetServerDefaultEffort: function (effort) {
    if (effort) {
      config.defaultEffort = effort;
    } else {
      delete config.defaultEffort;
    }
    saveConfig(config);
    return { ok: true };
  },
  onGetProjectDefaultEffort: function (slug) {
    for (var i = 0; i < config.projects.length; i++) {
      if (config.projects[i].slug === slug) {
        return { effort: config.projects[i].defaultEffort || null };
      }
    }
    return { effort: null };
  },
  onSetProjectDefaultEffort: function (slug, effort) {
    for (var i = 0; i < config.projects.length; i++) {
      if (config.projects[i].slug === slug) {
        if (effort) {
          config.projects[i].defaultEffort = effort;
        } else {
          delete config.projects[i].defaultEffort;
        }
        saveConfig(config);
        return { ok: true };
      }
    }
    return { ok: false, error: "Project not found" };
  },
  onGetServerDefaultModel: function () {
    return { model: config.defaultModel || null };
  },
  onSetServerDefaultModel: function (model) {
    if (model) {
      config.defaultModel = model;
    } else {
      delete config.defaultModel;
    }
    saveConfig(config);
    return { ok: true };
  },
  onGetProjectDefaultModel: function (slug) {
    for (var i = 0; i < config.projects.length; i++) {
      if (config.projects[i].slug === slug) {
        return { model: config.projects[i].defaultModel || null };
      }
    }
    return { model: null };
  },
  onSetProjectDefaultModel: function (slug, model) {
    for (var i = 0; i < config.projects.length; i++) {
      if (config.projects[i].slug === slug) {
        if (model) {
          config.projects[i].defaultModel = model;
        } else {
          delete config.projects[i].defaultModel;
        }
        saveConfig(config);
        return { ok: true };
      }
    }
    return { ok: false, error: "Project not found" };
  },
  onGetProjectMcpServers: function (slug) {
    for (var i = 0; i < config.projects.length; i++) {
      if (config.projects[i].slug === slug) {
        return config.projects[i].enabledMcpServers || [];
      }
    }
    return [];
  },
  onSetProjectMcpServers: function (slug, servers) {
    for (var i = 0; i < config.projects.length; i++) {
      if (config.projects[i].slug === slug) {
        if (servers && servers.length > 0) {
          config.projects[i].enabledMcpServers = servers;
        } else {
          delete config.projects[i].enabledMcpServers;
        }
        saveConfig(config);
        return;
      }
    }
  },
  onGetServerDefaultMode: function () {
    return { mode: config.defaultMode || null };
  },
  onSetServerDefaultMode: function (mode) {
    if (mode) {
      config.defaultMode = mode;
    } else {
      delete config.defaultMode;
    }
    saveConfig(config);
    return { ok: true };
  },
  onGetProjectDefaultMode: function (slug) {
    for (var i = 0; i < config.projects.length; i++) {
      if (config.projects[i].slug === slug) {
        return { mode: config.projects[i].defaultMode || null };
      }
    }
    return { mode: null };
  },
  onSetProjectDefaultMode: function (slug, mode) {
    for (var i = 0; i < config.projects.length; i++) {
      if (config.projects[i].slug === slug) {
        if (mode) {
          config.projects[i].defaultMode = mode;
        } else {
          delete config.projects[i].defaultMode;
        }
        saveConfig(config);
        return { ok: true };
      }
    }
    return { ok: false, error: "Project not found" };
  },
  onGetServerDefaultBetas: function () {
    return { betas: config.defaultBetas || [] };
  },
  onSetServerDefaultBetas: function (betas) {
    if (betas && betas.length > 0) {
      config.defaultBetas = betas;
    } else {
      delete config.defaultBetas;
    }
    saveConfig(config);
    return { ok: true };
  },
  onGetProjectDefaultBetas: function (slug) {
    for (var i = 0; i < config.projects.length; i++) {
      if (config.projects[i].slug === slug) {
        return { betas: config.projects[i].defaultBetas || [] };
      }
    }
    return { betas: [] };
  },
  onSetProjectDefaultBetas: function (slug, betas) {
    for (var i = 0; i < config.projects.length; i++) {
      if (config.projects[i].slug === slug) {
        if (betas && betas.length > 0) {
          config.projects[i].defaultBetas = betas;
        } else {
          delete config.projects[i].defaultBetas;
        }
        saveConfig(config);
        return { ok: true };
      }
    }
    return { ok: false, error: "Project not found" };
  },
  onGetDaemonConfig: function () {
    return {
      port: config.port,
      tls: !!tlsOptions,
      debug: !!config.debug,
      headless: !!config.headless,
      keepAwake: !!config.keepAwake,
      autoContinueOnRateLimit: !!config.autoContinueOnRateLimit,
      chatLayout: config.chatLayout || "channel",
      themeMode: config.themeMode || null,
      themeBrand: config.themeBrand || null,
      pinEnabled: !!config.pinHash,
      platform: process.platform,
      hostname: os2.hostname(),
      lanIp: lanIp || null,
      updateChannel: config.updateChannel || "stable",
      imageRetentionDays: config.imageRetentionDays !== undefined ? config.imageRetentionDays : 7,
      memAvailableMinMB: config.memAvailableMinMB !== undefined ? config.memAvailableMinMB : DEFAULT_MEM_AVAILABLE_MIN_MB,
      tokensPerMbHeadroom: config.tokensPerMbHeadroom !== undefined ? config.tokensPerMbHeadroom : DEFAULT_TOKENS_PER_MB_HEADROOM,
      liteAutoEnroll: !!config.liteAutoEnroll,
    };
  },
  onSetLiteAutoEnroll: function (value) {
    var want = !!value;
    config.liteAutoEnroll = want;
    saveConfig(config);
    console.log("[daemon] Lite auto-enroll:", want, "(web)");
    return { ok: true, liteAutoEnroll: want };
  },
  onSetImageRetention: function (days) {
    var d = parseInt(days, 10);
    if (isNaN(d) || d < 0) d = 7;
    config.imageRetentionDays = d;
    saveConfig(config);
    console.log("[daemon] Image retention:", d === 0 ? "forever" : d + " days");
    return { ok: true, days: d };
  },
  onSetUpdateChannel: function (channel) {
    config.updateChannel = channel === "beta" ? "beta" : "stable";
    saveConfig(config);
    console.log("[daemon] Update channel:", config.updateChannel, "(web)");
    return { ok: true, updateChannel: config.updateChannel };
  },
  // onSetPin intentionally removed — single-user PIN mode no longer exists (lr-ec2d).
  // Individual user PINs are managed via users.js / server-admin.js.
  onSetPin: null,
  onSetChatLayout: function (layout) {
    var val = (layout === "bubble") ? "bubble" : "channel";
    config.chatLayout = val;
    saveConfig(config);
    console.log("[daemon] Chat layout:", val, "(web)");
    return { ok: true, chatLayout: val };
  },
  onSetThemeMode: function (mode) {
    var val = (mode === "light" || mode === "dark") ? mode : null;
    config.themeMode = val;
    saveConfig(config);
    console.log("[daemon] Theme mode:", val, "(web)");
    return { ok: true, themeMode: val };
  },
  onSetThemeBrand: function (brand) {
    var val = (brand === "classic" || brand === "clagentic") ? brand : null;
    config.themeBrand = val;
    saveConfig(config);
    console.log("[daemon] Theme brand:", val, "(web)");
    return { ok: true, themeBrand: val };
  },
  onSetAutoContinue: function (value) {
    var want = !!value;
    config.autoContinueOnRateLimit = want;
    saveConfig(config);
    console.log("[daemon] Auto-continue on rate limit:", want, "(web)");
    return { ok: true, autoContinueOnRateLimit: want };
  },
  onSetMemAvailableThreshold: function (mb) {
    var val = parseInt(mb, 10);
    if (isNaN(val) || val < 0) val = DEFAULT_MEM_AVAILABLE_MIN_MB;
    config.memAvailableMinMB = val;
    saveConfig(config);
    console.log("[daemon] MemAvailable threshold:", val, "MB (web)");
    return { ok: true, memAvailableMinMB: val };
  },
  onSetTokensPerMbHeadroom: function (tpm) {
    var val = parseInt(tpm, 10);
    // Valid range: 10–500 tokens/MB; outside that range reset to default.
    if (isNaN(val) || val < 10 || val > 500) val = DEFAULT_TOKENS_PER_MB_HEADROOM;
    config.tokensPerMbHeadroom = val;
    saveConfig(config);
    console.log("[daemon] Tokens per MB headroom:", val, "(web)");
    return { ok: true, tokensPerMbHeadroom: val };
  },
  onGetToolPalettes: function () {
    return config.toolPalettes || {};
  },
  onSetToolPalette: function (paletteName, order, hidden) {
    if (paletteName !== "session") {
      return { error: "Unknown palette" };
    }
    var safeOrder = Array.isArray(order)
      ? order.filter(function (s) { return typeof s === "string"; })
      : [];
    var safeHidden = Array.isArray(hidden)
      ? hidden.filter(function (s) { return typeof s === "string"; })
      : [];
    if (!config.toolPalettes) config.toolPalettes = {};
    config.toolPalettes[paletteName] = { order: safeOrder, hidden: safeHidden };
    saveConfig(config);
    return { ok: true, palette: paletteName, order: safeOrder, hidden: safeHidden };
  },
  onSetKeepAwake: function (value) {
    var want = !!value;
    config.keepAwake = want;
    saveConfig(config);
    if (want && !caffeinateProc && process.platform === "darwin") {
      try {
        var { spawn: spawnCaff } = require("child_process");
        caffeinateProc = spawnCaff("caffeinate", ["-di"], { stdio: "ignore", detached: false });
        caffeinateProc.on("error", function () { caffeinateProc = null; });
      } catch (e) {}
    } else if (!want && caffeinateProc) {
      try { caffeinateProc.kill(); } catch (e) {}
      caffeinateProc = null;
    }
    console.log("[daemon] Keep awake:", want, "(web)");
    return { ok: true, keepAwake: want };
  },
  onShutdown: function () {
    console.log("[daemon] Shutdown requested via web UI");
    gracefulShutdown();
  },
  onRestart: function () {
    console.log("[daemon] Restart requested via web UI");
    spawnAndRestart();
  },
  onSetProjectVisibility: function (slug, visibility) {
    for (var i = 0; i < config.projects.length; i++) {
      if (config.projects[i].slug === slug) {
        var prevVisibility = config.projects[i].visibility || "public";
        config.projects[i].visibility = visibility;
        saveConfig(config);
        console.log("[daemon] Set project visibility:", slug, "→", visibility);
        if (config.osUsers) {
          var projectPath = config.projects[i].path;
          var ownerId = config.projects[i].ownerId || null;
          // When switching to public: grant ACL to ALL users
          if (visibility === "public" && prevVisibility !== "public") {
            grantAllUsersAccess(projectPath, usersModule);
          }
          // When switching to private: revoke ACLs for users not in allowedUsers and not the owner
          if (visibility === "private" && prevVisibility !== "private") {
            var allowed = config.projects[i].allowedUsers || [];
            var allUsers = usersModule.getAllUsers();
            for (var u = 0; u < allUsers.length; u++) {
              var usr = allUsers[u];
              if (usr.role === "admin") continue;
              if (usr.id === ownerId) continue;
              if (usr.linuxUser && allowed.indexOf(usr.id) === -1) {
                revokeProjectAccess(projectPath, usr.linuxUser);
              }
            }
          }
        }
        return { ok: true };
      }
    }
    return { error: "Project not found" };
  },
  onSetProjectAllowedUsers: function (slug, allowedUsers) {
    for (var i = 0; i < config.projects.length; i++) {
      if (config.projects[i].slug === slug) {
        var prev = config.projects[i].allowedUsers || [];
        config.projects[i].allowedUsers = allowedUsers;
        saveConfig(config);
        console.log("[daemon] Set project allowed users:", slug, "→", allowedUsers.length, "users");
        // OS users mode: sync ACLs for added/removed users
        if (config.osUsers) {
          var projectPath = config.projects[i].path;
          // Grant access to newly added users
          for (var a = 0; a < allowedUsers.length; a++) {
            if (prev.indexOf(allowedUsers[a]) === -1) {
              var addedUser = usersModule.findUserById(allowedUsers[a]);
              if (addedUser && addedUser.linuxUser) {
                grantProjectAccess(projectPath, addedUser.linuxUser);
              }
            }
          }
          // Revoke access from removed users
          for (var r = 0; r < prev.length; r++) {
            if (allowedUsers.indexOf(prev[r]) === -1) {
              var removedUser = usersModule.findUserById(prev[r]);
              if (removedUser && removedUser.linuxUser) {
                revokeProjectAccess(projectPath, removedUser.linuxUser);
              }
            }
          }
        }
        return { ok: true };
      }
    }
    return { error: "Project not found" };
  },
  onGetProjectAccess: function (slug) {
    for (var i = 0; i < config.projects.length; i++) {
      if (config.projects[i].slug === slug) {
        return {
          slug: slug,
          visibility: config.projects[i].visibility || (config.osUsers ? "private" : "public"),
          allowedUsers: config.projects[i].allowedUsers || [],
          ownerId: config.projects[i].ownerId || null,
        };
      }
    }
    return { error: "Project not found" };
  },
  onUserProvisioned: function (userId, linuxUser) {
    // Grant ACL on all public projects to the newly provisioned user
    if (!config.osUsers || !linuxUser) return;
    for (var i = 0; i < config.projects.length; i++) {
      var proj = config.projects[i];
      var visibility = proj.visibility || "public";
      if (visibility === "public") {
        grantProjectAccess(proj.path, linuxUser);
      }
    }
  },
  onUserDeleted: function (userId, linuxUser) {
    // Deactivate the Linux account when a user is deleted
    if (!config.osUsers || !linuxUser) return;
    deactivateLinuxUser(linuxUser);
  },
  onCreateWorktree: function (parentSlug, branchName, dirName, baseBranch) {
    // Find the parent project
    var parent = null;
    for (var j = 0; j < config.projects.length; j++) {
      if (config.projects[j].slug === parentSlug) { parent = config.projects[j]; break; }
    }
    if (!parent) return { ok: false, error: "Parent project not found" };
    if (isWorktree(parent.path)) return { ok: false, error: "Cannot create worktrees from a worktree project" };
    var result = createWorktree(parent.path, branchName, dirName, baseBranch);
    if (!result.ok) return result;
    // Register the new worktree as ephemeral project
    var wtSlug = parentSlug + "--" + dirName;
    var wtMeta = { parentSlug: parentSlug, branch: branchName, accessible: true };
    relay.addProject(result.path, wtSlug, branchName, parent.icon, parent.ownerId, wtMeta);
    registerWorktreeSlug(parentSlug, wtSlug);
    console.log("[daemon] Created worktree:", wtSlug, "->", result.path);
    relay.broadcastAll({
      type: "projects_updated",
      projects: relay.getProjects(),
      projectCount: config.projects.length,
      folderMeta: config.folderMeta || {},
    });
    return { ok: true, slug: wtSlug, path: result.path };
  },
});

// Periodic stale-code check: re-emit the warning every 60 s so it appears in
// journalctl even if the operator wasn't watching at startup time.
var staleCheckHandle = setInterval(function () {
  if (checkStaleInodes()) {
    console.warn('[daemon] WARNING: this process is serving STALE code — on-disk JS has been replaced');
    console.warn('[daemon] WARNING: restart the daemon to load the new build:');
    console.warn('[daemon] WARNING:   systemctl restart clagentic-console');
    console.warn('[daemon] WARNING:   — or — clagentic-console --restart');
  }
}, 60 * 1000);
if (staleCheckHandle && typeof staleCheckHandle.unref === "function") {
  staleCheckHandle.unref();
}

var IDLE_MS = Number(process.env.CLAY_CODEX_IDLE_MS) || 5 * 60 * 1000;
var REAP_MS = Number(process.env.CLAY_CODEX_REAPER_MS) || 60 * 1000;
var reaperHandle = setInterval(function () {
  if (!relay || typeof relay.forEachProject !== "function") return;
  relay.forEachProject(function (ctx) {
    try {
      if (ctx && ctx.adapters && ctx.adapters.codex && typeof ctx.adapters.codex.shutdownIfIdle === "function") {
        var result = ctx.adapters.codex.shutdownIfIdle(IDLE_MS);
        if (result && typeof result.catch === "function") {
          result.catch(function (e) {
            console.error("[daemon] Codex idle reclaim failed:", e && e.message ? e.message : e);
          });
        }
      }
    } catch (e) {}
  });
}, REAP_MS);
if (reaperHandle && typeof reaperHandle.unref === "function") {
  reaperHandle.unref();
}

function stopCodexReaper() {
  if (reaperHandle) {
    clearInterval(reaperHandle);
    reaperHandle = null;
  }
  if (staleCheckHandle) {
    clearInterval(staleCheckHandle);
    staleCheckHandle = null;
  }
  if (_memoryWatcher) {
    _memoryWatcher.stop();
    _memoryWatcher = null;
  }
}

function shutdownProjects() {
  stopCodexReaper();
  try {
    var result = relay.destroyAll();
    if (result && typeof result.then === "function") {
      return result;
    }
    return Promise.resolve(true);
  } catch (e) {
    return Promise.reject(e);
  }
}

// Worktree tracking extracted to daemon-projects.js

// --- Register projects ---
var projects = config.projects || [];
for (var i = 0; i < projects.length; i++) {
  var p = projects[i];
  if (fs.existsSync(p.path)) {
    console.log("[daemon] Adding project:", p.slug, "→", p.path);
    relay.addProject(p.path, p.slug, p.title, p.icon, p.ownerId, null, { preferredAgent: p.preferredAgent || null, folderName: p.folderName || null });
    // Discover and register worktrees for this project
    scanAndRegisterWorktrees(relay, p.path, p.slug, p.icon, p.ownerId);
  } else {
    console.log("[daemon] Skipping missing project:", p.path);
  }
}

// Sync ~/.clayrc on startup
try { syncClayrc(config.projects); } catch (e) {}

// Auto-enroll in Clagentic: Lite at startup if liteAutoEnroll is enabled
if (config.liteAutoEnroll) {
  (function () {
    var liteStatus = liteDetect.detectLite();
    if (!liteStatus.installed) return;
    var registeredProjects = config.projects || [];
    for (var li = 0; li < registeredProjects.length; li++) {
      var lp = registeredProjects[li];
      if (lp.path && !liteDetect.isProjectEnrolled(lp.path)) {
        (function (projectPath) {
          liteExecFile("clagentic-lite", ["enroll", projectPath], { timeout: 30000 }, function (err) {
            if (err) {
              console.warn("[daemon] Lite startup auto-enroll failed for " + projectPath + ":", err.message);
            } else {
              console.log("[daemon] Lite startup auto-enrolled:", projectPath);
            }
          });
        })(lp.path);
      }
    }
  })();
}

// --- IPC server ---
// Clean up stale socket/config left by a previously killed daemon. Only
// clears config for a PID that is actually dead -- it must never assume a
// PID mismatch alone means staleness. createIPCServer's own connect-probe
// (below) is what actually refuses startup if a live daemon still answers
// on the socket (lr-1bdb item A).
var existingConfig = loadConfig();
if (existingConfig && existingConfig.pid && existingConfig.pid !== process.pid) {
  if (!isPidAlive(existingConfig.pid)) {
    console.log("[daemon] Clearing stale config from dead PID " + existingConfig.pid);
    clearStaleConfig();
  }
}
var ipc = createIPCServer(socketPath(), function (msg) {
  console.log("[daemon] IPC:", msg.cmd);
  switch (msg.cmd) {
    case "add_project": {
      if (!msg.path) return { ok: false, error: "missing path" };
      var absPath = path.resolve(msg.path);
      // Check if already registered
      for (var j = 0; j < config.projects.length; j++) {
        if (config.projects[j].path === absPath) {
          return { ok: true, slug: config.projects[j].slug, existing: true };
        }
      }
      var slugs = config.projects.map(function (p) { return p.slug; });
      var slug = generateSlug(absPath, slugs);
      relay.addProject(absPath, slug);
      config.projects.push({ path: absPath, slug: slug, addedAt: Date.now(), visibility: "private" });
      saveConfig(config);
      try { syncClayrc(config.projects); } catch (e) {}
      console.log("[daemon] Added project:", slug, "→", absPath);
      // Discover and register worktrees for the new project
      scanAndRegisterWorktrees(relay, absPath, slug, null, null);
      relay.broadcastAll({
        type: "projects_updated",
        projects: relay.getProjects(),
        projectCount: config.projects.length,
      });
      return { ok: true, slug: slug };
    }

    case "remove_project": {
      if (!msg.path && !msg.slug) return { ok: false, error: "missing path or slug" };
      var target = msg.slug;
      if (!target) {
        var abs = path.resolve(msg.path);
        for (var k = 0; k < config.projects.length; k++) {
          if (config.projects[k].path === abs) {
            target = config.projects[k].slug;
            break;
          }
        }
      }
      if (!target) return { ok: false, error: "project not found" };
      relay.removeProject(target);
      config.projects = config.projects.filter(function (p) { return p.slug !== target; });
      saveConfig(config);
      try { syncClayrc(config.projects); } catch (e) {}
      console.log("[daemon] Removed project:", target);
      relay.broadcastAll({
        type: "projects_updated",
        projects: relay.getProjects(),
        projectCount: config.projects.length,
      });
      return { ok: true };
    }

    case "get_status":
      return {
        ok: true,
        pid: process.pid,
        port: config.port,
        tls: !!tlsOptions,
        keepAwake: !!config.keepAwake,
        osUsers: !!config.osUsers,
        projects: relay.getProjects(),
        uptime: process.uptime(),
      };

    case "set_pin": {
      config.pinHash = msg.pinHash || null;
      relay.setAuthToken(config.pinHash);
      saveConfig(config);
      return { ok: true };
    }

    case "set_project_title": {
      if (!msg.slug) return { ok: false, error: "missing slug" };
      var newTitle = msg.title || null;
      relay.setProjectTitle(msg.slug, newTitle);
      for (var ti = 0; ti < config.projects.length; ti++) {
        if (config.projects[ti].slug === msg.slug) {
          if (newTitle) {
            config.projects[ti].title = newTitle;
          } else {
            delete config.projects[ti].title;
          }
          break;
        }
      }
      saveConfig(config);
      try { syncClayrc(config.projects); } catch (e) {}
      console.log("[daemon] Project title:", msg.slug, "→", newTitle || "(default)");
      relay.broadcastAll({
        type: "projects_updated",
        projects: relay.getProjects(),
        projectCount: config.projects.length,
      });
      return { ok: true };
    }

    case "set_os_users": {
      var enableOsUsers = !!msg.value;
      if (enableOsUsers) {
        // Pre-flight: check if setfacl is available
        var aclCheck = checkAclSupport();
        if (!aclCheck.available) {
          return { error: "acl_not_installed", installCmd: aclCheck.installCmd };
        }
      }
      config.osUsers = enableOsUsers;
      saveConfig(config);
      console.log("[daemon] OS users:", enableOsUsers);
      // Provisioning is handled by CLI (which has terminal access for progress).
      // Daemon only saves the flag. On next restart, daemon will pick it up.
      return { ok: true };
    }

    case "set_auto_continue": {
      var acWant = !!msg.value;
      config.autoContinueOnRateLimit = acWant;
      saveConfig(config);
      console.log("[daemon] Auto-continue on rate limit:", acWant, "(cli)");
      return { ok: true, autoContinueOnRateLimit: acWant };
    }

    case "set_keep_awake": {
      var want = !!msg.value;
      config.keepAwake = want;
      saveConfig(config);
      if (want && !caffeinateProc && process.platform === "darwin") {
        try {
          var { spawn: spawnCaff } = require("child_process");
          caffeinateProc = spawnCaff("caffeinate", ["-di"], { stdio: "ignore", detached: false });
          caffeinateProc.on("error", function () { caffeinateProc = null; });
        } catch (e) {}
      } else if (!want && caffeinateProc) {
        try { caffeinateProc.kill(); } catch (e) {}
        caffeinateProc = null;
      }
      console.log("[daemon] Keep awake:", want);
      return { ok: true };
    }

    case "set_mem_available_threshold": {
      var memMB = parseInt(msg.value, 10);
      if (isNaN(memMB) || memMB < 0) memMB = DEFAULT_MEM_AVAILABLE_MIN_MB;
      config.memAvailableMinMB = memMB;
      saveConfig(config);
      console.log("[daemon] MemAvailable threshold:", memMB, "MB (cli)");
      return { ok: true, memAvailableMinMB: memMB };
    }

    case "set_tokens_per_mb_headroom": {
      var tpmVal = parseInt(msg.value, 10);
      if (isNaN(tpmVal) || tpmVal < 10 || tpmVal > 500) tpmVal = DEFAULT_TOKENS_PER_MB_HEADROOM;
      config.tokensPerMbHeadroom = tpmVal;
      saveConfig(config);
      console.log("[daemon] Tokens per MB headroom:", tpmVal, "(cli)");
      return { ok: true, tokensPerMbHeadroom: tpmVal };
    }

    case "enable_recovery": {
      if (!msg.urlPath || !msg.password) return { ok: false, error: "missing urlPath or password" };
      relay.setRecovery(msg.urlPath, msg.password);
      console.log("[daemon] Admin recovery mode enabled");
      return { ok: true };
    }

    case "disable_recovery": {
      relay.clearRecovery();
      console.log("[daemon] Admin recovery mode disabled");
      return { ok: true };
    }

    case "shutdown":
      console.log("[daemon] Shutdown requested via IPC");
      gracefulShutdown();
      return { ok: true };

    case "restart":
      console.log("[daemon] Restart requested via IPC");
      spawnAndRestart();
      return { ok: true };

    case "update": {
      if (config.headless) {
        console.log("[daemon] Update & restart requested via IPC — blocked (headless mode)");
        return { ok: false, error: "Auto-update is disabled in headless mode" };
      }
      console.log("[daemon] Update & restart requested via IPC");

      // Dev mode (config.debug): just exit with code 120, cli.js dev watcher respawns daemon
      if (config.debug) {
        console.log("[daemon] Dev mode — restarting via dev watcher");
        updateHandoff = true;
        setTimeout(function () { gracefulShutdown(); }, 100);
        return { ok: true };
      }

      // Production: install to global npm, then shut down so the process manager
      // (systemd / clagentic-daemon.sh) restarts from the updated global install.
      // This is the only reliable path — npx installs to a cache location that the
      // restart wrapper does not consult, so npx-spawned daemons get replaced by the
      // old global version on the next supervised restart.
      // Resolve + install asynchronously. ipc.js awaits a returned Promise, so
      // returning an async IIFE here is safe without changing the outer handler.
      return (async function () {
        var { execFileSync: execFileUpd } = require("child_process");
        var updater = require("./updater");

        // Resolve the target version the same way the startup updater does, then
        // install that EXACT version — never a bare dist-tag. Installing @latest/
        // @beta is unsafe: the tag can point at an older version than what is
        // running (e.g. a beta machine whose @latest resolves to an older stable),
        // which silently downgrades the daemon. We mirror checkAndUpdate: on the
        // beta channel (or a pre-release current version) consider both beta and
        // latest and take the newest; on stable consider latest only. Then guard
        // with isNewer so a downgrade is impossible.
        var isBetaCh = config.updateChannel === "beta" || (daemonVersion && daemonVersion.includes("-"));
        var updTags = isBetaCh ? ["beta", "latest"] : ["latest"];
        var updTarget = null;
        for (var _ut = 0; _ut < updTags.length; _ut++) {
          var _cand = await updater.fetchVersion(updTags[_ut] === "beta" ? "beta" : "stable");
          if (_cand && (!updTarget || updater.isNewer(_cand, updTarget))) {
            updTarget = _cand;
          }
        }

        if (!updTarget || !updater.isNewer(updTarget, daemonVersion)) {
          console.log("[daemon] No newer version available (current " + daemonVersion + ", best candidate " + (updTarget || "none") + "). Skipping update.");
          relay.broadcastAll({ type: "update_failed", error: "Already on the latest available version (" + daemonVersion + ")" });
          return { ok: false, error: "Already up to date (" + daemonVersion + ")" };
        }

        var updOk = false;
        try {
          console.log("[daemon] Installing @clagentic/console@" + updTarget + " globally (current " + daemonVersion + ")...");
          execFileUpd("npm", ["install", "-g", "@clagentic/console@" + updTarget], {
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 120000,
            encoding: "utf8",
            // CLAGENTIC_SELF_UPDATE=1 tells postinstall.js not to restart the
            // service — gracefulShutdown() below hands off to systemd Restart=always.
            env: Object.assign({}, process.env, { CLAGENTIC_SELF_UPDATE: "1" }),
          });
          console.log("[daemon] Global install complete. Shutting down for supervised restart.");
          updOk = true;
        } catch (updErr) {
          console.log("[daemon] Global install failed:", updErr.message);
          relay.broadcastAll({ type: "update_failed", error: updErr.message });
          return { ok: false, error: updErr.message };
        }
        if (updOk) {
          updateHandoff = true;
          setTimeout(function () { gracefulShutdown(); }, 100);
        }
        return { ok: true };
      })();
    }

    default:
      return { ok: false, error: "unknown command: " + msg.cmd };
  }
}, function onLiveDaemon() {
  // A live daemon already answers on this socket -- refuse to start rather
  // than stealing/orphaning its socket (lr-1bdb item A). Exit without
  // touching config so the running daemon is unaffected; --shutdown/
  // --restart/--add against it keep working.
  console.error("[daemon] Another clagentic-console daemon is already running. Exiting without starting a second instance.");
  process.exit(1);
});

// --- Start listening (with retry for port-in-use during update handoff) ---
var listenRetries = 0;
var MAX_LISTEN_RETRIES = 15;

function startListening() {
  relay.server.listen(config.port, listenHost, function () {
    var protocol = tlsOptions ? "https" : "http";
    console.log("[daemon] Listening on " + protocol + "://" + listenHost + ":" + config.port);
    console.log("[daemon] PID:", process.pid);
    console.log("[daemon] Projects:", config.projects.length);

    // Update PID in config
    config.pid = process.pid;
    saveConfig(config);

    // Drain controller (lr-6b30): manages graceful drain state.
    // Must be created after gracefulShutdown is defined (which is true here —
    // gracefulShutdown is a hoisted function declared before startListening).
    var drainTimeoutMs = (config.drainTimeoutMs != null && config.drainTimeoutMs > 0)
      ? config.drainTimeoutMs
      : undefined;
    _drain = createDrain({
      gracefulShutdown: gracefulShutdown,
      getActiveCount: getActiveLiveCount,
      drainTimeoutMs: drainTimeoutMs,
    });
    _drain.registerSignals();
    // Expose the drain controller on the relay so server.js can gate new connections.
    relay.setDrain(_drain);

    // Start MemoryHigh watermark watcher (lr-de07).
    // Detects soft memory ceiling crossings and emits structured log events;
    // onCrossing notifies the drain controller (lr-6b30) to enter drain state.
    if (process.platform === "linux") {
      _memoryWatcher = startMemoryHighWatcher(config, {
        onCrossing: function (detail) { _drain.onMemoryHighCrossing(detail); },
      });
    }

    // Auto-provision Linux accounts on startup if OS users mode is enabled.
    // ACLs are NOT re-applied on every startup (too slow with recursive setfacl).
    // ACLs are set when: projects are added, users are added, or visibility changes.
    if (config.osUsers) {
      setTimeout(function () {
        try { ensureProjectsDir(); } catch (e) {}
        try {
          var provResult = provisionAllUsers(usersModule);
          if (provResult.provisioned.length > 0) {
            console.log("[daemon] Auto-provisioned " + provResult.provisioned.length + " Linux account(s) on startup");
            // Only set ACLs for newly provisioned users (not all users on all projects)
            for (var pi = 0; pi < config.projects.length; pi++) {
              var proj = config.projects[pi];
              if ((proj.visibility || "public") === "public") {
                for (var ni = 0; ni < provResult.provisioned.length; ni++) {
                  try {
                    grantProjectAccess(proj.path, provResult.provisioned[ni].linuxUser);
                  } catch (e) {}
                }
              }
            }
          }
          if (provResult.errors.length > 0) {
            console.error("[daemon] Failed to provision " + provResult.errors.length + " account(s)");
          }
        } catch (provErr) {
          console.error("[daemon] Startup provisioning error:", provErr.message);
        }
        console.log("[daemon] Startup OS users check complete.");
      }, 100);
    }

    // Check for crash info from a previous crash and notify clients
    var crashInfo = readCrashInfo();
    if (crashInfo) {
      console.log("[daemon] Recovered from crash at", new Date(crashInfo.time).toISOString());
      console.log("[daemon] Crash reason:", crashInfo.reason);
      // Delay notification so clients have time to reconnect
      setTimeout(function () {
        relay.broadcastAll({
          type: "toast",
          level: "warn",
          message: "Server recovered from a crash and was automatically restarted.",
          detail: crashInfo.reason || null,
        });
      }, 3000);
      clearCrashInfo();
    }
  });
}

relay.server.on("error", function (err) {
  if (err.code === "EADDRINUSE" && listenRetries < MAX_LISTEN_RETRIES) {
    listenRetries++;
    console.log("[daemon] Port " + config.port + " in use, retrying (" + listenRetries + "/" + MAX_LISTEN_RETRIES + ")...");
    setTimeout(startListening, 1000);
    return;
  }
  console.error("[daemon] Server error:", err.message);
  writeCrashInfo({
    reason: "Server error: " + err.message,
    pid: process.pid,
    time: Date.now(),
  });
  process.exit(1);
});

startListening();

// --- HTTP onboarding server (only when TLS is active) ---
if (relay.onboardingServer) {
  var onboardingPort = config.port + 1;
  relay.onboardingServer.on("error", function (err) {
    console.error("[daemon] Onboarding HTTP server error:", err.message);
  });
  relay.onboardingServer.listen(onboardingPort, listenHost, function () {
    console.log("[daemon] Onboarding HTTP on http://" + listenHost + ":" + onboardingPort);
  });
}

// MemoryHigh watcher handle (lr-de07) — started after the server is listening.
var _memoryWatcher = null;

// Drain controller (lr-6b30) — initialized in startListening after gracefulShutdown is defined.
var _drain = null;

// --- Caffeinate (macOS) ---
var caffeinateProc = null;
if (config.keepAwake && process.platform === "darwin") {
  try {
    var { spawn } = require("child_process");
    caffeinateProc = spawn("caffeinate", ["-di"], { stdio: "ignore", detached: false });
    caffeinateProc.on("error", function () { caffeinateProc = null; });
  } catch (e) {}
}

// --- Spawn new daemon and graceful restart ---
function spawnAndRestart() {
  try {
    updateHandoff = true;
    ipc.close();
    shutdownProjects().then(function () {
      if (relay.onboardingServer) relay.onboardingServer.close();

      // Close the server first so the port is released before spawning the new daemon
      relay.server.close(function () {
        try {
          var { spawn: spawnRestart } = require("child_process");
          var { logPath: restartLogPath, configPath: restartConfigPath, CLAGENTIC_HOME: restartClagenticHome } = require("./config");
          var daemonScript = path.join(__dirname, "daemon.js");
          var logFd = fs.openSync(restartLogPath(), "a");
          var child = spawnRestart(process.execPath, [daemonScript], {
            detached: true,
            windowsHide: true,
            stdio: ["ignore", logFd, logFd],
            env: Object.assign({}, process.env, {
              CLAGENTIC_CONFIG: restartConfigPath(),
              CLAGENTIC_HOME: restartClagenticHome,
            }),
          });
          child.unref();
          fs.closeSync(logFd);
          config.pid = child.pid;
          // Write PID synchronously before exit so the config file is not
          // left with a stale PID during the restart window. saveConfig() is
          // async (fire-and-forget) and is frequently not flushed before
          // process.exit(120) fires.
          try {
            fs.writeFileSync(restartConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
          } catch (syncErr) {
            console.error("[daemon] Sync PID write failed (non-fatal):", syncErr.message);
            saveConfig(config);
          }
          console.log("[daemon] Spawned new daemon (PID " + child.pid + "), exiting.");
          process.exit(120);
        } catch (e) {
          console.error("[daemon] Restart failed:", e.message);
          process.exit(1);
        }
      });
    }).catch(function (e) {
      console.error("[daemon] Restart shutdown failed:", e && e.message ? e.message : e);
      if (relay.onboardingServer) relay.onboardingServer.close();
      relay.server.close(function () {
        process.exit(1);
      });
    });

    // Force exit after 10 seconds if server.close hangs
    setTimeout(function () {
      console.error("[daemon] Forced exit after timeout during restart");
      process.exit(1);
    }, 10000);
  } catch (e) {
    console.error("[daemon] Restart failed:", e.message);
    relay.broadcastAll({ type: "toast", level: "error", message: "Restart failed: " + e.message });
    relay.broadcastAll({ type: "restart_server_result", ok: false, error: e.message });
  }
}

// --- Graceful shutdown ---
var updateHandoff = false; // true when shutting down for update (new daemon already spawned)
var shutdownStarted = false;

function gracefulShutdown() {
  try { console.log("[daemon] Shutting down..."); } catch (e) {}
  if (shutdownStarted) return;
  shutdownStarted = true;
  var exitCode = updateHandoff ? 120 : 0; // 120 = update handoff, don't auto-restart

  if (caffeinateProc) {
    try { caffeinateProc.kill(); } catch (e) {}
  }

  ipc.close();

  // Remove PID from config (skip if update handoff — new daemon PID is already saved)
  if (!updateHandoff) {
    try {
      var c = loadConfig();
      if (c && c.pid === process.pid) {
        delete c.pid;
        saveConfig(c);
      }
    } catch (e) {}
  }

  shutdownProjects().then(function () {
    if (relay.onboardingServer) {
      relay.onboardingServer.close();
    }

    relay.server.close(function () {
      try { console.log("[daemon] Server closed"); } catch (e) {}
      process.exit(exitCode);
    });
  }).catch(function (e) {
    console.error("[daemon] Shutdown cleanup failed:", e && e.message ? e.message : e);
    if (relay.onboardingServer) {
      relay.onboardingServer.close();
    }
    relay.server.close(function () {
      process.exit(exitCode);
    });
  });

  // Force exit after 10 seconds
  setTimeout(function () {
    try { console.error("[daemon] Forced exit after timeout"); } catch (e) {}
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// Last-resort cleanup: kill caffeinate if process exits without graceful shutdown
process.on("exit", function () {
  if (caffeinateProc) {
    try { caffeinateProc.kill(); } catch (e) {}
  }
});

// Windows emits SIGHUP when console window closes
if (process.platform === "win32") {
  process.on("SIGHUP", gracefulShutdown);
}

process.on("uncaughtException", function (err) {
  var errMsg = err ? (err.message || String(err)) : "";
  var isAbort = errMsg.indexOf("Operation aborted") !== -1
    || errMsg.indexOf("AbortError") !== -1
    || (err && err.name === "AbortError");

  if (isAbort) {
    // A single session's SDK write was aborted (e.g. stream closed before
    // write completed). This is recoverable, so do NOT tear down the whole
    // daemon and kill every other session.
    try { console.error("[daemon] Suppressed AbortError (single-session failure):", errMsg); } catch (e) {}
    return;
  }

  // EIO/EPIPE on stdout/stderr when parent process (dev mode CLI) dies.
  // Not fatal for the daemon itself.
  var isIOError = errMsg.indexOf("EIO") !== -1 || errMsg.indexOf("EPIPE") !== -1;
  if (isIOError) {
    return;
  }

  console.error("[daemon] Uncaught exception:", err);
  writeCrashInfo({
    reason: err ? (err.stack || err.message || String(err)) : "unknown",
    pid: process.pid,
    time: Date.now(),
  });
  gracefulShutdown();
});

process.on("unhandledRejection", function (reason) {
  var errMsg = reason ? (reason.message || String(reason)) : "";
  var isAbort = errMsg.indexOf("Operation aborted") !== -1
    || errMsg.indexOf("AbortError") !== -1
    || (reason && reason.name === "AbortError");

  if (isAbort) {
    console.error("[daemon] Suppressed unhandled rejection (AbortError):", errMsg);
    return;
  }

  console.error("[daemon] Unhandled rejection:", reason);
});

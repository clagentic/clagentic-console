// audit.js — Append-only audit log for privileged actions.
// Writes JSON lines to ~/.clagentic/console/audit.log (mode 0o600).
// Never throws into callers: all errors are logged to stderr only.

var fs = require("fs");
var path = require("path");
var config = require("./config");

var AUDIT_LOG_PATH = path.join(config.CONFIG_DIR, "console", "audit.log");
var OLD_AUDIT_LOG_PATH = path.join(config.CONFIG_DIR, "audit.log");

// One-time migration: copy old audit.log to new location if new is absent.
// Copy-not-rename so rollback still finds the old file.
// Only runs if CLAGENTIC_HOME is not explicitly set (default layout).
// Note: this runs at module load time, potentially before ensureConfigDir() creates
// console/ — so we ensure the parent dir exists ourselves before copying.
if (!process.env.CLAGENTIC_HOME && !fs.existsSync(AUDIT_LOG_PATH) && fs.existsSync(OLD_AUDIT_LOG_PATH)) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    fs.copyFileSync(OLD_AUDIT_LOG_PATH, AUDIT_LOG_PATH);
    try { fs.chmodSync(AUDIT_LOG_PATH, 0o600); } catch (_) {}
    console.warn("[audit] Migrated audit.log to ~/.clagentic/console/audit.log");
  } catch (e) {
    console.error("[audit] Migration of audit.log failed (non-fatal):", e.message);
  }
}

var _logFd = null;

function _getLogFd() {
  if (_logFd !== null) return _logFd;
  try {
    _logFd = fs.openSync(AUDIT_LOG_PATH, "a", 0o600);
    // Enforce mode on existing files — openSync mode flag may not apply when the file already exists.
    try { fs.chmodSync(AUDIT_LOG_PATH, 0o600); } catch (_) {}
  } catch (e) {
    console.error("[audit] Failed to open audit log:", e.message);
  }
  return _logFd;
}

/**
 * Log a privileged action.
 *
 * @param {string} action  Action identifier, e.g. "user.create", "auth.lockout"
 * @param {object} ctx     Optional context fields:
 *   actorId    {string}  ID of the user performing the action (or "system")
 *   actorName  {string}  Username of the actor
 *   target     {string}  ID of the affected user/resource
 *   metadata   {object}  Additional non-secret metadata (never log passwords/tokens/PINs)
 */
function log(action, ctx) {
  ctx = ctx || {};
  var entry = {
    ts: new Date().toISOString(),
    action: action,
    actorId: ctx.actorId || null,
    actorName: ctx.actorName || null,
    target: ctx.target || null,
    metadata: ctx.metadata || null,
  };
  var line = JSON.stringify(entry) + "\n";
  // Non-blocking: defer write so callers are never stalled by I/O.
  setImmediate(function () {
    var fd = _getLogFd();
    if (!fd) return;
    try {
      fs.writeSync(fd, line);
    } catch (e) {
      console.error("[audit] Failed to write audit entry:", e.message);
    }
  });
}

module.exports = {
  log: log,
  auditLogPath: function () { return AUDIT_LOG_PATH; },
};

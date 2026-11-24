var pty;
try {
  pty = require("@lydell/node-pty");
} catch (e) {
  pty = null;
}

var { buildUserEnv } = require("./build-user-env");
var { asUser } = require("./os-users");

function createTerminal(cwd, cols, rows, osUserInfo) {
  if (!pty) return null;

  // Determine shell: prefer target user's shell, then $SHELL, then platform default
  var shell = (osUserInfo && osUserInfo.shell)
    || process.env.SHELL
    || (process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : "/bin/sh");

  var spawnOpts = {
    name: "xterm-256color",
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd,
  };

  var args = osUserInfo ? ["-l"] : [];
  if (osUserInfo) {
    // A pty child keeps the daemon's supplementary groups when only uid/gid are
    // given, so the account's identity is set through the shared helper, which
    // starts it through setpriv whenever the groups would otherwise be wrong.
    var spec = asUser(osUserInfo, shell, args, { cwd: cwd }, { inheritsDaemonGroups: true });
    spawnOpts.env = spec.options.env;
    if (spec.options.uid !== undefined) {
      spawnOpts.uid = spec.options.uid;
      spawnOpts.gid = spec.options.gid;
    }
    return pty.spawn(spec.command, spec.args, spawnOpts);
  }

  // Build a minimal, isolated environment (no daemon env leakage)
  spawnOpts.env = buildUserEnv(null);
  return pty.spawn(shell, args, spawnOpts);
}

module.exports = { createTerminal: createTerminal };

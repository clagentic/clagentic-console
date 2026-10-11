// Running git on behalf of a connected client.
//
// Client-supplied values never reach git unchecked: a revision must be a
// hex object name (so it cannot be read as an option), and a path must be
// project-relative (see project-file-scope.resolveGitPath). Git runs as the
// caller's OS identity in os-users mode, so repository reads are bounded by
// the same file permissions as everything else the caller can do.

var execFileSync = require("child_process").execFileSync;

var COMMIT_HASH_RE = /^[0-9a-fA-F]{4,64}$/;

function isCommitHash(value) {
  return typeof value === "string" && COMMIT_HASH_RE.test(value);
}

// args: git argv after the binary name
// o: { cwd, osUsers, osUserInfo, timeoutMs }
function runGit(args, o) {
  if (o.osUsers && !o.osUserInfo) throw new Error("Git access requires an OS user identity");
  var execOpts = {
    cwd: o.cwd,
    encoding: "utf8",
    timeout: o.timeoutMs || 5000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  };
  if (o.osUserInfo) {
    execOpts.uid = o.osUserInfo.uid;
    execOpts.gid = o.osUserInfo.gid;
    // The repository is usually owned by someone else; name it as safe for
    // this one invocation instead of editing any git config.
    execOpts.env = {
      PATH: process.env.PATH,
      HOME: o.osUserInfo.home,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: o.cwd,
    };
  }
  return execFileSync("git", args, execOpts);
}

module.exports = { isCommitHash: isCommitHash, runGit: runGit };

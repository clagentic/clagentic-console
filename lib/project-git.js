// Running read-only git on behalf of a connected client.
//
// Client-supplied values never reach git unchecked: a revision must be a
// hex object name (so it cannot be read as an option), and a path must be
// project-relative (see project-file-scope.resolveGitPath).
//
// A repository's own config can name programs git will run (textconv,
// diff.external, core.fsmonitor, hooks). Those must only ever run with the
// authority of whoever owns the repository, never with a viewer's:
//   - in os-users mode git runs as the uid that owns the repository (the
//     stat of its .git), not as the connection's user. Who may look at the
//     repository is settled by the access gate before a handler runs;
//   - otherwise git runs as the daemon, as every other daemon action does;
//   - on every call the config-driven programs are switched off, and only
//     committed blobs are read, so no clean/smudge or textconv filter runs
//     over working-tree content.
// No safe.directory override is ever passed: a repository whose owner git
// does not trust is refused by git itself.

var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");

var COMMIT_HASH_RE = /^[0-9a-fA-F]{4,64}$/;

// Config that would otherwise let a repository run a program.
var HARDENING_CONFIG = [
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "diff.external=",
];

// Subcommands that render diffs, and so consult textconv and external drivers.
var DIFF_RENDERING = { diff: true, show: true, log: true };

function isCommitHash(value) {
  return typeof value === "string" && COMMIT_HASH_RE.test(value);
}

// The uid/gid that owns the repository at `cwd`. Throws when it cannot be
// established: an unreadable repository is refused, never run as someone else.
function repositoryOwner(cwd) {
  var st;
  try {
    st = fs.statSync(path.join(cwd, ".git"));
  } catch (e) {
    throw new Error("Cannot determine the repository owner");
  }
  return { uid: st.uid, gid: st.gid };
}

// The full argv for one call: hardening before the subcommand, and diff
// rendering told not to run any external or textconv program.
function buildArgs(args) {
  var out = HARDENING_CONFIG.slice();
  if (!args.length) return out;
  out.push(args[0]);
  if (DIFF_RENDERING[args[0]] === true) out.push("--no-ext-diff", "--no-textconv");
  return out.concat(args.slice(1));
}

// args: git argv after the binary name
// o: { cwd, osUsers, timeoutMs, exec }
//   exec replaces child_process.execFileSync (tests observe the identity used).
function runGit(args, o) {
  var execOpts = {
    cwd: o.cwd,
    encoding: "utf8",
    timeout: o.timeoutMs || 5000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  };
  if (o.osUsers) {
    var owner = repositoryOwner(o.cwd);
    execOpts.uid = owner.uid;
    execOpts.gid = owner.gid;
  }
  var exec = o.exec || childProcess.execFileSync;
  return exec("git", buildArgs(args), execOpts);
}

module.exports = {
  isCommitHash: isCommitHash,
  repositoryOwner: repositoryOwner,
  buildArgs: buildArgs,
  runGit: runGit,
};

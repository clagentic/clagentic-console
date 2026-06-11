// clone-validate.js — URL validation and spawn-arg hardening for git clone (lr-28b5).
//
// Extracted from daemon.js onCloneProject so this logic is directly testable.
// Daemon.js calls validateCloneUrl() and buildCloneArgs() rather than inlining.

var CLONE_ALLOWED_SCHEMES = ["https://", "http://", "git://", "ssh://", "git@"];

// Validate a git clone URL.
// Returns null on success, or an error string describing the rejection.
function validateCloneUrl(cloneUrl) {
  // Reject leading-dash values: option injection vector (e.g. --upload-pack=<cmd>).
  if (cloneUrl.startsWith("-")) {
    return "Invalid clone URL: URL must not start with '-'";
  }
  // Scheme allow-list: only permit safe transports.
  for (var i = 0; i < CLONE_ALLOWED_SCHEMES.length; i++) {
    if (cloneUrl.startsWith(CLONE_ALLOWED_SCHEMES[i])) {
      return null; // allowed
    }
  }
  return "Invalid clone URL: unsupported scheme. Allowed: https, http, git, ssh, git@";
}

// Build the argv and env overrides for the git clone subprocess.
//
// The "--" argv terminator (argv[1]) prevents cloneUrl from being parsed as a
// git option even if validation is somehow bypassed.
//
// GIT_ALLOW_PROTOCOL restricts git's transport layer to safe protocols,
// blocking ext:: and file:: transports at the git level as a second line of
// defence in case future validation regressions let through a bad URL.
//
// Returns { args: string[], envOverrides: Object } — callers merge envOverrides
// into the spawn env.
function buildCloneArgs(cloneUrl, targetDir) {
  return {
    args: ["clone", "--", cloneUrl, targetDir],
    envOverrides: {
      GIT_ALLOW_PROTOCOL: "https:http:git:ssh",
    },
  };
}

module.exports = { validateCloneUrl: validateCloneUrl, buildCloneArgs: buildCloneArgs, CLONE_ALLOWED_SCHEMES: CLONE_ALLOWED_SCHEMES };

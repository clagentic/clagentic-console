// lib/cli/arg-validation.js
//
// Rejects CLI arguments that bin/cli.js's flag loop does not recognise, so an
// unknown leading word or flag fails with a usage error instead of falling
// through to daemon control (--shutdown, --restart, ...) or a daemon start.
// Kept as a pure function so it is testable without spawning the CLI.

// Flags that take no value.
var BOOLEAN_FLAGS = [
  "--no-https", "--local-cert", "--no-update", "--skip-update", "--dev",
  "--watch", "-w", "--debug", "-y", "--yes", "--shutdown", "--restart",
  "--no-restart", "--list", "--activity-diagnostics", "--process-build-status",
  "--headless", "--multi-user", "--os-users",
  // Removed flag: the flag loop prints its own dedicated message and exits 1.
  "--dangerously-skip-permissions",
];

// Flags that consume the next argument as their value, whatever it looks like.
var VALUE_FLAGS = ["-p", "--port", "--host", "--bind", "--pin", "--add", "--remove"];

var HELP_FLAGS = ["-h", "--help"];

/**
 * Returns the first argument that is neither a known flag nor a flag's
 * consumed value, or null when every argument is recognised. Scanning stops at
 * -h/--help, which prints usage and exits before any later token is acted on.
 */
function findUnrecognisedArg(args) {
  for (var i = 0; i < args.length; i++) {
    var arg = args[i];
    if (HELP_FLAGS.indexOf(arg) !== -1) return null;
    if (VALUE_FLAGS.indexOf(arg) !== -1) {
      i++;
      continue;
    }
    if (BOOLEAN_FLAGS.indexOf(arg) !== -1) continue;
    return arg;
  }
  return null;
}

function unrecognisedArgMessage(arg) {
  return "clagentic-console: unrecognised argument '" + arg + "'\n" +
    "Run 'clagentic-console --help' for usage.";
}

module.exports = {
  findUnrecognisedArg: findUnrecognisedArg,
  unrecognisedArgMessage: unrecognisedArgMessage,
};

// runtime-env-keys.js - the environment variables Settings may not set.
//
// Shared and per-project environment variables reach the agent runtimes the
// console starts. A variable that makes a shell, interpreter, loader or tool
// run code, or that replaces the system's own search path, is refused whoever
// sets it. This is defense in depth for the integrity of the host: it is NOT
// what keeps one user's variables from another user's session, which a list of
// names cannot do (the next variable would be missing from it). That is
// lib/runtime-env.js projectEnvApplies. This module is the one list of what is
// refused: at save time (lib/runtime-env.js validateEnvText) and dropped at
// build time (lib/runtime-env.js buildRuntimeEnvOverlay / composeRuntimeEnv).
//
// Names are compared case-insensitively: on platforms where the environment is
// case-insensitive "path" is PATH, and refusing both everywhere costs nothing.

var CLASSES = [
  {
    name: "identity",
    description: "the runtime's own identity and search path",
    exact: ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR"],
  },
  {
    name: "loader",
    description: "the dynamic loader, which runs code inside every process",
    prefixes: ["LD_", "DYLD_"],
  },
  {
    name: "node",
    description: "Node.js startup options and module search path",
    exact: ["NODE_OPTIONS", "NODE_PATH"],
  },
  {
    name: "console",
    description: "Clagentic: Console's own configuration",
    prefixes: ["CLAGENTIC_", "CLAY_"],
  },
  {
    name: "shell-startup",
    description: "files and commands a shell runs on its own at startup or on every prompt",
    exact: ["BASH_ENV", "ENV", "PROMPT_COMMAND", "PS4", "SHELLOPTS", "BASHOPTS"],
  },
  {
    name: "interpreter",
    description: "startup hooks and library search paths of Python, Perl and Ruby",
    exact: [
      "PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME",
      "PERL5OPT", "PERL5LIB", "PERLLIB",
      "RUBYOPT", "RUBYLIB",
    ],
  },
  {
    name: "git",
    description: "Git settings that name programs for Git to run",
    exact: [
      "GIT_SSH", "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF", "GIT_PAGER",
      "GIT_EDITOR", "GIT_ASKPASS", "GIT_EXEC_PATH",
    ],
    prefixes: ["GIT_CONFIG_"],
  },
  {
    name: "tool-launcher",
    description: "programs other tools start on the user's behalf",
    exact: ["PAGER", "EDITOR", "VISUAL", "SSH_ASKPASS", "SUDO_ASKPASS"],
  },
  {
    name: "process-wrapper",
    description: "the launcher or wrapper a runtime is started through",
    exact: ["CLAUDE_CODE_PROCESS_WRAPPER", "CLAUDE_CODE_PATH"],
  },
  {
    name: "reserved",
    description: "a name JavaScript reserves on every object",
    exact: ["__PROTO__"],
  },
];

function normalize(name) {
  return typeof name === "string" ? name.toUpperCase() : "";
}

/**
 * The protected class a variable name belongs to, or null when settings may
 * set it.
 * @param {string} name
 * @returns {{name: string, description: string}|null}
 */
function protectedClassOf(name) {
  var upper = normalize(name);
  if (!upper) return null;
  for (var i = 0; i < CLASSES.length; i++) {
    var cls = CLASSES[i];
    if (cls.exact && cls.exact.indexOf(upper) !== -1) return { name: cls.name, description: cls.description };
    var prefixes = cls.prefixes || [];
    for (var p = 0; p < prefixes.length; p++) {
      if (upper.indexOf(prefixes[p]) === 0) return { name: cls.name, description: cls.description };
    }
  }
  return null;
}

function isProtectedKey(name) {
  return protectedClassOf(name) !== null;
}

module.exports = {
  CLASSES: CLASSES,
  protectedClassOf: protectedClassOf,
  isProtectedKey: isProtectedKey,
};

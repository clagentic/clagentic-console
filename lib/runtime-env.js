// runtime-env.js - the one place the environment of an agent runtime is built.
//
// Settings hold two environment texts: shared (every project, administrators
// only) and per project. Every agent-runtime start (a Claude query in process
// or in a worker, a Codex app-server, title generation, a model-list warmup)
// takes its environment from here: the runtime's own environment first, then
// the shared text, then the project text.
//
// Two rules the callers rely on:
//   - The Claude Agent SDK's options.env REPLACES the subprocess environment, so
//     composeRuntimeEnv always returns the COMPLETE environment, never only
//     the additions.
//   - Values are secrets. Nothing here logs, returns in an error, or stores a
//     value; warnings name the variable and the settings layer only.
//
// Protected names (lib/runtime-env-keys.js) are refused when saved and dropped
// when built, so a text saved before a name was protected cannot reach a
// runtime either. That list is defense in depth. What keeps one user's text
// from another user's runtime is projectEnvApplies: in multi-user mode a
// project's text reaches only sessions of the project's owner.

var crypto = require("crypto");
var protectedKeys = require("./runtime-env-keys");

var KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
var SHELL_META_RE = /[`$\\;|&><(){}\n]/;
var QUOTED_RE = /^["'].*["']$/;
var EXPORT_PREFIX_RE = /^export\s+/;

var _warned = new Set();

function unquote(value) {
  if (value.length >= 2) {
    var first = value.charAt(0);
    if ((first === '"' || first === "'") && value.charAt(value.length - 1) === first) {
      return value.substring(1, value.length - 1);
    }
  }
  return value;
}

// Reads a KEY=VALUE text, one assignment per line. Blank lines and lines
// starting with # are skipped. Returns the assignments that are well formed
// and, in line order, every problem found (a malformed line, or a protected
// name).
function scanEnvText(text) {
  var entries = [];
  var issues = [];
  if (typeof text !== "string" || !text.trim()) return { entries: entries, issues: issues };
  var lines = text.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || line.charAt(0) === "#") continue;
    // The Settings pages write every row as "export KEY=VALUE" and read it
    // back with the prefix stripped, so that is the form that arrives here.
    line = line.replace(EXPORT_PREFIX_RE, "");
    var eqIdx = line.indexOf("=");
    if (eqIdx < 1) {
      issues.push({ line: i + 1, kind: "format", message: "Invalid format at line " + (i + 1) + ": expected KEY=VALUE" });
      continue;
    }
    var key = line.substring(0, eqIdx);
    if (!KEY_RE.test(key)) {
      issues.push({ line: i + 1, kind: "format", message: "Invalid variable name at line " + (i + 1) + ": " + key });
      continue;
    }
    var value = line.substring(eqIdx + 1);
    if (SHELL_META_RE.test(value) && !QUOTED_RE.test(value)) {
      issues.push({ line: i + 1, kind: "format", message: "Potentially unsafe value at line " + (i + 1) + ": shell metacharacters detected" });
      continue;
    }
    var cls = protectedKeys.protectedClassOf(key);
    if (cls) {
      issues.push({
        line: i + 1,
        kind: "protected",
        key: key,
        protectedClass: cls.name,
        message: "Line " + (i + 1) + ": " + key + " cannot be set here. It is protected because it controls " +
          cls.description + ". Remove the line to save.",
      });
      continue;
    }
    entries.push({ line: i + 1, key: key, value: unquote(value) });
  }
  return { entries: entries, issues: issues };
}

/**
 * Save-time check of one environment text. Returns null when it may be saved,
 * or the message to show the user. Refuses malformed lines and protected names.
 * @param {string} text
 * @returns {string|null}
 */
function validateEnvText(text) {
  var scanned = scanEnvText(text);
  return scanned.issues.length ? scanned.issues[0].message : null;
}

function warnOnce(warned, warn, dedupeKey, message) {
  if (warned.has(dedupeKey)) return;
  warned.add(dedupeKey);
  warn(message);
}

/**
 * The variables the settings add to a runtime's environment.
 *
 * @param {Array<{label: string, text: string}>} layers  Lowest precedence
 *   first (shared, then project); a later layer overrides an earlier one.
 * @param {object} [opts]
 * @param {function} [opts.warn=console.warn]
 * @param {Set} [opts.warned]  Dedup set, so a protected name is reported once.
 * @returns {object} variable name -> value, protected names removed
 */
function buildRuntimeEnvOverlay(layers, opts) {
  opts = opts || {};
  var warn = opts.warn || console.warn;
  var warned = opts.warned || _warned;
  var overlay = {};
  (layers || []).forEach(function (layer) {
    var label = (layer && layer.label) || "settings";
    var scanned = scanEnvText(layer && layer.text);
    scanned.issues.forEach(function (issue) {
      if (issue.kind === "protected") {
        warnOnce(warned, warn, label + "\0" + issue.key,
          "[runtime-env] ignoring " + issue.key + " in " + label + " environment settings: protected (" +
          issue.protectedClass + "); remove it in Settings");
      } else {
        warnOnce(warned, warn, label + "\0line" + issue.line + "\0" + issue.kind,
          "[runtime-env] ignoring a malformed line (" + issue.line + ") in " + label + " environment settings");
      }
    });
    scanned.entries.forEach(function (entry) {
      overlay[entry.key] = entry.value;
    });
  });
  return overlay;
}

/**
 * The complete environment for a runtime: base, then overlay. Protected names
 * in the overlay are dropped here as well, so a caller that hands in an
 * overlay it did not build through buildRuntimeEnvOverlay cannot override them.
 *
 * @param {object} base     the runtime's own environment (process.env, or the
 *                          OS user's worker environment)
 * @param {object} overlay  variables to add
 * @param {object} [opts]   same as buildRuntimeEnvOverlay
 * @returns {object} a new object; base is not modified
 */
function composeRuntimeEnv(base, overlay, opts) {
  opts = opts || {};
  var warn = opts.warn || console.warn;
  var warned = opts.warned || _warned;
  var env = {};
  var baseNames = Object.keys(base || {});
  for (var i = 0; i < baseNames.length; i++) {
    if (typeof base[baseNames[i]] === "string") env[baseNames[i]] = base[baseNames[i]];
  }
  var names = Object.keys(overlay || {});
  for (var j = 0; j < names.length; j++) {
    var name = names[j];
    if (typeof overlay[name] !== "string") continue;
    var cls = protectedKeys.protectedClassOf(name);
    if (cls) {
      warnOnce(warned, warn, "runtime\0" + name,
        "[runtime-env] ignoring " + name + " handed to a runtime: protected (" + cls.name + ")");
      continue;
    }
    env[name] = overlay[name];
  }
  return env;
}

/**
 * Whether a project's environment text applies to a session.
 *
 * Single-user: always. Multi-user: only to a session owned by the project's
 * owner, because the owner writes the text and a variable such as a base URL
 * or a tool-options variable would otherwise redirect or run code in another
 * user's session. A list of refused names cannot close that, so the text is
 * simply never handed to anyone else. Shared settings are administrator-only
 * and are not subject to this. Anything but an explicit multiUser === false is
 * treated as multi-user, and a missing owner on either side applies to no one.
 *
 * @param {{multiUser: boolean, projectOwnerId: string|null, sessionOwnerId: string|null}} scope
 * @returns {boolean}
 */
function projectEnvApplies(scope) {
  if (scope && scope.multiUser === false) return true;
  if (!scope || !scope.projectOwnerId || !scope.sessionOwnerId) return false;
  return scope.projectOwnerId === scope.sessionOwnerId;
}

function hasOverlay(overlay) {
  return !!overlay && Object.keys(overlay).length > 0;
}

/**
 * A digest of an overlay, so a runtime started with one can be told from a
 * later settings change without keeping the values. Empty overlay -> "".
 */
function envSignature(overlay) {
  var names = Object.keys(overlay || {}).sort();
  if (names.length === 0) return "";
  var hash = crypto.createHash("sha256");
  for (var i = 0; i < names.length; i++) {
    hash.update(names[i] + "\0" + overlay[names[i]] + "\0");
  }
  return hash.digest("hex");
}

module.exports = {
  validateEnvText: validateEnvText,
  buildRuntimeEnvOverlay: buildRuntimeEnvOverlay,
  composeRuntimeEnv: composeRuntimeEnv,
  projectEnvApplies: projectEnvApplies,
  hasOverlay: hasOverlay,
  envSignature: envSignature,
};

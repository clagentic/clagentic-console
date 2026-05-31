const https = require("https");
const { execFileSync, spawn } = require("child_process");

// ANSI helpers (mirrors cli.js)
var isBasicTerm = process.env.TERM_PROGRAM === "Apple_Terminal";
var a = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  clay: isBasicTerm ? "\x1b[34m" : "\x1b[38;2;88;87;252m",   // #5857FC Indigo — active interaction
  green: "\x1b[32m",
  yellow: "\x1b[33m",
};

var sym = {
  pointer: a.clay + "\u25C6" + a.reset,
  done: a.green + "\u25C7" + a.reset,
  bar: a.dim + "\u2502" + a.reset,
  warn: a.yellow + "\u25B2" + a.reset,
};

function log(s) { console.log("  " + s); }

function fetchVersion(channel) {
  var tag = channel === "beta" ? "beta" : "latest";
  return new Promise(function (resolve) {
    var req = https.get("https://registry.npmjs.org/@clagentic%2Fconsole/" + tag, function (res) {
      var data = "";
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () {
        try {
          resolve(JSON.parse(data).version || null);
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on("error", function () { resolve(null); });
    req.setTimeout(3000, function () {
      req.destroy();
      resolve(null);
    });
  });
}

function fetchLatestVersion() {
  return fetchVersion("stable");
}

function parseVersion(v) {
  var dashIdx = v.indexOf("-");
  var base = dashIdx === -1 ? v : v.substring(0, dashIdx);
  var pre = dashIdx === -1 ? null : v.substring(dashIdx + 1);
  var parts = base.split(".").map(Number);
  var preNum = null;
  if (pre) {
    var m = pre.match(/\.(\d+)$/);
    preNum = m ? parseInt(m[1], 10) : 0;
  }
  return { parts: parts, pre: pre, preNum: preNum };
}

function isNewer(latest, current) {
  if (!latest || !current) return false;
  var l = parseVersion(latest);
  var c = parseVersion(current);
  // Compare base version (major.minor.patch)
  for (var i = 0; i < 3; i++) {
    var lv = l.parts[i] || 0;
    var cv = c.parts[i] || 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  // Bases are equal: stable (no pre-release) beats pre-release
  if (!l.pre && c.pre) return true;
  if (l.pre && !c.pre) return false;
  // Both pre-release with same base: compare pre-release number
  if (l.pre && c.pre) {
    return l.preNum > c.preNum;
  }
  return false;
}

// Install an EXACT version, never a dist-tag. Installing a tag (@latest/@beta)
// is unsafe: the tag can resolve to a different — even older — version than the
// one isNewer() approved, which is how a beta machine got silently downgraded to
// whatever @latest happened to point at. Pinning the resolved version makes a
// downgrade structurally impossible.
function performUpdate(version) {
  if (!version) return false;
  try {
    execFileSync("npm", ["install", "-g", "@clagentic/console@" + version], { stdio: "pipe" });
    return true;
  } catch (e) {
    return false;
  }
}

function reExec() {
  var args = process.argv.slice(1).concat("--no-update");
  var child = spawn(process.execPath, args, { stdio: "inherit" });
  child.on("exit", function (code) {
    process.exit(code);
  });
}

async function checkAndUpdate(currentVersion, skipUpdate, channel) {
  if (skipUpdate) return false;

  // Determine which npm tag(s) to check. When the current version is a pre-release
  // (e.g. 1.0.5-beta.1) or the saved channel is "beta", check the beta tag.
  // Always also check latest so a stable release is never missed.
  var isBeta = channel === "beta" || (currentVersion && currentVersion.includes("-"));
  var tags = isBeta ? ["beta", "latest"] : ["latest"];

  var latest = null;
  for (var ti = 0; ti < tags.length; ti++) {
    var candidate = await fetchVersion(tags[ti]);
    if (candidate && (!latest || isNewer(candidate, latest))) {
      latest = candidate;
    }
  }

  // Guard: only ever install something strictly newer than what is running.
  // isNewer treats a same-base stable as newer than a pre-release, so this also
  // never trades a beta down to an equal-or-older stable.
  if (!latest || !isNewer(latest, currentVersion)) return false;

  log(sym.pointer + "  " + a.bold + "Update available" + a.reset + "  " + a.dim + currentVersion + " -> " + latest + a.reset);
  log(sym.bar + "  Installing...");

  // Install the exact resolved version, not a dist-tag — the announced version
  // and the installed version are then guaranteed identical.
  if (performUpdate(latest)) {
    log(sym.done + "  Updated to " + a.green + latest + a.reset);
    log("");
    reExec();
    return true;
  }

  log(sym.warn + "  " + a.yellow + "Update failed" + a.reset + a.dim + " (permission denied?)" + a.reset);
  log(sym.bar + "  " + a.dim + "Run manually: npm install -g @clagentic/console@" + latest + a.reset);
  log("");
  return false;
}

module.exports = { checkAndUpdate, fetchLatestVersion, fetchVersion, isNewer };

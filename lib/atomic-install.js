"use strict";

// atomic-install.js — install a build into the global npm prefix without the
// command ever going missing.
//
// `npm install -g` over an existing install retires the old package and its bin
// link, unpacks the new package, then relinks. For that window the command is
// absent, so every CLI caller (send-input, hooks, scripts) exits 127. This
// helper installs into a staging prefix on the same filesystem, then swaps the
// result in with renames only:
//
//   * the bin link is repointed by creating a temporary symlink and renaming it
//     over the live one, never unlink-then-create;
//   * the package directory is moved into place with rename(2). rename(2)
//     cannot replace a non-empty directory, so an existing install takes two
//     renames (new in, old out). The bin link is pointed at a directory that
//     exists across both, so it resolves at every instant.
//
// Lifecycle scripts are not run by the staging install (they would run against
// the staging path); the package's own postinstall runs at its final location.
// POSIX only: Windows cannot rename over files in use, so it keeps npm's own
// install.

const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const PACKAGE_NAME = "@clagentic/console";
const STAGE_PREFIX = ".clagentic-console-stage-";

function uniqueId() {
  return process.pid + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

// Runs a process to completion. Rejects with the exit status, the signal or the
// timeout and the tail of stderr, so a caller can show the user why.
function runProcess(cmd, args, opts) {
  return new Promise(function (resolve, reject) {
    var inherit = !!opts.inherit;
    var child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    var tail = "";
    var timedOut = false;
    var timer = null;
    if (!inherit) {
      child.stdout.resume();
      child.stderr.on("data", function (d) { tail = (tail + d).slice(-2000); });
    }
    if (opts.timeoutMs) {
      timer = setTimeout(function () { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs);
    }
    child.on("error", function (err) {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", function (code, signal) {
      if (timer) clearTimeout(timer);
      if (code === 0) return resolve();
      var why = timedOut ? "timed out after " + opts.timeoutMs + " ms"
        : signal ? "was stopped by " + signal : "exited with status " + code;
      var err = new Error(cmd + " " + why + (tail.trim() ? ": " + tail.trim() : ""));
      err.exitCode = code;
      reject(err);
    });
  });
}

function resolveGlobalPrefix(env) {
  return execFileSync("npm", ["prefix", "-g"], { encoding: "utf8", env: env || process.env }).trim();
}

// Bin name -> path inside the package, from package.json's `bin` field.
function binMapOf(pkgJson) {
  if (!pkgJson.bin) return {};
  if (typeof pkgJson.bin === "string") {
    return { [path.basename(pkgJson.name)]: pkgJson.bin };
  }
  return Object.assign({}, pkgJson.bin);
}

// Creates a symlink at a temporary name beside the bin link, then renames it
// over the live one. The rename replaces the old link in one step.
function repointBin(fsx, binDir, binName, pkgDir, binRel, id) {
  const linkPath = path.join(binDir, binName);
  const tmpPath = path.join(binDir, "." + binName + "." + id + ".tmp");
  const target = path.relative(binDir, path.join(pkgDir, binRel));
  try {
    fsx.symlinkSync(target, tmpPath);
    fsx.renameSync(tmpPath, linkPath);
  } catch (err) {
    try { fsx.rmSync(tmpPath, { force: true }); } catch (_) { /* nothing left to clean */ }
    throw err;
  }
}

/**
 * Moves `stagedPkgDir` into <prefix>/lib/node_modules/<name> and repoints the
 * bin links, so the command resolves between every two filesystem operations.
 * `stagedPkgDir` must be on the same filesystem as the prefix. Returns
 * { retiredDir } — the previous package directory, moved aside and left for the
 * caller to remove (null on a first install).
 */
function swapIn(opts) {
  const fsx = opts.fs || fs;
  const name = opts.name || PACKAGE_NAME;
  const prefix = opts.prefix;
  const id = opts.id || uniqueId();
  const binMap = opts.binMap;
  const modulesDir = path.join(prefix, "lib", "node_modules");
  const finalDir = path.join(modulesDir, name);
  const scopeDir = path.dirname(finalDir);
  const leaf = path.basename(finalDir);
  const binDir = path.join(prefix, "bin");
  const incomingDir = path.join(scopeDir, "." + leaf + ".incoming-" + id);
  const retiredDir = path.join(scopeDir, "." + leaf + ".retired-" + id);

  fsx.mkdirSync(scopeDir, { recursive: true });
  fsx.mkdirSync(binDir, { recursive: true });

  const point = function (dir) {
    Object.keys(binMap).forEach(function (binName) {
      repointBin(fsx, binDir, binName, dir, binMap[binName], id);
    });
  };

  let exists = true;
  try { fsx.lstatSync(finalDir); } catch (err) {
    if (err.code !== "ENOENT") throw err;
    exists = false;
  }

  if (!exists) {
    fsx.renameSync(opts.stagedPkgDir, finalDir);
    point(finalDir);
    return { retiredDir: null };
  }

  // The command must resolve between every pair of steps below.
  let moved = false;
  try {
    fsx.renameSync(opts.stagedPkgDir, incomingDir);   // new build beside the old one
    point(incomingDir);                               // bin -> new build
    fsx.renameSync(finalDir, retiredDir);             // old build out of the way
    moved = true;
    point(retiredDir);                                // bin -> old build, frees the incoming name
    fsx.renameSync(incomingDir, finalDir);            // new build in
    point(finalDir);                                  // bin -> final path
  } catch (err) {
    // Put the previous build back where the command expects it.
    try {
      if (moved) {
        let finalMissing = false;
        try { fsx.lstatSync(finalDir); } catch (_) { finalMissing = true; }
        if (finalMissing) fsx.renameSync(retiredDir, finalDir);
        point(finalDir);
      } else {
        point(finalDir);
      }
      fsx.rmSync(incomingDir, { recursive: true, force: true });
    } catch (_) { /* the original failure is the one worth reporting */ }
    throw err;
  }
  return { retiredDir: retiredDir };
}

function readPackageJson(fsx, dir) {
  return JSON.parse(fsx.readFileSync(path.join(dir, "package.json"), "utf8"));
}

/**
 * Installs `spec` (a tarball path or name@version) into the global prefix.
 *
 *   opts.spec        what to hand to npm install
 *   opts.prefix      global prefix (default: `npm prefix -g`)
 *   opts.env         environment for npm and the package's postinstall
 *   opts.timeoutMs   limit for the npm step
 *   opts.inherit     show npm's output instead of capturing it
 *   opts.name        package name (default @clagentic/console)
 *   opts.runNpm      (args, runOpts) => Promise; replaces spawning npm (tests)
 *   opts.runScript   (command, runOpts) => Promise; replaces the postinstall run (tests)
 *   opts.fs          filesystem (tests)
 *
 * A failed staging install, an unwritable prefix or a failed postinstall leaves
 * the previous build in place. Resolves to { prefix, packageDir, mode }.
 */
async function installGlobalAtomically(opts) {
  const fsx = opts.fs || fs;
  const name = opts.name || PACKAGE_NAME;
  const env = opts.env || process.env;
  const runNpm = opts.runNpm || function (args, o) { return runProcess("npm", args, o); };
  const runScript = opts.runScript || function (command, o) { return runProcess("sh", ["-c", command], o); };

  if (process.platform === "win32" && !opts.runNpm) {
    await runNpm(["install", "-g", opts.spec], { env: env, timeoutMs: opts.timeoutMs, inherit: opts.inherit });
    return { prefix: null, packageDir: null, mode: "npm-direct" };
  }

  const prefix = opts.prefix || resolveGlobalPrefix(env);
  const stageParent = path.join(prefix, "lib");
  const id = uniqueId();
  let stageRoot = null;
  try {
    fsx.mkdirSync(stageParent, { recursive: true });
    stageRoot = fsx.mkdtempSync(path.join(stageParent, STAGE_PREFIX));
  } catch (err) {
    throw new Error("cannot write to the install prefix " + prefix + " (" + err.code + "): " + err.message);
  }

  let retiredDir = null;
  try {
    // --prefix on the command line wins over a prefix in the caller's npm env.
    await runNpm(
      ["install", "-g", "--prefix", stageRoot, "--ignore-scripts", "--no-audit", "--no-fund", opts.spec],
      { env: env, timeoutMs: opts.timeoutMs, inherit: opts.inherit }
    );

    const stagedPkgDir = path.join(stageRoot, "lib", "node_modules", name);
    let pkgJson;
    try {
      pkgJson = readPackageJson(fsx, stagedPkgDir);
    } catch (err) {
      throw new Error("the staged install of " + opts.spec + " has no readable " + name + " package (" + err.message + ")");
    }
    const binMap = binMapOf(pkgJson);
    const swapped = swapIn({ fs: fsx, prefix: prefix, name: name, stagedPkgDir: stagedPkgDir, binMap: binMap, id: id });
    retiredDir = swapped.retiredDir;
    const packageDir = path.join(prefix, "lib", "node_modules", name);

    const postinstall = pkgJson.scripts && pkgJson.scripts.postinstall;
    if (postinstall) {
      const scriptEnv = Object.assign({}, env, {
        npm_config_global: "true",
        npm_config_prefix: prefix,
        npm_package_name: pkgJson.name,
        npm_package_version: pkgJson.version,
      });
      try {
        await runScript(postinstall, { cwd: packageDir, env: scriptEnv, timeoutMs: opts.timeoutMs, inherit: opts.inherit });
      } catch (err) {
        if (retiredDir) {
          // Restore the previous build, as npm does when a lifecycle script fails.
          const back = swapIn({ fs: fsx, prefix: prefix, name: name, stagedPkgDir: retiredDir, binMap: binMap, id: id + "-undo" });
          retiredDir = null;
          if (back.retiredDir) fsx.rmSync(back.retiredDir, { recursive: true, force: true });
        }
        throw new Error("postinstall failed, the previous build was kept: " + err.message);
      }
    }
    return { prefix: prefix, packageDir: packageDir, mode: "atomic" };
  } finally {
    if (retiredDir) {
      try { fsx.rmSync(retiredDir, { recursive: true, force: true }); } catch (_) { /* the new build is live; a leftover dotted directory is harmless */ }
    }
    try { fsx.rmSync(stageRoot, { recursive: true, force: true }); } catch (_) { /* same: a leftover staging directory is harmless */ }
  }
}

module.exports = {
  PACKAGE_NAME,
  STAGE_PREFIX,
  installGlobalAtomically,
  swapIn,
  resolveGlobalPrefix,
  runProcess,
};

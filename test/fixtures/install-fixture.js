"use strict";

// A throwaway copy of the package laid out like a global npm install: lib/,
// package.json and a node_modules whose native prebuild (the one file the
// daemon keeps mapped) is a real copy inside the install. Every other
// dependency is a symlink to this checkout's, so the copy stays small.
//
// reinstallIdentical() replaces the files the way `npm install -g` does (new
// inodes, same bytes); installBuild() replaces them with a different build.

var fs = require("fs");
var os = require("os");
var path = require("path");

var REPO_ROOT = path.resolve(__dirname, "..", "..");
var NATIVE_SCOPE = "@lydell";

function copyTree(src, dest) {
  fs.cpSync(src, dest, { recursive: true, dereference: false });
}

function linkDependencies(nodeModules) {
  var repoModules = path.join(REPO_ROOT, "node_modules");
  fs.mkdirSync(nodeModules, { recursive: true });
  fs.readdirSync(repoModules).forEach(function (name) {
    if (name === NATIVE_SCOPE || name === ".bin") return;
    fs.symlinkSync(path.join(repoModules, name), path.join(nodeModules, name));
  });
  copyTree(path.join(repoModules, NATIVE_SCOPE), path.join(nodeModules, NATIVE_SCOPE));
}

function writeFiles(root, sha, marker) {
  copyTree(path.join(REPO_ROOT, "lib"), path.join(root, "lib"));
  fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(root, "package.json"));
  fs.writeFileSync(path.join(root, "lib", "build-sha.json"), JSON.stringify({ sha: sha }));
  // A different build differs in code, not only in its recorded sha: the
  // daemon of this build prints the marker, so a journal shows which code ran.
  if (marker) {
    fs.appendFileSync(path.join(root, "lib", "daemon.js"), "\nconsole.log(\"[daemon] BUILD-MARKER \" + " + JSON.stringify(marker) + ");\n");
  }
}

function removeFiles(root) {
  fs.rmSync(path.join(root, "lib"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "package.json"), { force: true });
  fs.rmSync(path.join(root, "node_modules", NATIVE_SCOPE), { recursive: true, force: true });
}

function makeInstall(sha) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-install-"));
  writeFiles(root, sha, null);
  linkDependencies(path.join(root, "node_modules"));
  var install = {
    root: root,
    daemonScript: path.join(root, "lib", "daemon.js"),
    sha: sha,
    reinstallIdentical: function () {
      // npm unpacks into a fresh directory and swaps it in: the old inodes are unlinked.
      var staging = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-staging-"));
      writeFiles(staging, install.sha, install.marker || null);
      fs.mkdirSync(path.join(staging, "node_modules"));
      copyTree(path.join(REPO_ROOT, "node_modules", NATIVE_SCOPE), path.join(staging, "node_modules", NATIVE_SCOPE));
      removeFiles(root);
      fs.renameSync(path.join(staging, "lib"), path.join(root, "lib"));
      fs.renameSync(path.join(staging, "package.json"), path.join(root, "package.json"));
      fs.renameSync(path.join(staging, "node_modules", NATIVE_SCOPE), path.join(root, "node_modules", NATIVE_SCOPE));
      fs.rmSync(staging, { recursive: true, force: true });
    },
    installBuild: function (newSha, marker) {
      install.sha = newSha;
      install.marker = marker;
      install.reinstallIdentical();
    },
    cleanup: function () {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
  return install;
}

module.exports = { makeInstall };

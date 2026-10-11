// File-scope policy shared by the WebSocket fs_* handlers, the HTTP file
// routes and the file/directory watchers: who may touch files, how a client
// supplied path is resolved, and how a file is read.
//
// Two rules hold everywhere this module is used:
//   - the fileBrowser permission is checked before any file is touched;
//   - in os-users mode a caller without a resolved OS identity is refused,
//     never served by a privileged read as the daemon user.

var fs = require("fs");
var path = require("path");

function isUsablePath(requested) {
  return typeof requested === "string" && requested.indexOf("\0") === -1;
}

// Resolve `requested` inside `base`, following symlinks. Null for anything
// that is not a string, holds a null byte, or lands outside `base`.
function safePath(base, requested) {
  if (!isUsablePath(requested)) return null;
  var resolved = path.resolve(base, requested);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  try {
    var real = fs.realpathSync(resolved);
    if (real !== base && !real.startsWith(base + path.sep)) return null;
    return real;
  } catch (e) {
    return null;
  }
}

// Resolve an absolute path without requiring it to be within a project root.
// Only used in os-users mode, where the kernel's ACLs decide access.
function safeAbsPath(requested) {
  if (!requested || !isUsablePath(requested)) return null;
  var resolved = path.resolve(requested);
  try {
    return fs.realpathSync(resolved);
  } catch (e) {
    return null;
  }
}

// Resolve a path inside the Claude data directory (~/.claude/), read-only
// fallback so plan files that live outside the project can be previewed.
function safeClaudePath(requested) {
  if (!requested || !isUsablePath(requested)) return null;
  var claudeDir = path.join(require("./config").REAL_HOME, ".claude");
  var resolved = path.resolve(requested);
  if (resolved !== claudeDir && !resolved.startsWith(claudeDir + path.sep)) return null;
  try {
    var real = fs.realpathSync(resolved);
    if (real !== claudeDir && !real.startsWith(claudeDir + path.sep)) return null;
    return real;
  } catch (e) {
    return null;
  }
}

// Returns an error string when the caller may not use file features, else null.
//   user          the authenticated user, if any
//   osUsers       whether os-users mode is on
//   osUserInfo    the caller's resolved OS identity, or null
//   usersModule   module exposing getEffectivePermissions(user, osUsers)
function checkFileAccess(o) {
  if (o.user) {
    var perms = o.usersModule.getEffectivePermissions(o.user, o.osUsers);
    if (!perms.fileBrowser) return "File browser access is not permitted";
  }
  if (o.osUsers && !o.osUserInfo) return "File access requires an OS user identity";
  return null;
}

// Path a caller may read or write: inside the project, or (os-users) wherever
// the OS grants that identity access. Used by writes and by the HTTP file route.
function resolveProjectPath(cwd, requested, osUserInfo) {
  var resolved = safePath(cwd, requested);
  if (!resolved && osUserInfo) resolved = safeAbsPath(requested);
  return resolved;
}

// Path a caller may read over the WebSocket: as above, plus read-only access
// inside ~/.claude (plan files).
function resolveReadPath(cwd, requested, osUserInfo) {
  return resolveProjectPath(cwd, requested, osUserInfo) || safeClaudePath(requested);
}

// A project-relative path for git, or null when the request is not a path
// that stays inside the project. The file need not exist (history can name
// deleted files), so this is lexical rather than a realpath check.
function resolveGitPath(cwd, requested) {
  if (!requested || !isUsablePath(requested)) return null;
  var abs = path.resolve(cwd, requested);
  if (abs === cwd || !abs.startsWith(cwd + path.sep)) return null;
  return path.relative(cwd, abs).split(path.sep).join("/");
}

// Read a file as the caller. Result kind: "text", "binary" or "too_large".
//   file, osUsers, osUserInfo, fsAsUser, maxSize, binaryExts
function readFileForUser(file, o) {
  if (o.osUsers && !o.osUserInfo) throw new Error("File access requires an OS user identity");
  var ext = path.extname(file).toLowerCase();
  var size = o.osUserInfo
    ? o.fsAsUser("stat", { file: file }, o.osUserInfo).size
    : fs.statSync(file).size;
  if (size > o.maxSize) return { kind: "too_large", size: size, ext: ext };
  if (o.binaryExts.has(ext)) return { kind: "binary", size: size, ext: ext };
  var content = o.osUserInfo
    ? o.fsAsUser("read", { file: file, readContent: true }, o.osUserInfo).content
    : fs.readFileSync(file, "utf8");
  return { kind: "text", size: size, content: content, ext: ext };
}

// List a directory as the caller: [{ name, isDir }].
function listDirForUser(dir, o) {
  if (o.osUsers && !o.osUserInfo) throw new Error("File access requires an OS user identity");
  if (o.osUserInfo) {
    return o.fsAsUser("list", { dir: dir }, o.osUserInfo).map(function (e) {
      return { name: e.name, isDir: !!e.isDir };
    });
  }
  return fs.readdirSync(dir, { withFileTypes: true }).map(function (d) {
    return { name: d.name, isDir: d.isDirectory() };
  });
}

// Binds the policy above to one project's settings so the WebSocket handlers
// and the watchers ask the same questions of the same code.
//   osUsers, usersModule, fsAsUser, binaryExts, maxSize
//   projectAccess       the lib/project-access.js resolver: a connection with no
//                       principal (no user in multi-user mode) is refused here
//                       as well, however it got this far
//   getOsUserInfoForWs(ws) -> the connection's OS identity, or null
function createFileAccess(deps) {
  function readOptions(ws) {
    return {
      osUsers: deps.osUsers,
      osUserInfo: deps.getOsUserInfoForWs(ws),
      fsAsUser: deps.fsAsUser,
      maxSize: deps.maxSize,
      binaryExts: deps.binaryExts,
    };
  }
  return {
    // Error string when this connection may not use file features, else null.
    authorize: function (ws) {
      if (deps.projectAccess && !deps.projectAccess.principalFor(ws._clagenticUser)) return "Authentication required";
      return checkFileAccess({
        user: ws._clagenticUser,
        osUsers: deps.osUsers,
        osUserInfo: deps.getOsUserInfoForWs(ws),
        usersModule: deps.usersModule,
      });
    },
    readFile: function (ws, file) { return readFileForUser(file, readOptions(ws)); },
    listDir: function (ws, dir) { return listDirForUser(dir, readOptions(ws)); },
  };
}

module.exports = {
  createFileAccess: createFileAccess,
  safePath: safePath,
  safeAbsPath: safeAbsPath,
  safeClaudePath: safeClaudePath,
  checkFileAccess: checkFileAccess,
  resolveReadPath: resolveReadPath,
  resolveProjectPath: resolveProjectPath,
  resolveGitPath: resolveGitPath,
  readFileForUser: readFileForUser,
  listDirForUser: listDirForUser,
};

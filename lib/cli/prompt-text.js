// lib/cli/prompt-text.js
//
// The one place the prompt text of open-session, send-input and
// schedule-input create is resolved on the caller's side, before the request is
// sent to the daemon (which may run with another working directory):
//
//   --prompt -            the text read from stdin
//   --prompt-file <path>  the text read from that file
//   --prompt @<path>      the whole value is one @-token naming an existing
//                         regular file: that file's text
//
// One trailing newline is removed from text read from stdin or a file. Any other
// --prompt value is sent as given, including an @-token that names no existing
// file; nothing here refuses a prompt for its shape.

var fs = require("fs");

var AT_FILE_RE = /^@(\S+)$/;

function defaultIsFile(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}

function reasonOf(e) {
  return e && e.message ? e.message : String(e);
}

// Resolves request.prompt / request.promptFile into request.prompt in place.
// The three readers are injectable for tests. Returns an error string or null.
function loadPrompt(request, readStdin, readFile, isFile) {
  readStdin = readStdin || function () { return fs.readFileSync(0, "utf8"); };
  readFile = readFile || function (p) { return fs.readFileSync(p, "utf8"); };
  isFile = isFile || defaultIsFile;
  if (request.promptFile !== undefined) {
    try { request.prompt = readFile(request.promptFile).replace(/\n$/, ""); }
    catch (e) { return "Cannot read --prompt-file " + request.promptFile + ": " + reasonOf(e); }
    delete request.promptFile;
    return null;
  }
  if (request.prompt === "-") {
    request.prompt = readStdin().replace(/\n$/, "");
    return null;
  }
  var atFile = typeof request.prompt === "string" ? AT_FILE_RE.exec(request.prompt) : null;
  if (atFile && isFile(atFile[1])) {
    try { request.prompt = readFile(atFile[1]).replace(/\n$/, ""); }
    catch (e) { return "Cannot read --prompt @" + atFile[1] + ": " + reasonOf(e); }
  }
  return null;
}

module.exports = { loadPrompt: loadPrompt };

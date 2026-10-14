"use strict";

// Lines worth keeping off the journal by default: they fire per stream event.
// Set CLAGENTIC_CONSOLE_DEBUG to see them. The variable is read at each call so
// an operator can start the daemon with it and a test can set it for one case.

var { readConsoleEnv } = require("./env-compat");

function debugEnabled() {
  return !!readConsoleEnv("CLAGENTIC_CONSOLE_DEBUG");
}

function debugLog(line) {
  if (debugEnabled()) console.log(line);
}

module.exports = { debugLog: debugLog, debugEnabled: debugEnabled };

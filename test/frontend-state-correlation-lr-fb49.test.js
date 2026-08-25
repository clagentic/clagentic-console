// frontend-state-correlation-lr-fb49.test.js — regression coverage for lr-fb49,
// a cluster of 7 "stale reference / missing correlation" frontend defects.
//
// The touched modules (app-connection.js, filebrowser.js, sidebar-projects.js,
// sidebar-sessions.js, scheduler.js) are ESM modules with heavy DOM + WS
// dependencies that this project's test runner does not exercise via a DOM
// harness (see the existing diagnostics-toast-dedup-placement-lr-e901.test.js
// and popover-position-lr-a10a.test.js convention) — these are source-text
// regression checks matching that same convention, asserting the fix is
// present and the specific old buggy pattern is gone.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

function readMod(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

var APP_CONNECTION_JS = readMod("lib/public/modules/app-connection.js");
var FILEBROWSER_JS = readMod("lib/public/modules/filebrowser.js");
var SIDEBAR_PROJECTS_JS = readMod("lib/public/modules/sidebar-projects.js");
var SIDEBAR_SESSIONS_JS = readMod("lib/public/modules/sidebar-sessions.js");
var SCHEDULER_JS = readMod("lib/public/modules/scheduler.js");
var PROJECT_SESSIONS_JS = readMod("lib/project-sessions.js");

// ---------------------------------------------------------------------------
// A — WS reconnect leaves old handlers attached
// ---------------------------------------------------------------------------

test("app-connection.js: connect() nulls onmessage and onerror (not just onclose) on the old socket", function () {
  var idx = APP_CONNECTION_JS.indexOf("export function connect()");
  assert.ok(idx !== -1, "expected connect() to be exported");
  var block = APP_CONNECTION_JS.slice(idx, idx + 500);

  assert.match(
    block,
    /if\s*\(ws\)\s*\{\s*ws\.onclose\s*=\s*null;\s*ws\.onmessage\s*=\s*null;\s*ws\.onerror\s*=\s*null;\s*ws\.close\(\);/,
    "connect() must null onclose, onmessage, AND onerror on the previous socket before closing it, " +
    "otherwise in-flight messages on the old socket still run through processMessage after the new " +
    "connection starts"
  );
});

test("app-connection.js: the 3s force-retry path also nulls onmessage on the timed-out socket", function () {
  var idx = APP_CONNECTION_JS.indexOf("force retry");
  assert.ok(idx !== -1, "expected the force-retry comment to exist");
  var block = APP_CONNECTION_JS.slice(idx, idx + 300);

  assert.match(block, /newWs\.onclose\s*=\s*null;/);
  assert.match(block, /newWs\.onerror\s*=\s*null;/);
  assert.match(
    block,
    /newWs\.onmessage\s*=\s*null;/,
    "the 3s force-retry path must also null onmessage on the abandoned socket before closing it"
  );
});

// ---------------------------------------------------------------------------
// B — filebrowser: request/response correlation
// ---------------------------------------------------------------------------

test("filebrowser.js: handleFsRead drops replies that don't match the in-flight request path", function () {
  var idx = FILEBROWSER_JS.indexOf("export function handleFsRead");
  assert.ok(idx !== -1);
  var block = FILEBROWSER_JS.slice(idx, idx + 600);
  assert.match(
    block,
    /if\s*\(msg\.path\s*!==\s*pendingReadPath\)\s*return;/,
    "handleFsRead must drop a reply whose path does not match the in-flight request"
  );
});

test("filebrowser.js: requestFileContent records the in-flight path for correlation", function () {
  var idx = FILEBROWSER_JS.indexOf("function requestFileContent");
  assert.ok(idx !== -1);
  var block = FILEBROWSER_JS.slice(idx, idx + 200);
  assert.match(block, /pendingReadPath\s*=\s*filePath;/);
});

test("filebrowser.js: pendingOpenMode carries the target path and is checked before applying a diff view", function () {
  var idx = FILEBROWSER_JS.indexOf("var pendingOpenMode = null;");
  assert.ok(idx !== -1);
  assert.match(FILEBROWSER_JS.slice(idx, idx + 500), /path:\s*filePath/);

  var showIdx = FILEBROWSER_JS.indexOf("pendingOpenMode && pendingOpenMode.path === msg.path");
  assert.ok(showIdx !== -1, "showFileContent must check pendingOpenMode.path against the reply's path before consuming it");
});

test("filebrowser.js: handleFileHistory drops replies for a file that is no longer open", function () {
  var idx = FILEBROWSER_JS.indexOf("export function handleFileHistory");
  assert.ok(idx !== -1);
  var block = FILEBROWSER_JS.slice(idx, idx + 500);
  assert.match(
    block,
    /if\s*\(msg\.path\s*!==\s*currentFilePath\)\s*return;/,
    "handleFileHistory must drop a fs_file_history_result for a path other than the currently open file"
  );
});

test("filebrowser.js: pendingFileAt carries the requested hash and handleFileAt only resolves on a matching hash", function () {
  var declIdx = FILEBROWSER_JS.indexOf("var pendingFileAt = null;");
  assert.ok(declIdx !== -1);

  var setterIdx = FILEBROWSER_JS.indexOf("pendingFileAt = {");
  assert.ok(setterIdx !== -1, "resolveEntryContent must set pendingFileAt as an object carrying the requested hash");
  assert.match(FILEBROWSER_JS.slice(setterIdx, setterIdx + 150), /hash:\s*entry\.hash/);

  var handlerIdx = FILEBROWSER_JS.indexOf("export function handleFileAt");
  assert.ok(handlerIdx !== -1);
  var handlerBlock = FILEBROWSER_JS.slice(handlerIdx, handlerIdx + 700);
  assert.match(
    handlerBlock,
    /pendingFileAt\s*&&\s*pendingFileAt\.hash\s*===\s*msg\.hash/,
    "handleFileAt must only resolve the pending callback when the reply's hash matches the pending request's hash " +
    "(single-slot pendingFileAt with no correlation was the lr-fb49-B defect)"
  );
});

// ---------------------------------------------------------------------------
// C — sidebar-projects: shadowed draggedFolderName broke folder drag-drop
// ---------------------------------------------------------------------------

test("sidebar-projects.js: the drop handler's local folder-name variable is no longer named draggedFolderName", function () {
  // The module-level state var (drag source: a whole folder being dragged).
  assert.match(
    SIDEBAR_PROJECTS_JS,
    /var draggedFolderName = null; \/\/ set when dragging a whole folder group/,
    "module-level draggedFolderName must still exist (whole-folder drag source)"
  );

  // The per-drop local that previously reused the same name (hoisted `var`
  // shadowing) must now be distinctly named.
  var dropIdx = SIDEBAR_PROJECTS_JS.indexOf("el.addEventListener(\"drop\"");
  assert.ok(dropIdx !== -1);
  var dropBlock = SIDEBAR_PROJECTS_JS.slice(dropIdx, dropIdx + 4500);

  assert.doesNotMatch(
    dropBlock,
    /var draggedFolderName = null;/,
    "the drop handler must not re-declare `var draggedFolderName` — that hoists to the top of this " +
    "same function and shadows the module-level draggedFolderName used by the whole-folder-drop check " +
    "earlier in the handler, silently disabling folder drag-and-drop reorder (lr-fb49-C)"
  );
  assert.match(
    dropBlock,
    /var draggedItemFolderName = null;/,
    "expected the renamed local (draggedItemFolderName) in the drop handler"
  );
});

// ---------------------------------------------------------------------------
// D — sidebar-projects: access-control PUTs need ok-check + rollback + toast
// ---------------------------------------------------------------------------

test("sidebar-projects.js: visibility PUT checks res.ok and rolls back + toasts on failure", function () {
  var idx = SIDEBAR_PROJECTS_JS.indexOf("/visibility\", {");
  assert.ok(idx !== -1);
  var block = SIDEBAR_PROJECTS_JS.slice(idx, idx + 900);

  assert.match(block, /if\s*\(!res\.ok\)\s*throw new Error/, "visibility PUT must check res.ok");
  assert.match(block, /\.catch\(function\s*\(\)\s*\{/, "visibility PUT must have a .catch rollback handler");
  assert.match(block, /visibility\s*=\s*prevVis;/, "failed visibility PUT must revert the optimistic UI state");
  assert.match(block, /showToast\(/, "failed visibility PUT must surface a toast");
});

test("sidebar-projects.js: allowed-users PUT checks res.ok and reverts the checkbox + toasts on failure", function () {
  var idx = SIDEBAR_PROJECTS_JS.indexOf("/users\", {");
  assert.ok(idx !== -1);
  var block = SIDEBAR_PROJECTS_JS.slice(idx, idx + 500);

  assert.match(block, /if\s*\(!res\.ok\)\s*throw new Error/, "allowed-users PUT must check res.ok");
  assert.match(block, /thisCb\.checked\s*=\s*wasChecked;/, "failed allowed-users PUT must revert the checkbox");
  assert.match(block, /showToast\(/, "failed allowed-users PUT must surface a toast");
});

test("sidebar-projects.js: toast strings added for access-control failures never use bare 'clagentic'", function () {
  var idx = SIDEBAR_PROJECTS_JS.indexOf("Failed to update project visibility");
  assert.ok(idx !== -1);
  assert.doesNotMatch(SIDEBAR_PROJECTS_JS.slice(idx - 5, idx + 200), /[^-_/@]clagentic(?!-console)/i);
});

// ---------------------------------------------------------------------------
// G — sidebar-projects: worktree modal handler leak + stale switchProject
// ---------------------------------------------------------------------------

test("sidebar-projects.js: showWorktreeModal guards getWs(), removes the listener on close, and times out", function () {
  var idx = SIDEBAR_PROJECTS_JS.indexOf("function showWorktreeModal");
  assert.ok(idx !== -1);
  var block = SIDEBAR_PROJECTS_JS.slice(idx, idx + 6000);

  assert.match(block, /function clearPendingCreate\(\)/, "expected a clearPendingCreate helper to tear down the listener + timeout");
  assert.match(block, /ws\.removeEventListener\("message",\s*pendingCreate\.handler\)/, "clearPendingCreate must remove the previous message listener");
  assert.match(block, /function closeModal\(\)\s*\{\s*clearPendingCreate\(\);/, "closeModal must clear the pending create listener");
  assert.match(block, /if\s*\(!ws\s*\|\|\s*!store\.get\('connected'\)\)/, "doCreate must null-guard getWs() before using it");
  assert.match(block, /setTimeout\(function\s*\(\)\s*\{\s*onFailure\("Timed out waiting for worktree creation"\);\s*\},\s*30000\);/, "expected a timeout on the create_worktree request");
  assert.match(block, /if\s*\(msg\.dirName\s*&&\s*msg\.dirName\s*!==\s*dirName\)\s*return;/, "the message handler must correlate on dirName and drop replies for a superseded request");
});

test("project-sessions.js: create_worktree_result includes dirName so the client can correlate replies", function () {
  var idx = PROJECT_SESSIONS_JS.indexOf('msg.type === "create_worktree"');
  assert.ok(idx !== -1);
  var block = PROJECT_SESSIONS_JS.slice(idx, idx + 900);
  var matches = block.match(/type:\s*"create_worktree_result"[^}]*\}/g) || [];
  assert.ok(matches.length >= 3, "expected at least 3 create_worktree_result sends (invalid branch, ok/fail result, not-supported)");
  for (var i = 0; i < matches.length; i++) {
    assert.match(matches[i], /dirName:/, "every create_worktree_result send must include dirName: " + matches[i]);
  }
});

// ---------------------------------------------------------------------------
// E — sidebar-sessions: session_list fingerprint dropped needed repaints
// ---------------------------------------------------------------------------

test("sidebar-sessions.js: _fingerprintSessions includes favoriteOrder, unread, and loop name/iteration/startedAt", function () {
  var idx = SIDEBAR_SESSIONS_JS.indexOf("function _fingerprintSessions");
  assert.ok(idx !== -1);
  var block = SIDEBAR_SESSIONS_JS.slice(idx, idx + 1200);

  assert.match(block, /s\.favoriteOrder/, "fingerprint must include favoriteOrder (drives favorites sort order)");
  assert.match(block, /s\.unread/, "fingerprint must include unread (drives the unread badge)");
  assert.match(block, /s\.loop\.name/, "fingerprint must include loop.name");
  assert.match(block, /s\.loop\.iteration/, "fingerprint must include loop.iteration");
  assert.match(block, /s\.loop\.startedAt/, "fingerprint must include loop.startedAt");
});

// ---------------------------------------------------------------------------
// F — sidebar-sessions + scheduler: inline rename / armed-delete vs list rebuild
//
// SUPERSEDED by lr-16b88d (MILLER fnd-fcdaf1): the original fix here made
// renderSessionList() force-commit an in-progress rename on every rebuild.
// That traded silent data loss for a worse regression — an actively
// streaming session broadcasts session_list many times per turn, so the
// rename committed within a keystroke or two, sending a partial title as a
// real rename_session (durable write + permanent titleManuallySet=true).
// The two tests below now assert the corrected contract: renderSessionList
// SUSPENDS (captures, does not commit/cancel/send) an in-progress rename,
// and re-opens it with the captured value + caret after a real rebuild.
// clearArmedSessionDelete() is unaffected by lr-16b88d and still asserted.
// ---------------------------------------------------------------------------

test("sidebar-sessions.js: renderSessionList suspends (not commits) an active rename before rebuilding, and clears armed-delete", function () {
  var idx = SIDEBAR_SESSIONS_JS.indexOf("export function renderSessionList");
  assert.ok(idx !== -1);
  var block = SIDEBAR_SESSIONS_JS.slice(idx, idx + 900);

  assert.match(
    block,
    /activeRename\s*\?\s*\{[\s\S]*?snapshot:\s*activeRename\.suspend\(\),[\s\S]*?\}\s*:\s*null/,
    "renderSessionList must SUSPEND (not commit) an in-progress rename before the DOM teardown — " +
    "force-committing on every rebuild is the lr-16b88d regression (partial title sent as a real " +
    "rename_session on nearly every broadcast from an actively-streaming session)"
  );
  assert.doesNotMatch(
    block,
    /if\s*\(activeRename\)\s*activeRename\.commit\(\);/,
    "renderSessionList must not unconditionally commit activeRename — that is the lr-16b88d regression"
  );
  assert.match(block, /clearArmedSessionDelete\(\);/, "renderSessionList must clear armed-delete state before the DOM teardown");
});

test("sidebar-sessions.js: renderSessionList re-opens a suspended rename after a real rebuild, restoring value + caret", function () {
  var idx = SIDEBAR_SESSIONS_JS.indexOf("export function renderSessionList");
  var endIdx = SIDEBAR_SESSIONS_JS.indexOf("// --- Search results ---", idx);
  assert.ok(idx !== -1 && endIdx !== -1 && endIdx > idx);
  var block = SIDEBAR_SESSIONS_JS.slice(idx, endIdx);

  assert.match(
    block,
    /if\s*\(suspendedRename\)\s*\{\s*if\s*\(suspendedRename\.type\s*===\s*"loop"\)\s*\{\s*startLoopInlineRename\(suspendedRename\.id,\s*suspendedRename\.currentTitle,\s*suspendedRename\.snapshot\);/,
    "the end of renderSessionList must re-open a suspended loop rename via startLoopInlineRename() with the captured snapshot"
  );
  assert.match(
    block,
    /startInlineRename\(suspendedRename\.id,\s*suspendedRename\.currentTitle,\s*suspendedRename\.snapshot\);/,
    "the end of renderSessionList must re-open a suspended session rename via startInlineRename() with the captured snapshot"
  );
});

test("sidebar-sessions.js: startInlineRename / startLoopInlineRename register activeRename with a non-settling suspend(), and guard double-settle", function () {
  assert.match(SIDEBAR_SESSIONS_JS, /var activeRename = null;/, "expected module-level activeRename tracking");

  var idx1 = SIDEBAR_SESSIONS_JS.indexOf("function startInlineRename");
  var idx1End = SIDEBAR_SESSIONS_JS.indexOf("function startLoopInlineRename");
  assert.ok(idx1 !== -1 && idx1End !== -1 && idx1End > idx1);
  var block1 = SIDEBAR_SESSIONS_JS.slice(idx1, idx1End);
  assert.match(block1, /var settled = false;/);
  assert.match(block1, /function suspendRename\(\)\s*\{\s*return\s*\{\s*value:\s*input\.value,\s*selectionStart:\s*input\.selectionStart,\s*selectionEnd:\s*input\.selectionEnd\s*\};\s*\}/,
    "startInlineRename must expose a suspendRename() that captures value + caret without touching `settled`");
  assert.match(block1, /type:\s*"session",/);
  assert.match(block1, /suspend:\s*suspendRename,/);

  var idx2 = idx1End;
  var idx2End = SIDEBAR_SESSIONS_JS.indexOf("// --- Date grouping", idx2);
  assert.ok(idx2End !== -1 && idx2End > idx2);
  var block2 = SIDEBAR_SESSIONS_JS.slice(idx2, idx2End);
  assert.match(block2, /var settled = false;/);
  assert.match(block2, /function suspendRename\(\)\s*\{\s*return\s*\{\s*value:\s*input\.value,\s*selectionStart:\s*input\.selectionStart,\s*selectionEnd:\s*input\.selectionEnd\s*\};\s*\}/,
    "startLoopInlineRename must expose a suspendRename() that captures value + caret without touching `settled`");
  assert.match(block2, /type:\s*"loop",/);
  assert.match(block2, /suspend:\s*suspendRename,/);
});

test("sidebar-sessions.js: startInlineRename / startLoopInlineRename restore a resumed value + caret via setSelectionRange, not select()", function () {
  var idx1 = SIDEBAR_SESSIONS_JS.indexOf("function startInlineRename");
  var idx1End = SIDEBAR_SESSIONS_JS.indexOf("function startLoopInlineRename");
  var block1 = SIDEBAR_SESSIONS_JS.slice(idx1, idx1End);
  assert.match(block1, /input\.value\s*=\s*resume\s*\?\s*resume\.value\s*:\s*\(currentTitle\s*\|\|\s*"New Session"\);/);
  assert.match(block1, /input\.setSelectionRange\(resume\.selectionStart,\s*resume\.selectionEnd\);/);

  var idx2 = idx1End;
  var idx2End = SIDEBAR_SESSIONS_JS.indexOf("// --- Date grouping", idx2);
  var block2 = SIDEBAR_SESSIONS_JS.slice(idx2, idx2End);
  assert.match(block2, /input\.value\s*=\s*resume\s*\?\s*resume\.value\s*:\s*\(currentName\s*\|\|\s*"Loop"\);/);
  assert.match(block2, /input\.setSelectionRange\(resume\.selectionStart,\s*resume\.selectionEnd\);/);
});

test("scheduler.js: Escape during loop-name edit cancels rather than committing via blur-on-detach", function () {
  var idx = SCHEDULER_JS.indexOf("Attach pencil edit handlers");
  assert.ok(idx !== -1, "expected the 'Attach pencil edit handlers' section");
  var block = SCHEDULER_JS.slice(idx, idx + 2000);

  assert.match(block, /var cancelled = false;/, "expected a cancelled flag guarding finishEdit");
  assert.match(block, /function finishEdit\(\)\s*\{\s*if\s*\(cancelled\)\s*return;/, "finishEdit must bail out early when cancelled");
  assert.match(
    block,
    /if\s*\(ev\.key === "Escape"\)\s*\{\s*ev\.preventDefault\(\);\s*cancelled\s*=\s*true;\s*renderSidebar\(\);\s*\}/,
    "Escape must set cancelled=true before triggering the rebuild, so the blur listener's finishEdit() " +
    "(fired synchronously when renderSidebar()'s innerHTML rebuild detaches the input) does not commit the rename"
  );
});

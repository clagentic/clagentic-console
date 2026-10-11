// The single-user owner has no user record: a connection the login gate lets
// through carries _clagenticUser === null and is the implicit owner. This
// drives a real server with a real WebSocket and HTTP client through every
// path the access gate touches, once with the daemon in single-user mode (the
// owner must see no regression anywhere) and once in multi-user mode (a
// request with no user is a stranger and is refused, never an exception).
//
// The login gate itself is stood in for: it admits every request and names no
// user, which is the state the rest of the server must handle. Everything past
// the gate is real code.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var { execFileSync } = require("child_process");
var harness = require("./access-harness");

var H = null;
var mode = { multiUser: false };
var HASH = null;

function projectCtx(slug) {
  var found = null;
  H.relay.forEachProject(function (ctx, s) { if (s === slug) found = ctx; });
  return found;
}

function ask(client, msg, type) {
  client.inbox.length = 0;
  client.send(msg);
  return client.waitFor(function (m) { return m.type === type; });
}

function git(dir, args) {
  return execFileSync("git", args, {
    cwd: dir, encoding: "utf8",
    env: Object.assign({}, process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }),
  });
}

test.before(async function () {
  H = await harness.start({
    multiUser: false,
    users: [],
    projects: [
      { slug: "mine", files: { "a.png": "png", "notes.txt": "one\n" } },
      { slug: "other" },
      { slug: "mine--wt", parent: "mine" },
    ],
    serverOpts: { isMultiUser: function () { return mode.multiUser; } },
    beforeServer: function () {
      var serverAuth = require("../lib/server-auth");
      var attach = serverAuth.attachAuth;
      serverAuth.attachAuth = function (deps) {
        return Object.assign({}, attach(deps), {
          getMultiUserFromReq: function () { return null; },
          isRequestAuthed: function () { return true; },
        });
      };
    },
  });
  var dir = H.dirs.mine;
  git(dir, ["init", "-q"]);
  git(dir, ["add", "notes.txt"]);
  git(dir, ["commit", "-q", "-m", "first"]);
  fs.writeFileSync(path.join(dir, "notes.txt"), "one\ntwo\n");
  git(dir, ["commit", "-q", "-am", "second"]);
  HASH = git(dir, ["rev-parse", "HEAD"]).trim();
});

test.after(async function () {
  if (H) await H.stop();
});

// --- single-user mode: the owner loses nothing ----------------------------------

test("single-user: the WebSocket upgrade admits the owner into every project, worktrees included", async function () {
  mode.multiUser = false;
  var mine = await H.connect("mine", null);
  assert.ok(mine.ok, "mine");
  assert.ok((await H.connect("other", null)).ok, "other");
  assert.ok((await H.connect("mine--wt", null)).ok, "a worktree slug");
  var info = await mine.waitFor(function (m) { return m.type === "info"; });
  assert.deepEqual(info.projects.map(function (p) { return p.slug; }).sort(), ["mine", "mine--wt", "other"], "the project list is the full list");
});

test("single-user: global CLAUDE.md, shared env and project env work for the owner", async function () {
  mode.multiUser = false;
  var c = await H.connect("mine", null);
  assert.equal((await ask(c, { type: "write_global_claude_md", content: "# owner" }, "write_global_claude_md_result")).ok, true);
  assert.equal((await ask(c, { type: "read_global_claude_md" }, "global_claude_md_result")).content, "# owner");
  assert.ok(await ask(c, { type: "get_shared_env" }, "shared_env_result"));
  var shared = await ask(c, { type: "set_shared_env", envrc: "A=1" }, "set_shared_env_result");
  assert.doesNotMatch(String(shared.error), /Admin access/);
  var env = await ask(c, { type: "get_project_env", slug: "someone-elses" }, "project_env_result");
  assert.equal(env.slug, "mine", "the env of the connected project, whatever slug the message carries");
});

test("single-user: files, search, history, diff and file-at work for the owner", async function () {
  mode.multiUser = false;
  var c = await H.connect("mine", null);
  var listing = await ask(c, { type: "fs_list", path: "." }, "fs_list_result");
  assert.deepEqual(listing.entries.map(function (e) { return e.name; }).sort(), ["a.png", "notes.txt"]);
  assert.equal((await ask(c, { type: "fs_read", path: "notes.txt" }, "fs_read_result")).content, "one\ntwo\n");
  assert.equal((await ask(c, { type: "fs_search", query: "notes" }, "fs_search_result")).entries[0].path, "notes.txt");
  var history = await ask(c, { type: "fs_file_history", path: "notes.txt" }, "fs_file_history_result");
  assert.equal(history.entries.filter(function (e) { return e.source === "git"; }).length, 2);
  assert.match((await ask(c, { type: "fs_git_diff", path: "notes.txt", hash: HASH }, "fs_git_diff_result")).diff, /\+two/);
  assert.equal((await ask(c, { type: "fs_file_at", path: "notes.txt", hash: HASH }, "fs_file_at_result")).content, "one\ntwo\n");
});

test("single-user: a message naming another project is handled there, with and without targetSlug", async function () {
  mode.multiUser = false;
  var c = await H.connect("mine", null);
  assert.equal((await ask(c, { type: "get_project_env", targetSlug: "other" }, "project_env_result")).slug, "other");
  assert.equal((await ask(c, { type: "get_project_env", targetSlug: "mine" }, "project_env_result")).slug, "mine");
  assert.equal((await ask(c, { type: "get_project_env" }, "project_env_result")).slug, "mine");
  var gone = await ask(c, { type: "get_project_env", targetSlug: "nowhere" }, "error");
  assert.match(gone.text, /not found or access denied/);
});

test("single-user: sessions of every owner can be renamed, searched and deleted by the owner", async function () {
  mode.multiUser = false;
  var sm = projectCtx("mine").sm;
  var theirs = sm.createSessionRaw({ ownerId: "a-former-user", sessionVisibility: "private" });
  theirs.title = "legacy-private-session";
  var c = await H.connect("mine", null);
  c.send({ type: "rename_session", id: theirs.localId, title: "owner-renamed" });
  await harness.settle(200);
  assert.equal(sm.sessions.get(theirs.localId).title, "owner-renamed");
  var found = await ask(c, { type: "search_sessions", query: "owner-renamed" }, "search_results");
  assert.equal(found.results.length, 1);
  var content = await ask(c, { type: "search_session_content", id: theirs.localId, query: { not: "text" } }, "search_content_results");
  assert.equal(content.query, "", "a query that is not text is neither searched nor echoed");
  c.send({ type: "delete_session", id: theirs.localId });
  await harness.settle(200);
  assert.equal(sm.sessions.has(theirs.localId), false);
});

test("single-user: the project routes, root redirect, image route and palette serve the owner", async function () {
  mode.multiUser = false;
  assert.equal((await H.request("GET", "/p/mine/", null)).status, 200);
  assert.equal((await H.request("GET", "/p/mine--wt/", null)).status, 200);
  var root = await H.request("GET", "/", null);
  assert.equal(root.status, 302);
  assert.match(root.headers.location, /^\/p\/[a-z-]+\/$/);
  var image = await H.request("GET", "/p/mine/api/file?path=a.png", null);
  assert.equal(image.status, 200);
  assert.equal(image.headers["content-type"], "image/png");

  var s = projectCtx("other").sm.createSessionRaw({ ownerId: "a-former-user", sessionVisibility: "private" });
  s.title = "palette-owner-sees-this";
  var palette = await H.request("GET", "/api/palette/search?q=palette-owner", null);
  assert.equal(palette.status, 200);
  assert.deepEqual(JSON.parse(palette.body).results.map(function (r) { return r.sessionTitle; }), ["palette-owner-sees-this"]);
  var recent = JSON.parse((await H.request("GET", "/api/palette/search", null)).body).results;
  assert.ok(recent.some(function (r) { return r.sessionTitle === "palette-owner-sees-this"; }));
});

test("single-user: project list broadcasts and renames reach the owner with every project", async function () {
  mode.multiUser = false;
  var c = await H.connect("mine", null);
  H.relay.broadcastAll({ type: "projects_updated", marker: "su-list", projects: H.relay.getProjects(), projectCount: 99 });
  var update = await c.waitFor(function (m) { return m.marker === "su-list"; });
  assert.equal(update.projects.length, 3);
  assert.equal(update.projectCount, 3);
  H.relay.setProjectTitle("mine", "Renamed Mine");
  var info = await c.waitFor(function (m) { return m.type === "info" && m.project === "Renamed Mine"; });
  assert.equal(info.projects.length, 3);
});

test("single-user: the local MCP bridge still answers with no login", async function () {
  mode.multiUser = false;
  var bridge = await H.request("POST", "/p/mine/api/mcp-bridge", null, { action: "no-such-action" });
  assert.equal(bridge.status, 400);
});

// --- multi-user mode: no user is a stranger, and nothing throws -------------------

test("multi-user: a request with no user is refused on every path and the server keeps serving", async function () {
  mode.multiUser = true;
  try {
    assert.equal((await H.connect("mine", null)).status, 401, "WS upgrade");
    assert.equal((await H.connect("mine--wt", null)).status, 401, "WS upgrade, worktree");
    assert.equal((await H.connect("no-such-project", null)).status, 401, "WS upgrade, unknown project");
    assert.equal((await H.request("GET", "/p/mine/", null)).status, 302, "/p/<slug>");
    assert.equal((await H.request("GET", "/p/mine/", null)).headers.location, "/");
    assert.equal((await H.request("GET", "/p/mine/api/file?path=a.png", null)).status, 302, "/api/file");
    assert.equal((await H.request("GET", "/api/palette/search", null)).status, 401, "palette");
    assert.equal((await H.request("GET", "/api/palette/search?q=x", null)).status, 401, "palette search");
    var root = await H.request("GET", "/", null);
    assert.equal(root.status, 200, "the root never redirects to a project for a stranger");
    assert.equal((await H.request("GET", "/api/health", null)).status, 200, "the server is still up");
  } finally {
    mode.multiUser = false;
  }
});

test("multi-user: a connection that was admitted in single-user mode is refused once the mode is multi-user", async function () {
  mode.multiUser = false;
  var c = await H.connect("mine", null);
  assert.equal((await ask(c, { type: "get_project_env" }, "project_env_result")).slug, "mine");
  mode.multiUser = true;
  try {
    var refused = await ask(c, { type: "fs_read", path: "notes.txt" }, "error");
    assert.match(refused.text, /not found or access denied/);
    var settings = await ask(c, { type: "read_global_claude_md" }, "error");
    assert.match(settings.text, /not found or access denied/);
    H.relay.broadcastAll({ type: "projects_updated", marker: "mu-list", projects: H.relay.getProjects(), projectCount: 99 });
    var update = await c.waitFor(function (m) { return m.marker === "mu-list"; });
    assert.deepEqual(update.projects, [], "a stranger is sent no projects");
  } finally {
    mode.multiUser = false;
  }
});

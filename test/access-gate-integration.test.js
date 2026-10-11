// Project access control, end to end: a real server, real login cookies and
// real WebSocket clients. Each test names the gap it closes; every one of them
// failed against the code before the central access gate and passes now.
//
// Caller shapes covered here: the single-user owner (an admin, the live
// deployment), multi-user members and owners, worktree slugs, WS messages with
// and without targetSlug, plain and unauthenticated HTTP, and the local MCP
// bridge.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var harness = require("./access-harness");

var H = null;

function sessionCount(slug) {
  var n = null;
  H.relay.forEachProject(function (ctx, s) { if (s === slug) n = ctx.sm.sessions.size; });
  return n;
}

function projectCtx(slug) {
  var found = null;
  H.relay.forEachProject(function (ctx, s) { if (s === slug) found = ctx; });
  return found;
}

function slugsOf(msg) {
  return msg.projects.map(function (p) { return p.slug; }).sort();
}

test.before(async function () {
  H = await harness.start({
    users: [
      { key: "admin", username: "owner-admin", role: "admin" },
      { key: "alice", username: "alice", permissions: { sessionDelete: true } },
      { key: "bob", username: "bob", permissions: { sessionDelete: true } },
      { key: "carol", username: "carol", permissions: { fileBrowser: false } },
    ],
    projects: [
      { slug: "pub", visibility: "public", ownerKey: "bob", files: { "a.png": "png", "notes.txt": "hello" } },
      { slug: "priv", visibility: "private", ownerKey: "bob", files: { "secret.png": "png" } },
      { slug: "priv--wt", parent: "priv" },
      { slug: "ghost", noRecord: true },
      { slug: "nov", ownerKey: "bob" },
    ],
  });
});

test.after(async function () {
  if (H) await H.stop();
});

// --- targetSlug forwarding -------------------------------------------------

test("a message naming a project the user cannot use is refused, and nothing happens there", async function () {
  var c = await H.connect("pub", "alice");
  assert.ok(c.ok);
  var before = sessionCount("priv");
  c.send({ type: "new_session", targetSlug: "priv" });
  var err = await c.waitFor(function (m) { return m.type === "error"; });
  assert.match(err.text, /access denied/i);
  await harness.settle();
  assert.equal(sessionCount("priv"), before, "the private project was not touched");
});

test("a message naming a project that does not exist is dropped, not handled in the current project", async function () {
  var c = await H.connect("pub", "alice");
  var before = sessionCount("pub");
  c.send({ type: "new_session", targetSlug: "no-such-project" });
  await c.waitFor(function (m) { return m.type === "error"; });
  await harness.settle();
  assert.equal(sessionCount("pub"), before, "the message did not fall through to the current project");
});

test("a message naming a project the user may use is handled there, with the slug removed", async function () {
  var c = await H.connect("pub", "bob");
  var before = sessionCount("priv");
  var beforeHere = sessionCount("pub");
  c.send({ type: "new_session", targetSlug: "priv" });
  await harness.settle(400);
  assert.equal(sessionCount("priv"), before + 1, "the owner's message reached the project it named");
  assert.equal(sessionCount("pub"), beforeHere, "and was not also handled in the current project");
});

test("a message with no targetSlug, or one naming the current project, is handled in the current project", async function () {
  var c = await H.connect("pub", "alice");
  var before = sessionCount("pub");
  c.send({ type: "new_session" });
  await harness.settle(300);
  c.send({ type: "new_session", targetSlug: "pub" });
  await harness.settle(300);
  assert.equal(sessionCount("pub"), before + 2);
});

test("a targetSlug that is not a string is refused", async function () {
  var c = await H.connect("pub", "alice");
  var before = sessionCount("pub");
  c.send({ type: "new_session", targetSlug: { toString: "x" } });
  await c.waitFor(function (m) { return m.type === "error"; });
  await harness.settle();
  assert.equal(sessionCount("pub"), before);
});

test("a frame that is not a JSON object does not take the server down", async function () {
  var c = await H.connect("pub", "alice");
  c.ws.send("null");
  c.ws.send("17");
  c.ws.send("[1,2]");
  c.ws.send("\"text\"");
  await harness.settle(200);
  c.send({ type: "new_session" });
  await harness.settle(200);
  var again = await H.connect("pub", "alice");
  assert.ok(again.ok, "the server still accepts connections");
});

// --- Access lookups fail closed --------------------------------------------

test("a project whose access cannot be established refuses the WebSocket upgrade, even for an administrator", async function () {
  assert.equal((await H.connect("ghost", "alice")).status, 403);
  assert.equal((await H.connect("ghost", "admin")).status, 403);
});

test("a project record with no visibility is private: only its owner and administrators connect", async function () {
  assert.equal((await H.connect("nov", "alice")).status, 403);
  assert.ok((await H.connect("nov", "bob")).ok);
  assert.ok((await H.connect("nov", "admin")).ok);
});

test("a worktree of a private project takes its parent's access", async function () {
  assert.equal((await H.connect("priv--wt", "alice")).status, 403);
  assert.ok((await H.connect("priv--wt", "bob")).ok);
});

test("the single-user owner (an administrator) reaches every project that has an access record", async function () {
  assert.ok((await H.connect("pub", "admin")).ok);
  assert.ok((await H.connect("priv", "admin")).ok);
  assert.ok((await H.connect("priv--wt", "admin")).ok);
});

test("the HTTP project route refuses a project whose access cannot be established", async function () {
  var ghost = await H.request("GET", "/p/ghost/", "alice");
  assert.equal(ghost.status, 302);
  assert.equal(ghost.headers.location, "/");
  assert.equal((await H.request("GET", "/p/ghost/", "admin")).status, 302);
  assert.equal((await H.request("GET", "/p/priv/", "alice")).status, 302);
  assert.equal((await H.request("GET", "/p/pub/", "alice")).status, 200);
  assert.equal((await H.request("GET", "/p/priv/", "admin")).status, 200);
});

test("the root redirect never lands on a project the user cannot use", async function () {
  var res = await H.request("GET", "/", "alice", undefined, { Cookie: H.cookies.alice + "; clagentic_last_project=ghost" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/p/pub/");
});

test("the local MCP bridge keeps working with no login; other unauthenticated project calls are refused", async function () {
  var bridge = await H.request("POST", "/p/priv/api/mcp-bridge", null, { action: "no-such-action" });
  assert.equal(bridge.status, 400, "reaches the bridge handler without a login");
  var upload = await H.request("POST", "/p/pub/api/upload", null, { name: "x", data: "eA==" });
  assert.equal(upload.status, 401);
});

test("the palette leaves out projects whose access cannot be established and sessions the user cannot see", async function () {
  var ghost = projectCtx("ghost").sm.createSessionRaw({ ownerId: H.people.bob.id });
  ghost.title = "palette-ghost-session";
  var pub = projectCtx("pub").sm.createSessionRaw({ ownerId: H.people.bob.id, sessionVisibility: "private" });
  pub.title = "palette-bobs-private-session";
  var shared = projectCtx("pub").sm.createSessionRaw({ ownerId: H.people.bob.id });
  shared.title = "palette-shared-session";

  var recent = JSON.parse((await H.request("GET", "/api/palette/search", "alice")).body).results;
  var titles = recent.map(function (r) { return r.sessionTitle; });
  assert.ok(titles.indexOf("palette-shared-session") !== -1, "alice sees a shared session in a project she can use");
  assert.equal(titles.indexOf("palette-ghost-session"), -1);
  assert.equal(titles.indexOf("palette-bobs-private-session"), -1);

  var found = JSON.parse((await H.request("GET", "/api/palette/search?q=palette", "alice")).body).results;
  var foundTitles = found.map(function (r) { return r.sessionTitle; });
  assert.equal(foundTitles.indexOf("palette-ghost-session"), -1);
  assert.equal(foundTitles.indexOf("palette-bobs-private-session"), -1);
  assert.ok(foundTitles.indexOf("palette-shared-session") !== -1);

  var asBob = JSON.parse((await H.request("GET", "/api/palette/search", "bob")).body).results.map(function (r) { return r.sessionTitle; });
  assert.ok(asBob.indexOf("palette-bobs-private-session") !== -1, "an owner still sees their own private session");
});

// --- Project lists reach each user filtered ----------------------------------

test("a project-list broadcast gives each client only the projects its user may see", async function () {
  var alice = await H.connect("pub", "alice");
  var bob = await H.connect("pub", "bob");
  var admin = await H.connect("pub", "admin");
  H.relay.broadcastAll({ type: "projects_updated", marker: "list-1", projects: H.relay.getProjects(), projectCount: 99 });
  var forAlice = await alice.waitFor(function (m) { return m.marker === "list-1"; });
  var forBob = await bob.waitFor(function (m) { return m.marker === "list-1"; });
  var forAdmin = await admin.waitFor(function (m) { return m.marker === "list-1"; });
  assert.deepEqual(slugsOf(forAlice), ["pub"]);
  assert.equal(forAlice.projectCount, 1);
  assert.deepEqual(slugsOf(forBob), ["nov", "priv", "priv--wt", "pub"]);
  assert.deepEqual(slugsOf(forAdmin), ["nov", "priv", "priv--wt", "pub"]);
});

test("renaming a project sends each client the project list its user may see", async function () {
  var alice = await H.connect("pub", "alice");
  H.relay.setProjectTitle("pub", "Renamed Public");
  var info = await alice.waitFor(function (m) { return m.type === "info" && m.project === "Renamed Public"; });
  assert.deepEqual(slugsOf(info), ["pub"]);
  assert.equal(info.projectCount, 1);
});

test("a connecting client is sent only the projects its user may see", async function () {
  var alice = await H.connect("pub", "alice");
  var info = await alice.waitFor(function (m) { return m.type === "info"; });
  assert.deepEqual(slugsOf(info), ["pub"]);
});

test("schedules are listed and broadcast only for projects the user may see", async function () {
  projectCtx("priv").importSchedule({ name: "schedule-in-private-project" });
  var alice = await H.connect("pub", "alice");
  var bob = await H.connect("pub", "bob");

  projectCtx("pub").importSchedule({ name: "schedule-in-public-project" });
  var aliceUpdate = await alice.waitFor(function (m) {
    return m.type === "loop_registry_updated" && m.records.some(function (r) { return r.name === "schedule-in-public-project"; });
  });
  var bobUpdate = await bob.waitFor(function (m) {
    return m.type === "loop_registry_updated" && m.records.some(function (r) { return r.name === "schedule-in-public-project"; });
  });
  assert.equal(aliceUpdate.records.some(function (r) { return r.name === "schedule-in-private-project"; }), false);
  assert.equal(bobUpdate.records.some(function (r) { return r.name === "schedule-in-private-project"; }), true);

  alice.send({ type: "hub_schedules_list" });
  var hub = await alice.waitFor(function (m) { return m.type === "hub_schedules"; });
  assert.deepEqual(hub.schedules.map(function (r) { return r.name; }).sort(), ["schedule-in-public-project"]);
  bob.send({ type: "hub_schedules_list" });
  var bobHub = await bob.waitFor(function (m) { return m.type === "hub_schedules"; });
  assert.deepEqual(bobHub.schedules.map(function (r) { return r.name; }).sort(), ["schedule-in-private-project", "schedule-in-public-project"]);
});

// --- Sessions: rename, delete, search --------------------------------------

async function privateSessionOfBob(title) {
  var s = projectCtx("pub").sm.createSessionRaw({ ownerId: H.people.bob.id, sessionVisibility: "private" });
  s.title = title;
  return s;
}

test("another user's private session cannot be renamed, deleted or searched", async function () {
  var secret = await privateSessionOfBob("bobs-confidential-plan");
  var alice = await H.connect("pub", "alice");
  var sm = projectCtx("pub").sm;

  alice.send({ type: "rename_session", id: secret.localId, title: "hijacked" });
  await harness.settle(200);
  assert.equal(sm.sessions.get(secret.localId).title, "bobs-confidential-plan");

  alice.send({ type: "delete_session", id: secret.localId });
  await harness.settle(200);
  assert.ok(sm.sessions.has(secret.localId), "the session was not deleted");

  alice.send({ type: "search_sessions", query: "confidential" });
  var results = await alice.waitFor(function (m) { return m.type === "search_results"; });
  assert.deepEqual(results.results, [], "the title of a private session is not revealed");

  alice.send({ type: "search_session_content", id: secret.localId, query: "x" });
  await harness.settle(200);
  assert.equal(alice.inbox.filter(function (m) { return m.type === "search_content_results"; }).length, 0);

  alice.send({ type: "bulk_delete_sessions", sessionIds: [secret.localId] });
  await harness.settle(200);
  assert.ok(sm.sessions.has(secret.localId), "a bulk delete leaves it too");
});

test("a user can still rename, search and delete the sessions they may see", async function () {
  var sm = projectCtx("pub").sm;
  var mine = sm.createSessionRaw({ ownerId: H.people.alice.id });
  mine.title = "alices-own-session";
  var alice = await H.connect("pub", "alice");
  alice.send({ type: "rename_session", id: mine.localId, title: "alices-renamed" });
  await harness.settle(200);
  assert.equal(sm.sessions.get(mine.localId).title, "alices-renamed");

  alice.send({ type: "search_sessions", query: "alices-renamed" });
  var results = await alice.waitFor(function (m) { return m.type === "search_results" && m.query === "alices-renamed"; });
  assert.equal(results.results.length, 1);

  alice.send({ type: "delete_session", id: mine.localId });
  await harness.settle(200);
  assert.equal(sm.sessions.has(mine.localId), false);
});

test("the owner of a session, and an administrator, can act on it", async function () {
  var sm = projectCtx("pub").sm;
  var s = await privateSessionOfBob("bobs-session-for-admin");
  var bob = await H.connect("pub", "bob");
  bob.send({ type: "rename_session", id: s.localId, title: "bobs-renamed" });
  await harness.settle(200);
  assert.equal(sm.sessions.get(s.localId).title, "bobs-renamed");
});

// --- File route -------------------------------------------------------------

test("the HTTP file route needs the fileBrowser permission", async function () {
  var withPermission = await H.request("GET", "/p/pub/api/file?path=a.png", "alice");
  assert.equal(withPermission.status, 200);
  assert.equal(withPermission.headers["content-type"], "image/png");
  assert.equal((await H.request("GET", "/p/pub/api/file?path=a.png", "carol")).status, 403);
  assert.equal((await H.request("GET", "/p/pub/api/file?path=a.png", null)).status, 401);
  assert.equal((await H.request("GET", "/p/pub/api/file?path=" + encodeURIComponent("../priv/secret.png"), "alice")).status, 403);
  assert.equal((await H.request("GET", "/p/pub/api/file?path=" + encodeURIComponent("a.png\u0000.txt"), "alice")).status, 403);
});

test("the single-user owner reads files and the global CLAUDE.md as before", async function () {
  var admin = await H.connect("pub", "admin");
  admin.send({ type: "fs_list", path: "." });
  var listing = await admin.waitFor(function (m) { return m.type === "fs_list_result"; });
  assert.deepEqual(listing.entries.map(function (e) { return e.name; }).sort(), ["a.png", "notes.txt"]);
  admin.send({ type: "fs_read", path: "notes.txt" });
  var read = await admin.waitFor(function (m) { return m.type === "fs_read_result"; });
  assert.equal(read.content, "hello");
  admin.send({ type: "write_global_claude_md", content: "# owner" });
  assert.equal((await admin.waitFor(function (m) { return m.type === "write_global_claude_md_result"; })).ok, true);
  admin.send({ type: "read_global_claude_md" });
  assert.equal((await admin.waitFor(function (m) { return m.type === "global_claude_md_result"; })).content, "# owner");
});

// --- WebSocket origin -------------------------------------------------------

test("a same-port origin on a different host is refused; the daemon's own host is accepted", async function () {
  var own = "http://127.0.0.1:" + H.port;
  assert.ok((await H.connect("pub", "alice", { headers: { Origin: own } })).ok);
  assert.equal((await H.connect("pub", "alice", { headers: { Origin: "http://evil.example:" + H.port } })).status, 403);
  assert.equal((await H.connect("pub", "alice", { headers: { Origin: "http://localhost:" + H.port } })).status, 403);
  assert.equal((await H.connect("pub", "alice", { headers: { Origin: "https://127.0.0.1:" + H.port } })).ok, true, "scheme is not compared when the daemon cannot know it");
});

test("a client with no Origin (CLI, relay) is accepted; a login is still required", async function () {
  assert.ok((await H.connect("pub", "alice")).ok);
  assert.equal((await H.connect("pub", null)).status, 401);
});

test("an extension origin is refused unless the operator allow-lists it", async function () {
  var origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  assert.equal((await H.connect("pub", "alice", { headers: { Origin: origin } })).status, 403);
});

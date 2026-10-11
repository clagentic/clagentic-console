"use strict";
// A project's environment text is removed when its owner changes, so the
// previous owner's text never reaches the new owner's sessions. Driven the way
// a user causes it: the transfer_project_owner WebSocket message, through the
// real project context, into the daemon's own removal function (the same one
// lib/daemon.js calls in onProjectOwnerChanged), with the daemon's settings
// store answering the Settings page afterwards.

var test = require("node:test");
var assert = require("node:assert/strict");

var harness = require("./access-harness");
var { createEnvSettings, removeEnvrcOnOwnerChange } = require("../lib/daemon-env-settings");

var config = { sharedEnv: "", projects: [{ slug: "alpha" }] };
var server = null;
var firstOwnerWs = null;
var secondOwnerWs = null;

// What lib/daemon.js does for the project record when ownership moves.
function onProjectOwnerChanged(slug, ownerId) {
  config.projects.forEach(function (project) {
    if (project.slug !== slug) return;
    var oldOwnerId = project.ownerId || null;
    project.ownerId = ownerId;
    removeEnvrcOnOwnerChange(project, oldOwnerId, ownerId);
  });
}

var envSettings = createEnvSettings({
  getConfig: function () { return config; },
  saveConfig: function () {},
});

test.before(async function () {
  server = await harness.start({
    users: [
      { key: "first", username: "first", permissions: { projectSettings: true } },
      { key: "second", username: "second", permissions: { projectSettings: true } },
    ],
    projects: [{ slug: "alpha", ownerKey: "first", visibility: "public" }],
    serverOpts: Object.assign({ onProjectOwnerChanged: onProjectOwnerChanged }, envSettings),
  });
  config.projects[0].ownerId = server.people.first.id;
  firstOwnerWs = await server.connect("alpha", "first");
  secondOwnerWs = await server.connect("alpha", "second");
  assert.equal(firstOwnerWs.ok && secondOwnerWs.ok, true);
});

test.after(async function () {
  if (server) await server.stop();
});

async function readProjectEnv(client) {
  client.inbox.length = 0;
  client.send({ type: "get_project_env" });
  return client.waitFor(function (m) { return m.type === "project_env_result"; });
}

test("transferring a project removes the previous owner's variables and the new owner starts with none", async function () {
  firstOwnerWs.inbox.length = 0;
  firstOwnerWs.send({ type: "set_project_env", envrc: "export FIRST_OWNERS=secret" });
  var saved = await firstOwnerWs.waitFor(function (m) { return m.type === "set_project_env_result"; });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(config.projects[0].envrc, "export FIRST_OWNERS=secret");

  firstOwnerWs.inbox.length = 0;
  firstOwnerWs.send({ type: "transfer_project_owner", userId: server.people.second.id });
  await firstOwnerWs.waitFor(function (m) { return m.type === "project_owner_changed"; });

  assert.equal("envrc" in config.projects[0], false, "the text is gone from the project record");
  assert.equal(config.projects[0].ownerId, server.people.second.id);

  var read = await readProjectEnv(secondOwnerWs);
  assert.equal(read.envrc, "", "the new owner is shown nothing");
  assert.equal(JSON.stringify(read).indexOf("FIRST_OWNERS"), -1);
});

test("saving again to the same owner keeps the text", function () {
  var project = { ownerId: "u1", envrc: "A=1" };
  assert.equal(removeEnvrcOnOwnerChange(project, "u1", "u1"), false);
  assert.equal(project.envrc, "A=1");
  assert.equal(removeEnvrcOnOwnerChange(project, null, null), false);
  assert.equal(project.envrc, "A=1");
});

test("clearing the owner removes the text too, and a project with no text is left alone", function () {
  var project = { ownerId: "u1", envrc: "A=1" };
  assert.equal(removeEnvrcOnOwnerChange(project, "u1", null), true);
  assert.equal("envrc" in project, false);
  assert.equal(removeEnvrcOnOwnerChange(project, "u1", "u2"), false);
  assert.equal(removeEnvrcOnOwnerChange(null, "u1", "u2"), false);
});

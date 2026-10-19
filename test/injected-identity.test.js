import test from "node:test";
import assert from "node:assert/strict";

import { resolveInjectedIdentity } from "../lib/public/modules/injected-identity.js";
import { mateAvatarUrl } from "../lib/public/modules/avatar.js";

const declared = (name) => ({ senderKind: "declared", fromName: name, initiator: "trigger", contextNote: "n" });

test("a sender matching a mate id takes that mate's name and avatar", () => {
  const mates = [{ id: "mate-7", name: "Reviewer", avatarStyle: "micah", avatarSeed: "rev" }];
  const r = resolveInjectedIdentity(declared("mate-7"), "mate-7", mates, 36);
  assert.equal(r.matched, true);
  assert.equal(r.name, "Reviewer");
  assert.equal(r.avatarUrl, mateAvatarUrl(mates[0], 36));
});

test("a sender matching an agentName takes that agent's name and avatar", () => {
  const agents = [{ id: "a1", name: "Lore Agent", agentName: "lore-a3" }];
  const r = resolveInjectedIdentity(declared("Lore-A3"), "Lore-A3", agents, 36);
  assert.equal(r.matched, true);
  assert.equal(r.name, "Lore Agent");
  assert.equal(r.avatarUrl, mateAvatarUrl(agents[0], 36));
});

test("no match: the same string gets the same seeded avatar, another string a different one", () => {
  const a1 = resolveInjectedIdentity(declared("lane-a"), "lane-a", [], 36);
  const a2 = resolveInjectedIdentity(declared("lane-a"), "lane-a", [], 36);
  const b = resolveInjectedIdentity(declared("lane-b"), "lane-b", [], 36);
  assert.equal(a1.matched, false);
  assert.equal(a1.name, "lane-a");
  assert.equal(a1.avatarUrl, a2.avatarUrl);
  assert.notEqual(a1.avatarUrl, b.avatarUrl);
  assert.equal(a1.avatarUrl, mateAvatarUrl({ avatarStyle: "bottts", avatarSeed: "lane-a" }, 36));
});

test("undeclared sender: fixed seed, fixed name, never matched", () => {
  const known = [{ id: "undeclared sender", name: "Operator" }];
  const r = resolveInjectedIdentity({ senderKind: "undeclared", initiator: "trigger" }, undefined, known, 36);
  assert.equal(r.matched, false);
  assert.equal(r.name, "Undeclared sender");
  assert.equal(r.avatarUrl, mateAvatarUrl({ avatarStyle: "bottts", avatarSeed: "undeclared-sender" }, 36));
});

test("legacy entry: fixed seed, sender-not-recorded name", () => {
  const r = resolveInjectedIdentity({ senderKind: "unrecorded", initiator: "trigger" }, undefined, [], 36);
  assert.equal(r.matched, false);
  assert.equal(r.name, "injected (sender not recorded)");
  assert.equal(r.avatarUrl, mateAvatarUrl({ avatarStyle: "bottts", avatarSeed: "unrecorded-sender" }, 36));
  assert.notEqual(
    r.avatarUrl,
    resolveInjectedIdentity({ senderKind: "undeclared" }, undefined, [], 36).avatarUrl
  );
});

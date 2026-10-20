import test from "node:test";
import assert from "node:assert/strict";

import { injectedSenderName, injectedLabel, injectedFromMessage } from "../lib/public/modules/injected-label.js";

test("operator-typed message has no injected descriptor", () => {
  assert.equal(injectedFromMessage({ type: "user_message", text: "hi", from: "u1", fromName: "Andy" }), null);
  assert.equal(injectedFromMessage({ type: "user_message", text: "hi" }), null);
});

test("declared sender shows its name and the declared marker", () => {
  const inj = injectedFromMessage({ senderKind: "declared", fromName: "lore-a3", initiator: "trigger", contextNote: "PR 1967 report" });
  assert.equal(injectedSenderName(inj), "lore-a3");
  assert.equal(injectedLabel(inj), "trigger · PR 1967 report · declared");
});

test("undeclared sender never shows an operator name", () => {
  const inj = injectedFromMessage({ senderKind: "undeclared", initiator: "trigger", contextNote: "n" });
  assert.equal(injectedSenderName(inj), "Undeclared sender");
  assert.equal(injectedLabel(inj), "trigger · n · undeclared");
});

test("legacy entry reads as injected with sender not recorded", () => {
  const inj = injectedFromMessage({ senderKind: "unrecorded", initiator: "trigger", contextNote: "n" });
  assert.equal(injectedSenderName(inj), "injected (sender not recorded)");
  assert.equal(injectedLabel(inj), "trigger · n");
});

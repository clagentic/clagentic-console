"use strict";
// The editors' warning for names the Claude settings file also sets.

var test = require("node:test");
var assert = require("node:assert/strict");

function fakeElement() {
  var classes = new Set(["hidden"]);
  return {
    textContent: "",
    classList: {
      add: function (c) { classes.add(c); },
      remove: function (c) { classes.delete(c); },
      contains: function (c) { return classes.has(c); },
    },
  };
}

test("the notice names the shadowed variables and shows, and hides when there are none", async function () {
  var el = fakeElement();
  globalThis.document = { getElementById: function (id) { return id === "n" ? el : null; } };
  try {
    var { renderShadowNotice } = await import("../lib/public/modules/env-shadow-notice.js");
    renderShadowNotice("n", ["AWS_REGION", "CLAUDE_CODE_USE_BEDROCK"]);
    assert.equal(el.classList.contains("hidden"), false);
    assert.match(el.textContent, /AWS_REGION, CLAUDE_CODE_USE_BEDROCK/);
    assert.match(el.textContent, /Claude settings file/);
    assert.match(el.textContent, /no effect/);
    renderShadowNotice("n", []);
    assert.equal(el.classList.contains("hidden"), true);
    assert.equal(el.textContent, "");
    renderShadowNotice("n", undefined);
    assert.equal(el.classList.contains("hidden"), true);
    renderShadowNotice("missing", ["A"]);
  } finally {
    delete globalThis.document;
  }
});

"use strict";
/**
 * Regression test for lr-62157d (MILLER fnd-3291e4): a >=500-char paste
 * with no typed text was titled the literal "Image", because
 * project-user-message.js:368 only ever consulted msg.text (falling back
 * to "Image") even though the paste text was fully in hand 17 lines below
 * (concatenated into fullText). Chain: the client's paste-chip handling
 * (input.js) diverts any paste >=500 chars into msg.pastes[] with msg.text
 * left empty, so every such message hit the || "Image" fallback meant only
 * for the genuinely image-only case.
 *
 * Fix: deriveProvisionalTitle() (lib/project-user-message.js) sources the
 * title from msg.pastes[0] when msg.text is empty, collapses whitespace
 * before truncating (pastes are commonly multi-line), and reserves "Image"
 * for when neither text nor a paste is present.
 *
 * Drives the real exported helper (_test_deriveProvisionalTitle) — no
 * reimplementation.
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var { _test_deriveProvisionalTitle: deriveProvisionalTitle } = require("../lib/project-user-message");

test("lr-62157d: a >=500-char paste with empty msg.text produces a title derived from the paste, not the literal 'Image'", function () {
  var pasteText = "function longFunction() {\n  return 'this is a long pasted block of text that would previously be lost';\n}\n".repeat(6);
  assert.ok(pasteText.length >= 500, "sanity: paste must actually be >=500 chars, matching the client's diversion threshold");

  var msg = { type: "message", text: "", pastes: [pasteText] };
  var title = deriveProvisionalTitle(msg);

  assert.notEqual(title, "Image", "a paste-only message must not degrade to the literal 'Image'");
  assert.ok(title.length > 0 && title.length <= 50, "title must be truncated to the 50-char provisional-title bound");
});

test("lr-62157d: paste-derived title collapses whitespace before truncating (multi-line paste does not render as a broken sidebar entry)", function () {
  var pasteText = "line one\n\n   line two with   extra   spaces\nline three\nline four\nline five";
  var msg = { type: "message", text: "", pastes: [pasteText] };

  var title = deriveProvisionalTitle(msg);

  assert.ok(!/\n/.test(title), "title must not contain raw newlines from the paste");
  assert.ok(!/ {2,}/.test(title), "title must not contain runs of multiple spaces from the paste");
  assert.equal(title, "line one line two with extra spaces line three lin".substring(0, 50));
});

test("lr-62157d: an image-only message (no text, no pastes) still yields the literal 'Image'", function () {
  var msg = { type: "message", text: "", images: [{ mediaType: "image/png", data: "..." }] };

  var title = deriveProvisionalTitle(msg);

  assert.equal(title, "Image", "the genuinely image-only case must keep the 'Image' fallback");
});

test("lr-62157d: real typed text is still preferred over any paste when both are present", function () {
  var msg = { type: "message", text: "my actual typed question", pastes: ["some pasted context that should not be used for the title"] };

  var title = deriveProvisionalTitle(msg);

  assert.equal(title, "my actual typed question");
});

test("lr-62157d: an empty-string paste array entry does not crash and still falls back sanely", function () {
  var msg = { type: "message", text: "", pastes: [""] };

  assert.doesNotThrow(function () {
    var title = deriveProvisionalTitle(msg);
    // An empty first paste has no text to derive a title from — falling
    // back to "Image" here is acceptable (there is nothing else to show),
    // the important behavior this test pins is "does not throw".
    assert.equal(typeof title, "string");
  });
});

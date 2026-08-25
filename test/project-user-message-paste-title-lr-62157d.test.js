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

// PEACHES fnd-439007 (PR #406 review, head_sha f59ef92e): msg is raw
// client-controlled WS JSON with no server-side schema validation
// (project-connection.js's bare JSON.parse) — the bundled browser client
// only ever sends strings in pastes[] (input.js pushes p.text, always a
// string), but nothing enforces that for an arbitrary WS client. pastes[0]
// was never previously consulted for title derivation before this task, so
// a non-string entry there is a genuinely new reachable path, not a
// hypothetical — the irony being that the operator's ORIGINAL report was a
// paste getting mis-titled "Image"; a naive fix must not trade that bug for
// a crash on a malformed/adversarial payload.
test("lr-62157d / fnd-439007: a non-string pastes[0] (e.g. an image-paste-shaped object) does not throw and falls back to 'Image'", function () {
  var msg = { type: "message", text: "", pastes: [{ type: "image", mediaType: "image/png", data: "..." }] };

  assert.doesNotThrow(function () {
    var title = deriveProvisionalTitle(msg);
    assert.equal(title, "Image", "a non-string paste entry must fall through to the 'Image' literal, not throw");
  }, "a non-string pastes[0] must not throw a TypeError out of .replace()");
});

// BOBBIE (PR #406 review, comment 5403852401): plain substring(0, 50)
// indexes by UTF-16 code unit, so a cut landing inside a surrogate pair
// (most emoji, many CJK supplementary-plane characters) produces a lone
// unpaired surrogate -- renders as a broken/replacement glyph in the
// sidebar. Newly reachable in a way it wasn't before this task: pasted
// content is now a title source, and pasted text is far more likely to
// contain emoji/CJK than a typed first line. Cosmetic (not a crash/security
// issue), but a real, newly-introduced regression path worth pinning.
test("lr-62157d / BOBBIE: a paste whose 50th-character boundary falls inside a surrogate pair does not split it (no broken glyph)", function () {
  // 49 plain ASCII chars, then an emoji (astral code point, 2 UTF-16 code
  // units) starting exactly at code-unit index 49 -- substring(0, 50) would
  // land squarely inside that surrogate pair.
  var prefix = "a".repeat(49);
  var emoji = "\u{1F600}"; // grinning face, U+1F600 -- surrogate pair in UTF-16
  var pasteText = prefix + emoji + " trailing content that pushes this paste well past the 500-char client diversion threshold, repeated for length. ".repeat(4);
  assert.ok(pasteText.length >= 500, "sanity: paste must actually be >=500 chars, matching the client's diversion threshold");

  var msg = { type: "message", text: "", pastes: [pasteText] };
  var title = deriveProvisionalTitle(msg);

  // A broken surrogate pair produces the Unicode replacement/"unknown"
  // rendering; the concrete, checkable symptom is a lone unpaired surrogate
  // code unit somewhere in the raw UTF-16 string. Array.from() on the title
  // splits it back into code points (a length-1 array element for a proper
  // astral code point, since Array.from correctly reassembles a surrogate
  // pair into one iteration step) -- but each element is still a JS string
  // of 1 OR 2 UTF-16 code units, so codePointAt(0) (not charCodeAt(0), which
  // always reports only the first UTF-16 code unit even for a 2-unit
  // element) is what correctly reports "is this a single combined astral
  // code point" vs. "is this a lone surrogate masquerading as its own
  // element" -- the latter only happens if Array.from itself received an
  // already-broken (lone-surrogate) string, which is exactly the bug this
  // test exists to catch.
  var codePoints = Array.from(title);
  codePoints.forEach(function (cp) {
    var code = cp.codePointAt(0);
    var isLoneSurrogate = code >= 0xD800 && code <= 0xDFFF;
    assert.ok(!isLoneSurrogate, "title must not contain a lone (unpaired) surrogate code unit: " + JSON.stringify(title));
  });
  // The emoji itself, if present in the truncated title at all, must survive
  // intact as a single code point (not split into two lone surrogates).
  if (title.indexOf("\uD83D") !== -1 || title.indexOf("\uDE00") !== -1) {
    assert.ok(title.indexOf(emoji) !== -1, "if either half of the emoji surrogate pair appears, the whole emoji must be present intact: " + JSON.stringify(title));
  }
});

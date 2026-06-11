// Regression tests for stored XSS fixes (lr-7b07):
//
//   5a. sticky-note auto-link regex must exclude " and ' from URL match so that
//       a crafted URL like http://x.com"onmouseover="alert(1) cannot break out
//       of the href attribute.
//
//   5b. escapeHtml must encode " (&quot;) and ' (&#39;) in addition to & < >.
//       Without quote encoding, an attacker-controlled value in an HTML attribute
//       context (e.g. alt="...escapeHtml(msg.path)...") can inject event handlers.
//
//   5c. escapeHtml must not throw on null, undefined, or non-string input; it must
//       coerce to an empty string instead so that callers building innerHTML never
//       crash mid-render.
//
// These tests import the real production modules, not test doubles.

import { test } from "node:test";
import assert from "node:assert/strict";

// escape-html.js has no DOM deps — importable directly from Node.
import { escapeHtml } from "../lib/public/modules/escape-html.js";

// sticky-notes-fmt.js mirrors the DOM-free fmt() logic from sticky-notes.js.
import { fmt, AUTO_LINK_RE } from "../lib/public/modules/sticky-notes-fmt.js";

// ============================================================
// 5b + 5c — escapeHtml
// ============================================================

test("escapeHtml encodes & < > as before", () => {
  assert.equal(escapeHtml("a & b"), "a &amp; b");
  assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
  assert.equal(escapeHtml("a > b"), "a &gt; b");
});

test("escapeHtml encodes double-quote to prevent attribute breakout (5b)", () => {
  // Without this fix: alt="...a" onerror="alert(1)..." would inject an event handler.
  assert.equal(escapeHtml('"'), "&quot;");
  assert.equal(escapeHtml('path/to/"file"'), "path/to/&quot;file&quot;");
  assert.equal(
    escapeHtml('a" onerror="alert(1)'),
    "a&quot; onerror=&quot;alert(1)"
  );
});

test("escapeHtml encodes single-quote to prevent attribute breakout (5b)", () => {
  assert.equal(escapeHtml("'"), "&#39;");
  assert.equal(escapeHtml("it's"), "it&#39;s");
  assert.equal(
    escapeHtml("a' onmouseover='alert(1)"),
    "a&#39; onmouseover=&#39;alert(1)"
  );
});

test("escapeHtml returns empty string for null (5c)", () => {
  assert.equal(escapeHtml(null), "");
});

test("escapeHtml returns empty string for undefined (5c)", () => {
  assert.equal(escapeHtml(undefined), "");
});

test("escapeHtml coerces number to string instead of throwing (5c)", () => {
  assert.equal(escapeHtml(42), "42");
  assert.equal(escapeHtml(0), "0");
});

test("escapeHtml coerces boolean to string instead of throwing (5c)", () => {
  assert.equal(escapeHtml(true), "true");
  assert.equal(escapeHtml(false), "false");
});

test("escapeHtml returns empty string for empty input", () => {
  assert.equal(escapeHtml(""), "");
});

// ============================================================
// 5a — sticky-note auto-link regex (href attribute breakout)
// ============================================================

test("AUTO_LINK_RE does not match double-quote in URL (5a)", () => {
  // The attack payload: a URL containing a double-quote used to close the href
  // and inject an event handler attribute.
  var payload = 'http://x.com"onmouseover="alert(1)';
  AUTO_LINK_RE.lastIndex = 0;
  var match = AUTO_LINK_RE.exec(payload);
  // The match must stop at the double-quote, not include it.
  assert.ok(match !== null, "regex should still match the safe prefix");
  assert.equal(match[0], "http://x.com", "match stops before the double-quote");
});

test("AUTO_LINK_RE does not match single-quote in URL (5a)", () => {
  var payload = "http://x.com'onmouseover='alert(1)";
  AUTO_LINK_RE.lastIndex = 0;
  var match = AUTO_LINK_RE.exec(payload);
  assert.ok(match !== null, "regex should still match the safe prefix");
  assert.equal(match[0], "http://x.com", "match stops before the single-quote");
});

test("AUTO_LINK_RE matches a normal URL (5a — not a regression)", () => {
  var url = "https://example.com/path?q=1&r=2#anchor";
  AUTO_LINK_RE.lastIndex = 0;
  var match = AUTO_LINK_RE.exec(url);
  assert.ok(match !== null, "normal URL should match");
  assert.equal(match[0], url, "entire normal URL is matched");
});

// ============================================================
// 5a — fmt() end-to-end: attack payload does not produce href breakout
// ============================================================

test("fmt: attack URL with double-quote does not inject event handler (5a)", () => {
  // The stored XSS payload: note text containing a URL with embedded double-quote.
  // Before the fix: produced <a href="http://x.com"onmouseover="alert(1)"...>
  // After the fix:  the URL match stops at the double-quote; the rest is
  //                 rendered as escaped text, not an attribute.
  var note = 'http://x.com"onmouseover="alert(1)';
  var out = fmt(note);

  // Must contain an anchor for the safe prefix only.
  assert.ok(out.includes('<a href="http://x.com"'), "safe prefix is linked");

  // Must not produce a bare onmouseover= attribute on the anchor.
  // The injected string must appear HTML-escaped, not raw.
  assert.ok(!out.includes('" onmouseover='), "no injected attribute (space variant)");
  assert.ok(!out.includes('"onmouseover='), "no injected attribute (no-space variant)");
});

test("fmt: attack URL with single-quote does not inject event handler (5a)", () => {
  var note = "http://x.com'onmouseover='alert(1)";
  var out = fmt(note);

  assert.ok(out.includes('<a href="http://x.com"'), "safe prefix is linked");
  assert.ok(!out.includes("' onmouseover="), "no injected attribute (space variant)");
  assert.ok(!out.includes("'onmouseover="), "no injected attribute (no-space variant)");
});

test("fmt: normal URL is auto-linked without modification (5a — not a regression)", () => {
  var url = "https://example.com/path";
  var out = fmt(url);
  assert.ok(
    out.includes('<a href="https://example.com/path" target="_blank" rel="noopener">'),
    "normal URL is wrapped in anchor with correct attributes"
  );
});

test("fmt: plain text with no URL is returned HTML-escaped (no anchors)", () => {
  var out = fmt("hello <world> & friends");
  assert.equal(out, "hello &lt;world&gt; &amp; friends");
  assert.ok(!out.includes("<a"), "no anchor for plain text");
});

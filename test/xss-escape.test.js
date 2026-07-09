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

// ============================================================
// lr-a68f — isCustomIcon classification and XSS regression
// ============================================================

import { isCustomIcon, customIconSlug } from "../lib/public/modules/project-icon.js";

test("isCustomIcon: recognises valid :slug: sentinel", () => {
  assert.ok(isCustomIcon(":my_icon:"), ":my_icon: is a custom icon");
  assert.ok(isCustomIcon(":icon-1:"), ":icon-1: is a custom icon");
  assert.ok(isCustomIcon(":a:"), ":a: is a custom icon");
});

test("isCustomIcon: rejects non-sentinel values", () => {
  assert.ok(!isCustomIcon("😀"), "emoji is not a custom icon");
  assert.ok(!isCustomIcon("📁"), "emoji folder is not a custom icon");
  assert.ok(!isCustomIcon(""), "empty string is not a custom icon");
  assert.ok(!isCustomIcon(null), "null is not a custom icon");
  assert.ok(!isCustomIcon(undefined), "undefined is not a custom icon");
  assert.ok(!isCustomIcon(":"), "bare colon is not a custom icon");
  assert.ok(!isCustomIcon("::"), "empty slug is not a custom icon");
});

test("isCustomIcon: rejects strings containing script tags", () => {
  assert.ok(!isCustomIcon('<script>alert(1)</script>'), "script tag is not a custom icon");
  assert.ok(!isCustomIcon(':foo<script>:'), "slug with html is not a custom icon");
  assert.ok(!isCustomIcon(':<img onerror=alert(1)>:'), "slug with img tag is not a custom icon");
});

test("customIconSlug: strips leading and trailing colons", () => {
  assert.equal(customIconSlug(":my_icon:"), "my_icon");
  assert.equal(customIconSlug(":icon-1:"), "icon-1");
});

test("customIconSlug: returns null for non-custom-icon values", () => {
  assert.equal(customIconSlug("😀"), null);
  assert.equal(customIconSlug(""), null);
  assert.equal(customIconSlug(null), null);
});

// XSS regression: app-home-hub.js must not interpolate raw proj.icon into innerHTML.
// We verify structurally by reading the source and asserting the old dangerous pattern
// is absent. The real fix is in the DOM API path that calls renderProjectIcon.
test("app-home-hub.js: does not interpolate raw proj.icon into innerHTML (lr-a68f XSS fix)", async () => {
  var fs = (await import("node:fs")).default;
  var path = (await import("node:path")).default;
  var src = fs.readFileSync(
    path.resolve("lib/public/modules/app-home-hub.js"),
    "utf8"
  );
  // The old pattern: string-concatenating proj.icon directly into an innerHTML
  // assignment. Any of these substrings would indicate the vulnerability is back.
  var dangerous = [
    "proj.icon +",
    "+ proj.icon",
    "proj.icon}",
    "${proj.icon}",
  ];
  for (var i = 0; i < dangerous.length; i++) {
    assert.ok(
      !src.includes(dangerous[i]),
      "app-home-hub.js must not contain '" + dangerous[i] + "' (raw icon interpolation)"
    );
  }
});

// ============================================================
// lr-a6da — projectIconHtml() (string-composition render sites)
// ============================================================

import { projectIconHtml } from "../lib/public/modules/project-icon.js";

test("projectIconHtml: custom icon renders as safe <img> markup, not literal ':slug:' text", () => {
  var html = projectIconHtml(":my_icon:");
  assert.ok(html.includes('src="/api/custom-emoji/my_icon"'), "img src points at the custom-emoji endpoint");
  assert.ok(html.includes('class="project-emoji-img"'), "carries the shared project-emoji-img class");
  // The whole thing must be a single self-contained <img> tag: ':my_icon:' is
  // only present inside the alt="" attribute (mirrors renderProjectIcon()'s
  // img.alt), never as visible text content outside the tag.
  assert.ok(/^<img\b[^>]*>$/.test(html), "output is a single self-contained <img> tag, no trailing literal text");
  assert.ok(html.includes('alt=":my_icon:"'), "slug appears only inside the alt attribute, as accessible text");
});

test("projectIconHtml: custom icon markup includes an onerror fallback (delete-in-use parity)", () => {
  var html = projectIconHtml(":deleted_icon:");
  assert.ok(html.includes("onerror="), "string-built <img> carries a fallback for a 404'd (deleted-in-use) custom icon");
});

test("projectIconHtml: unicode emoji still renders as escaped text, unchanged", () => {
  assert.equal(projectIconHtml("🚀"), "🚀");
  assert.equal(projectIconHtml("📁"), "📁");
});

test("projectIconHtml: null/empty icon falls back to caller-supplied placeholder markup", () => {
  var fallback = '<i data-lucide="box"></i>';
  assert.equal(projectIconHtml(null, fallback), fallback);
  assert.equal(projectIconHtml("", fallback), fallback);
  assert.equal(projectIconHtml(undefined), "");
});

// ============================================================
// lr-cc85 — scheduler.js stored XSS: month/week/popover sinks
//
// scheduler.js is DOM-coupled (initScheduler() reaches for
// document.getElementById at module init), so it can't be imported and
// exercised directly in Node the way escape-html.js can. Following the
// existing app-home-hub.js / command-palette.js pattern above, these tests
// read the source and assert the vulnerable raw-interpolation sinks are gone
// and the escaping/validation call sites are present.
// ============================================================

test("scheduler.js: month view escapes ev.timeStr instead of interpolating it raw (lr-cc85 vector 1)", async () => {
  var fs = (await import("node:fs")).default;
  var path = (await import("node:path")).default;
  var src = fs.readFileSync(path.resolve("lib/public/modules/scheduler.js"), "utf8");

  // The historical vulnerable pattern: raw ev.timeStr concatenated into the
  // month-cell markup without esc().
  assert.ok(
    !src.includes("'<span class=\"scheduler-event-time\">' + ev.timeStr + '</span>"),
    "month view must not interpolate raw ev.timeStr"
  );
  assert.ok(
    src.includes("'<span class=\"scheduler-event-time\">' + esc(ev.timeStr) + '</span>"),
    "month view must escape ev.timeStr via esc()"
  );
});

test("scheduler.js: week view (non-badge) escapes ev.timeStr at the second sink (lr-cc85 vector 1, harden :1099)", async () => {
  var fs = (await import("node:fs")).default;
  var path = (await import("node:path")).default;
  var src = fs.readFileSync(path.resolve("lib/public/modules/scheduler.js"), "utf8");

  assert.ok(
    !src.includes("'<span class=\"scheduler-week-event-time\">' + ev.timeStr + '</span>'"),
    "week view time span must not interpolate raw ev.timeStr"
  );
  // Both week-view time spans (interval-badge and regular event) must escape.
  var matches = src.match(/'<span class="scheduler-week-event-time">' \+ esc\(ev\.timeStr\) \+ '<\/span>'/g) || [];
  assert.equal(matches.length, 2, "both week-view time-span sinks call esc(ev.timeStr)");
});

test("scheduler.js: popover escapes cronToHuman(rec.cron) (lr-cc85 vector 1, popover :1320)", async () => {
  var fs = (await import("node:fs")).default;
  var path = (await import("node:path")).default;
  var src = fs.readFileSync(path.resolve("lib/public/modules/scheduler.js"), "utf8");

  assert.ok(
    !src.includes("'<div class=\"schedule-popover-meta\">' + cronToHuman(rec.cron) + '</div>'"),
    "popover must not interpolate raw cronToHuman(rec.cron)"
  );
  assert.ok(
    src.includes("'<div class=\"schedule-popover-meta\">' + esc(cronToHuman(rec.cron)) + '</div>'"),
    "popover must escape cronToHuman(rec.cron) via esc()"
  );
});

test("scheduler.js: esc() applied end-to-end renders a malicious cron fallback and time string inert", () => {
  // Mirrors scheduler.js's esc()/cronToHuman() logic exactly (cronToHuman's
  // fallback at :1673 returns the raw cron string verbatim when it can't
  // parse a 5-field cron — that raw string is the attack surface).
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function cronToHuman(cron) {
    if (!cron) return "";
    var parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return cron; // fallback: raw cron verbatim
    return "n/a";
  }

  var maliciousTime = '<img src=x onerror=alert(1)>';
  var maliciousCron = '<script>alert(1)</script>'; // not 5 fields -> fallback returns raw

  assert.equal(esc(maliciousTime), "&lt;img src=x onerror=alert(1)&gt;");
  assert.ok(!esc(maliciousTime).includes("<img"), "escaped time string carries no live tag");

  var human = cronToHuman(maliciousCron);
  assert.equal(human, maliciousCron, "fallback returns the raw cron (the vulnerability surface)");
  assert.equal(esc(human), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.ok(!esc(human).includes("<script>"), "escaped cron fallback carries no live script tag");
});

// ============================================================
// lr-cc85 — scheduler.js / sidebar-sessions.js stored XSS: color-into-style
// attribute sinks (vector 2)
// ============================================================

test("scheduler.js: interval-badge and week-view background use safeColor() instead of raw ev.color (lr-cc85 vector 2)", async () => {
  var fs = (await import("node:fs")).default;
  var path = (await import("node:path")).default;
  var src = fs.readFileSync(path.resolve("lib/public/modules/scheduler.js"), "utf8");

  assert.ok(
    !src.includes('badgeStyle = "background:" + ev.color'),
    "interval badge must not interpolate raw ev.color into style"
  );
  assert.ok(
    !src.includes('var evColor = ev.color || ""'),
    "week-view background must not interpolate raw ev.color into style"
  );
  assert.ok(src.includes("safeColor(ev.color)"), "color sinks route through safeColor()");
  assert.ok(
    src.includes("SAFE_HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i"),
    "a strict hex-color allowlist regex guards the color sinks"
  );
});

test("scheduler.js: safeColor() rejects an attribute-breakout payload and accepts a valid hex color", () => {
  // Mirrors scheduler.js's safeColor() exactly.
  var SAFE_HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;
  function safeColor(c) { return c && SAFE_HEX_COLOR_RE.test(c) ? c : null; }

  var payload = 'x" onanimationstart=alert(1) x="';
  assert.equal(safeColor(payload), null, "attribute-breakout color payload is rejected");
  assert.equal(safeColor("#fff"), "#fff");
  assert.equal(safeColor("#ff00aa"), "#ff00aa");
  assert.equal(safeColor(null), null);
  assert.equal(safeColor(""), null);
});

test("sidebar-sessions.js: countdown item validates u.color against a strict hex regex before building the style attribute (lr-cc85 vector 2)", async () => {
  var fs = (await import("node:fs")).default;
  var path = (await import("node:path")).default;
  var src = fs.readFileSync(path.resolve("lib/public/modules/sidebar-sessions.js"), "utf8");

  assert.ok(
    !src.includes('var colorStyle = u.color ? " style=\\"border-left-color:" + u.color + "\\"" : "";'),
    "countdown must not interpolate raw u.color into style"
  );
  assert.ok(
    src.includes("safeCountdownColor"),
    "countdown routes u.color through a validated variable before use"
  );
  assert.ok(
    src.includes("/^#[0-9a-f]{3,8}$/i.test(u.color)"),
    "countdown validates u.color with a strict hex-color regex"
  );
});

test("sidebar-sessions.js: countdown color validation rejects an attribute-breakout payload, accepts hex", () => {
  // Mirrors sidebar-sessions.js's inline validation exactly.
  function safeCountdownColor(color) {
    return color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : null;
  }

  var payload = 'x" onanimationstart=alert(1) x="';
  assert.equal(safeCountdownColor(payload), null, "attribute-breakout color payload is rejected");
  assert.equal(safeCountdownColor("#123456"), "#123456");
  assert.equal(safeCountdownColor(null), null);
});

test("projectIconHtml: does not raw-interpolate a script-bearing non-sentinel icon value", () => {
  // Not a valid :slug: sentinel (isCustomIcon rejects it), so it falls through
  // to the escaped-text branch — must not appear unescaped in the output.
  var html = projectIconHtml('<script>alert(1)</script>');
  assert.ok(!html.includes("<script>"), "script tag must be HTML-escaped, not passed through raw");
  assert.ok(html.includes("&lt;script&gt;"), "escaped form is present instead");
});

// ============================================================
// lr-a6da — no-raw-interpolation regressions at the newly-wired render sites
// ============================================================

test("command-palette.js: recent sessions / search results / project list route icons through projectIconHtml, not raw interpolation", async () => {
  var fs = (await import("node:fs")).default;
  var path = (await import("node:path")).default;
  var src = fs.readFileSync(path.resolve("lib/public/modules/command-palette.js"), "utf8");

  assert.ok(src.includes("projectIconHtml"), "command-palette.js imports/uses projectIconHtml");

  var dangerous = [
    "s.projectIcon ||",
    "r.projectIcon ||",
    "proj.icon ||",
  ];
  for (var i = 0; i < dangerous.length; i++) {
    assert.ok(
      !src.includes(dangerous[i]),
      "command-palette.js must not contain '" + dangerous[i] + "' (raw icon interpolation bypassing projectIconHtml)"
    );
  }
});

test("app-notifications.js: banner icon routes through projectIconHtml, not raw interpolation", async () => {
  var fs = (await import("node:fs")).default;
  var path = (await import("node:path")).default;
  var src = fs.readFileSync(path.resolve("lib/public/modules/app-notifications.js"), "utf8");

  assert.ok(src.includes("projectIconHtml"), "app-notifications.js imports/uses projectIconHtml");
  assert.ok(
    !src.includes("'<span class=\"notif-banner-emoji\">' + projectIcon +"),
    "app-notifications.js must not raw-interpolate projectIcon into the banner markup"
  );
});

test("app-projects.js: removed-projects list routes icons through renderProjectIcon, not raw textContent", async () => {
  var fs = (await import("node:fs")).default;
  var path = (await import("node:path")).default;
  var src = fs.readFileSync(path.resolve("lib/public/modules/app-projects.js"), "utf8");

  assert.ok(
    !src.includes('iconEl.textContent = rp.icon'),
    "app-projects.js must not assign rp.icon directly to textContent (shows ':slug:' literally)"
  );
  assert.ok(
    src.includes("renderProjectIcon(rp.icon"),
    "app-projects.js routes the removed-projects icon through renderProjectIcon"
  );
});

test("sidebar-projects.js: folder render sites (header + move-to-folder menu) route custom icons through the shared helper", async () => {
  var fs = (await import("node:fs")).default;
  var path = (await import("node:path")).default;
  var src = fs.readFileSync(path.resolve("lib/public/modules/sidebar-projects.js"), "utf8");

  assert.ok(
    !src.includes("emojiSpan.textContent = fmeta.icon"),
    "sidebar-projects.js desktop folder header must not assign fmeta.icon directly to textContent"
  );
  assert.ok(
    src.includes("renderProjectIcon(fmeta.icon"),
    "sidebar-projects.js desktop folder header routes fmeta.icon through renderProjectIcon"
  );

  assert.ok(
    !src.includes("'<span style=\"margin-right:4px\">' + fmeta2.icon +"),
    "sidebar-projects.js move-to-folder menu must not raw-interpolate fmeta2.icon"
  );
  assert.ok(
    src.includes("projectIconHtml(fmeta2.icon)"),
    "sidebar-projects.js move-to-folder menu routes fmeta2.icon through projectIconHtml"
  );
});

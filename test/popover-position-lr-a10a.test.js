// Regression tests for lr-a10a: shared viewport-clamp positioning util.
//
// Background: many popup call sites positioned themselves via
// getBoundingClientRect() + inline style.top/left with only a partial
// clamp (often right/bottom edges only, sometimes none). On mobile, a
// low or edge-anchored trigger (e.g. the icon-strip, a synthetic
// contextmenu from a bottom action-sheet) could still leave the popup
// with its top or left edge off-screen. lr-149e fixed this one-off for
// the emoji picker; this task generalizes that fix into
// lib/public/modules/popover-position.js and applies it everywhere else.
//
// These tests exercise the pure (DOM-free) math directly: clampRect,
// computePopoverPosition, and computePointPosition. The DOM wrappers
// (positionPopover, positionAtPoint) are thin — they measure via
// getBoundingClientRect() and window.innerWidth/innerHeight, then defer
// to these same functions, so covering the math here covers the actual
// positioning behavior used by every call site.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MOBILE_BREAKPOINT,
  clampRect,
  computePopoverPosition,
  computePointPosition,
} from "../lib/public/modules/popover-position.js";

var DESKTOP_VIEWPORT = { innerWidth: 1280, innerHeight: 800 };
var MOBILE_VIEWPORT = { innerWidth: 375, innerHeight: 640 };

// ============================================================
// clampRect — four-edge clamp
// ============================================================

test("clampRect leaves an in-bounds rect untouched", () => {
  var pos = clampRect({ top: 100, left: 100, width: 200, height: 150 }, DESKTOP_VIEWPORT);
  assert.equal(pos.top, 100);
  assert.equal(pos.left, 100);
});

test("clampRect clamps the right edge when it overflows", () => {
  var pos = clampRect({ top: 100, left: 1200, width: 200, height: 150 }, DESKTOP_VIEWPORT, { margin: 8 });
  // left + width + margin must not exceed innerWidth
  assert.ok(pos.left + 200 + 8 <= DESKTOP_VIEWPORT.innerWidth + 1);
  assert.equal(pos.left, DESKTOP_VIEWPORT.innerWidth - 200 - 8);
});

test("clampRect clamps the bottom edge when it overflows", () => {
  var pos = clampRect({ top: 750, left: 100, width: 200, height: 150 }, DESKTOP_VIEWPORT, { margin: 8 });
  assert.equal(pos.top, DESKTOP_VIEWPORT.innerHeight - 150 - 8);
});

test("clampRect clamps the left edge when it is negative", () => {
  var pos = clampRect({ top: 100, left: -50, width: 200, height: 150 }, DESKTOP_VIEWPORT, { margin: 8 });
  assert.equal(pos.left, 8);
});

test("clampRect clamps the top edge when it is negative", () => {
  var pos = clampRect({ top: -30, left: 100, width: 200, height: 150 }, DESKTOP_VIEWPORT, { margin: 8 });
  assert.equal(pos.top, 8);
});

test("clampRect never leaves top<0 or top+height>innerHeight even when the popover is larger than the viewport", () => {
  // Oversized popover: clamping alone can't make it fit, but it must never
  // report a top that would put more of the popover off-screen than
  // necessary (i.e. it should still be pinned to the margin, not blow past it).
  var pos = clampRect({ top: 300, left: 300, width: 900, height: 900 }, MOBILE_VIEWPORT, { margin: 8 });
  assert.equal(pos.top, 8);
  assert.equal(pos.left, 8);
});

// ============================================================
// computePopoverPosition — desktop anchor-relative behavior preserved
// ============================================================

test("desktop 'right' placement anchors to the right of the anchor by default", () => {
  var anchor = { top: 100, left: 200, right: 240, bottom: 140 };
  var pos = computePopoverPosition({ width: 180, height: 120 }, anchor, DESKTOP_VIEWPORT, { placement: "right", mobile: false });
  assert.equal(pos.left, 240 + 6); // anchor.right + default gap
  assert.equal(pos.top, 100); // anchor.top
});

test("desktop 'right' placement flips to the left when it would overflow the right edge", () => {
  var anchor = { top: 100, left: 1100, right: 1150, bottom: 140 };
  var pos = computePopoverPosition({ width: 200, height: 120 }, anchor, DESKTOP_VIEWPORT, { placement: "right", mobile: false });
  // Flipped: left of the anchor.
  assert.equal(pos.left, 1100 - 200 - 6);
});

test("desktop 'below' placement anchors below-left by default", () => {
  var anchor = { top: 100, left: 50, right: 90, bottom: 130 };
  var pos = computePopoverPosition({ width: 150, height: 100 }, anchor, DESKTOP_VIEWPORT, { placement: "below", mobile: false });
  assert.equal(pos.left, 50);
  assert.equal(pos.top, 130 + 6);
});

test("desktop 'below' placement flips above the anchor when it would overflow the bottom edge", () => {
  var anchor = { top: 700, left: 50, right: 90, bottom: 730 };
  var pos = computePopoverPosition({ width: 150, height: 200 }, anchor, DESKTOP_VIEWPORT, { placement: "below", mobile: false });
  // Flipped: above the anchor.
  assert.equal(pos.top, 700 - 200 - 6);
});

test("'below-right-aligned' placement aligns the popover's right edge to the anchor's right edge", () => {
  var anchor = { top: 40, left: 900, right: 950, bottom: 70 };
  var pos = computePopoverPosition({ width: 180, height: 120 }, anchor, DESKTOP_VIEWPORT, { placement: "below-right-aligned", mobile: false });
  assert.equal(pos.left, 950 - 180);
  assert.equal(pos.top, 70 + 6);
});

// ============================================================
// Explicit `gap` option — regression coverage for per-call-site gaps
// dropped during the lr-a10a consolidation (amos.code-craft.1). Several
// call sites had a non-default gap (8px, 4px, 2px) before routing through
// this shared util; those values must be passed explicitly since the
// util's own default (6px) is unrelated to any one call site's original
// spacing.
// ============================================================

test("explicit gap overrides the default for 'right' placement (e.g. project-access-popover: 8px)", () => {
  var anchor = { top: 100, left: 200, right: 240, bottom: 140 };
  var pos = computePopoverPosition({ width: 180, height: 120 }, anchor, DESKTOP_VIEWPORT, { placement: "right", gap: 8, mobile: false });
  assert.equal(pos.left, 240 + 8);
});

test("explicit gap overrides the default for 'below' placement (e.g. project-ctx-menu/move-folder-menu below variant: 4px)", () => {
  var anchor = { top: 100, left: 50, right: 90, bottom: 130 };
  var pos = computePopoverPosition({ width: 150, height: 100 }, anchor, DESKTOP_VIEWPORT, { placement: "below", gap: 4, mobile: false });
  assert.equal(pos.top, 130 + 4);
});

test("explicit gap overrides the default for 'below-right-aligned' placement (e.g. session/loop ctx menu: 2px)", () => {
  var anchor = { top: 40, left: 900, right: 950, bottom: 70 };
  var pos = computePopoverPosition({ width: 180, height: 120 }, anchor, DESKTOP_VIEWPORT, { placement: "below-right-aligned", gap: 2, mobile: false });
  assert.equal(pos.top, 70 + 2);
});

// ============================================================
// Low-anchor flip-then-clamp — the core lr-a10a / lr-149e regression
// ============================================================

test("'below' placement: flipping above a low anchor never leaves top<0 (flip-then-clamp)", () => {
  // Anchor sits very close to the top of the viewport (e.g. a mobile
  // header button) with a popover tall enough that flipping above it
  // alone would produce a negative top.
  var anchor = { top: 10, left: 20, right: 60, bottom: 40 };
  var pos = computePopoverPosition({ width: 150, height: 300 }, anchor, DESKTOP_VIEWPORT, { placement: "below", mobile: false });
  // Flip would give top = 10 - 300 - 6 = -296; clamp must correct this.
  assert.ok(pos.top >= 8, "top must never be negative after flip-then-clamp: got " + pos.top);
  assert.ok(pos.top + 300 <= DESKTOP_VIEWPORT.innerHeight - 8 + 1);
});

test("'right' placement: flipping left of a right-edge anchor never leaves left<0", () => {
  var anchor = { top: 100, left: 10, right: 50, bottom: 140 };
  var pos = computePopoverPosition({ width: 300, height: 100 }, anchor, DESKTOP_VIEWPORT, { placement: "right", mobile: false });
  // Natural placement (anchor.right + gap = 56) fits, so this covers the
  // opposite regression: an anchor near the *left* edge whose flip
  // target would be negative should still clamp to a safe left.
  var anchorNearLeft = { top: 100, left: 2, right: 10, bottom: 140 };
  var pos2 = computePopoverPosition({ width: 300, height: 100 }, anchorNearLeft, DESKTOP_VIEWPORT, { placement: "right", mobile: false });
  assert.ok(pos2.left >= 8, "left must never be negative: got " + pos2.left);
});

test("'below-right-aligned': flipping above a low, right-edge anchor clamps both axes", () => {
  // Mirrors sidebar-sessions.js session/loop ctx menu: anchored to a
  // small icon button near the top-right of a narrow viewport.
  var anchor = { top: 5, left: 340, right: 370, bottom: 30 };
  var pos = computePopoverPosition({ width: 200, height: 250 }, anchor, MOBILE_VIEWPORT, { placement: "below-right-aligned", mobile: false });
  assert.ok(pos.top >= 8, "top must never be negative: got " + pos.top);
  assert.ok(pos.left >= 8, "left must never be negative: got " + pos.left);
  assert.ok(pos.left + 200 <= MOBILE_VIEWPORT.innerWidth - 8 + 1, "must not overflow right edge");
});

// ============================================================
// Mobile (<=768px) branch
// ============================================================

test("MOBILE_BREAKPOINT is 768 (matches the @media max-width used across the CSS)", () => {
  assert.equal(MOBILE_BREAKPOINT, 768);
});

test("mobile branch centers the popover in the viewport regardless of anchor position", () => {
  // A low/edge anchor (e.g. the icon-strip's fixed right-edge trigger, or
  // a mobile action-sheet's synthetic contextmenu) must not pull the
  // popover off-screen — mobile centers instead of anchoring.
  var anchor = { top: 620, left: 360, right: 375, bottom: 640 }; // hard bottom-right corner
  var pos = computePopoverPosition({ width: 292, height: 260 }, anchor, MOBILE_VIEWPORT, { placement: "right", mobile: true });
  var expectedLeft = (MOBILE_VIEWPORT.innerWidth - 292) / 2;
  var expectedTop = (MOBILE_VIEWPORT.innerHeight - 260) / 2;
  assert.equal(pos.left, Math.max(8, expectedLeft));
  assert.equal(pos.top, Math.max(8, expectedTop));
});

test("mobile branch is selected automatically at exactly the 768px breakpoint", () => {
  var viewport = { innerWidth: 768, innerHeight: 1024 };
  var anchor = { top: 0, left: 0, right: 40, bottom: 40 };
  var pos = computePopoverPosition({ width: 300, height: 200 }, anchor, viewport, { placement: "right" }); // mobile inferred from viewport.innerWidth
  var expectedLeft = (768 - 300) / 2;
  assert.equal(pos.left, expectedLeft);
});

test("desktop branch is selected just above the 768px breakpoint", () => {
  var viewport = { innerWidth: 769, innerHeight: 1024 };
  var anchor = { top: 100, left: 100, right: 140, bottom: 130 };
  var pos = computePopoverPosition({ width: 150, height: 100 }, anchor, viewport, { placement: "right" });
  // Anchor-relative (not centered) confirms the desktop branch ran.
  assert.equal(pos.left, 140 + 6);
});

test("mobile centered popover is still clamped to the viewport when it is nearly full-width", () => {
  var anchor = { top: 0, left: 0, right: 40, bottom: 40 };
  var pos = computePopoverPosition({ width: 360, height: 620 }, anchor, MOBILE_VIEWPORT, { placement: "right", mobile: true });
  assert.ok(pos.left >= 8);
  assert.ok(pos.top >= 8);
  assert.ok(pos.left + 360 <= MOBILE_VIEWPORT.innerWidth - 8 + 1);
  assert.ok(pos.top + 620 <= MOBILE_VIEWPORT.innerHeight - 8 + 1);
});

// ============================================================
// computePointPosition — arbitrary-point popovers (e.g. terminal.js ctx menu)
// ============================================================

test("computePointPosition places the popover at the point when it fits", () => {
  var pos = computePointPosition({ width: 160, height: 120 }, { x: 300, y: 200 }, DESKTOP_VIEWPORT, { margin: 4 });
  assert.equal(pos.left, 300);
  assert.equal(pos.top, 200);
});

test("computePointPosition clamps all four edges for a point near the bottom-right corner", () => {
  var pos = computePointPosition({ width: 160, height: 120 }, { x: 1270, y: 790 }, DESKTOP_VIEWPORT, { margin: 4 });
  assert.equal(pos.left, DESKTOP_VIEWPORT.innerWidth - 160 - 4);
  assert.equal(pos.top, DESKTOP_VIEWPORT.innerHeight - 120 - 4);
});

test("computePointPosition clamps a point near the top-left corner (e.g. a mobile synthetic contextmenu)", () => {
  var pos = computePointPosition({ width: 160, height: 120 }, { x: 2, y: 1 }, DESKTOP_VIEWPORT, { margin: 4 });
  assert.equal(pos.left, 4);
  assert.equal(pos.top, 4);
});

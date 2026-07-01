// popover-position.js — Shared viewport-clamp positioning util for popovers,
// context menus, and dropdowns (lr-a10a).
//
// BACKGROUND: many popup call sites positioned themselves via
// getBoundingClientRect() + inline style.top/left, clamping only the
// right/bottom edges (or, in some cases, no edge at all). On mobile the
// anchor is often near the bottom or right edge of a narrow viewport (e.g.
// the fixed icon-strip, a low context-menu trigger, a synthetic
// contextmenu from a mobile action-sheet), so the popup could still land
// with its top or left edge off-screen. lr-149e fixed this one-off for the
// emoji picker (positionEmojiPicker in sidebar-projects.js); this module
// generalizes that fix into a single reusable helper so every affected
// popup routes through the same math instead of reinventing it.
//
// The clamp math (clampRect) is DOM-free and unit-testable directly from
// Node; positionPopover / positionAtPoint are thin DOM wrappers used by
// browser call sites.

// Mobile breakpoint mirrors the @media (max-width: 768px) blocks used
// throughout the CSS (see icon-strip.css, etc).
export var MOBILE_BREAKPOINT = 768;

/**
 * True when the current viewport width is at or below the mobile breakpoint.
 * @returns {boolean}
 */
export function isMobileViewport() {
  return window.innerWidth <= MOBILE_BREAKPOINT;
}

/**
 * Clamp a popover rect to the viewport on all four edges.
 *
 * Pure function — no DOM access — so it can be unit-tested directly.
 *
 * @param {{top:number, left:number, width:number, height:number}} rect
 *   The popover's natural (unclamped) position and measured size.
 * @param {{innerWidth:number, innerHeight:number}} viewport
 * @param {object} [opts]
 * @param {number} [opts.margin=8]  Minimum gap to keep from every edge.
 * @returns {{top:number, left:number}}
 */
export function clampRect(rect, viewport, opts) {
  var margin = (opts && typeof opts.margin === "number") ? opts.margin : 8;
  var maxLeft = viewport.innerWidth - rect.width - margin;
  var maxTop = viewport.innerHeight - rect.height - margin;

  // Clamp left/right first.
  var left = rect.left;
  if (left > maxLeft) left = maxLeft;
  if (left < margin) left = margin;

  // Clamp top/bottom.
  var top = rect.top;
  if (top > maxTop) top = maxTop;
  if (top < margin) top = margin;

  return { top: top, left: left };
}

/**
 * Compute a clamped position for a popover anchored to an element.
 *
 * Desktop behavior (preserves existing anchor-relative behavior): the
 * popover opens at (preferredTop, preferredLeft) relative to the anchor
 * rect, per `placement`, then gets flipped to the opposite side if it
 * would overflow, then clamped on all four edges as a final safety net
 * (this is the "prefer flip-then-clamp" requirement — flipping alone
 * cannot leave the popover off-screen because the clamp always runs
 * afterward).
 *
 * Mobile behavior: centers the popover in the viewport (matches the
 * lr-149e emoji-picker fix) rather than anchoring, since low/edge anchors
 * on narrow viewports frequently have no safe anchor-relative position.
 *
 * @param {{width:number, height:number}} popoverSize  Measured popover size (getBoundingClientRect of the appended-but-unpositioned element).
 * @param {{top:number, left:number, right:number, bottom:number}} anchorRect  Anchor element's getBoundingClientRect().
 * @param {{innerWidth:number, innerHeight:number}} viewport
 * @param {object} [opts]
 * @param {"right"|"below"|"below-right-aligned"} [opts.placement="right"]
 *   Preferred side: "right" of the anchor (default, matches existing
 *   ctx-menu behavior), "below" the anchor left-aligned, or
 *   "below-right-aligned" (below the anchor with the popover's right edge
 *   aligned to the anchor's right edge — matches session/loop ctx-menu
 *   `right: window.innerWidth - btnRect.right` anchoring).
 * @param {number} [opts.gap=6]  Gap between anchor and popover on the preferred side.
 * @param {number} [opts.margin=8]  Minimum gap from viewport edges.
 * @param {boolean} [opts.mobile]  Force mobile/desktop branch (defaults to viewport.innerWidth <= MOBILE_BREAKPOINT).
 * @returns {{top:number, left:number}}
 */
export function computePopoverPosition(popoverSize, anchorRect, viewport, opts) {
  opts = opts || {};
  var margin = typeof opts.margin === "number" ? opts.margin : 8;
  var gap = typeof opts.gap === "number" ? opts.gap : 6;
  var placement = opts.placement || "right";
  var mobile = typeof opts.mobile === "boolean" ? opts.mobile : (viewport.innerWidth <= MOBILE_BREAKPOINT);

  if (mobile) {
    var left = Math.max(margin, (viewport.innerWidth - popoverSize.width) / 2);
    var top = Math.max(margin, (viewport.innerHeight - popoverSize.height) / 2);
    return clampRect({ top: top, left: left, width: popoverSize.width, height: popoverSize.height }, viewport, { margin: margin });
  }

  var top2, left2;
  if (placement === "below-right-aligned") {
    left2 = anchorRect.right - popoverSize.width;
    top2 = anchorRect.bottom + gap;
    // Flip above the anchor if it would overflow the bottom edge.
    if (top2 + popoverSize.height > viewport.innerHeight - margin) {
      top2 = anchorRect.top - popoverSize.height - gap;
    }
  } else if (placement === "below") {
    left2 = anchorRect.left;
    top2 = anchorRect.bottom + gap;
    // Flip above the anchor if it would overflow the bottom edge.
    if (top2 + popoverSize.height > viewport.innerHeight - margin) {
      top2 = anchorRect.top - popoverSize.height - gap;
    }
  } else {
    // placement === "right" (default)
    left2 = anchorRect.right + gap;
    top2 = anchorRect.top;
    // Flip to the left of the anchor if it would overflow the right edge.
    if (left2 + popoverSize.width > viewport.innerWidth - margin) {
      left2 = anchorRect.left - popoverSize.width - gap;
    }
  }

  // Final safety net: clamp on all four edges regardless of flip outcome,
  // so a low/edge anchor (e.g. mobile bottom-sheet trigger) never leaves
  // the popover with top < 0 or top + height > innerHeight (and same for
  // left/right).
  return clampRect({ top: top2, left: left2, width: popoverSize.width, height: popoverSize.height }, viewport, { margin: margin });
}

/**
 * Compute a clamped position for a popover opened at an arbitrary point
 * (e.g. a contextmenu event's clientX/clientY) rather than anchored to an
 * element. Used by sites like terminal.js's right-click menu.
 *
 * @param {{width:number, height:number}} popoverSize
 * @param {{x:number, y:number}} point
 * @param {{innerWidth:number, innerHeight:number}} viewport
 * @param {object} [opts]
 * @param {number} [opts.margin=4]
 * @returns {{top:number, left:number}}
 */
export function computePointPosition(popoverSize, point, viewport, opts) {
  var margin = (opts && typeof opts.margin === "number") ? opts.margin : 4;
  return clampRect({ top: point.y, left: point.x, width: popoverSize.width, height: popoverSize.height }, viewport, { margin: margin });
}

/**
 * DOM wrapper: position an already-appended (so it can be measured) popover
 * element relative to an anchor element, applying the clamp math above, and
 * write the result to inline styles.
 *
 * @param {HTMLElement} el  The popover element (must already be appended to the DOM so getBoundingClientRect() reports real dimensions).
 * @param {HTMLElement} anchorEl
 * @param {object} [opts]  See computePopoverPosition opts.
 */
export function positionPopover(el, anchorEl, opts) {
  var popRect = el.getBoundingClientRect();
  var anchorRect = anchorEl.getBoundingClientRect();
  var viewport = { innerWidth: window.innerWidth, innerHeight: window.innerHeight };
  var pos = computePopoverPosition(
    { width: popRect.width, height: popRect.height },
    anchorRect,
    viewport,
    opts
  );
  el.style.position = "fixed";
  el.style.left = pos.left + "px";
  el.style.top = pos.top + "px";
}

/**
 * DOM wrapper: position an already-appended popover element at a point
 * (e.g. contextmenu clientX/clientY), applying the clamp math above.
 *
 * @param {HTMLElement} el
 * @param {{x:number, y:number}} point
 * @param {object} [opts]  See computePointPosition opts.
 */
export function positionAtPoint(el, point, opts) {
  var popRect = el.getBoundingClientRect();
  var viewport = { innerWidth: window.innerWidth, innerHeight: window.innerHeight };
  var pos = computePointPosition({ width: popRect.width, height: popRect.height }, point, viewport, opts);
  el.style.position = "fixed";
  el.style.left = pos.left + "px";
  el.style.top = pos.top + "px";
}

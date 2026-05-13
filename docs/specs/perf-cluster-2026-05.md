# Clay Performance Cluster — Implementation Spec
# May 2026

## Scope

This spec covers three related performance issues in one implementation pass:

1. **Typing lag** (lr-742c, P1) — input latency, especially in Firefox
2. **Scroll-to-bottom on session resume** (new/untracked) — on resume, view often lands mid-conversation instead of at the bottom; especially visible on mobile
3. **Syntax highlighting batch performance** (lr-b4dd, P3) — replay settle time
4. **Unbounded DOM growth** (lr-0a3e, P3) — no message virtualization yet; long sessions accumulate thousands of DOM nodes

Issues 1–3 are in scope for this pass. Issue 4 (virtual scrolling) is documented here for completeness but deferred — it is a bigger architectural change.

---

## Issue 1: Typing Lag

### Root cause analysis

The existing `autoResize()` function in `input.js` (lines 268–319) is already well-optimized:
- It uses a newline-count cache to skip forced layout on most keypresses
- It throttles the soft-wrap `scrollHeight` read to every 16 calls
- It uses `scheduleAutoResize()` via `requestAnimationFrame`

The `sendInputSync()` path is already using `sendWsQuiet()` (line 669) — that work landed.

The `selectionchange` handler in `app-cursors.js` (line 446) gates on `shouldBroadcastCollab()` — which checks `isMultiUserMode` AND `hasOtherSessionViewers()`. That is correct.

**What is still firing on every keypress in Firefox:**

1. **`showMentionMenu()` rebuilds full innerHTML on every keypress when `@` is present** — `mention.js` line 206 does a full `menuEl.innerHTML = ...` rebuild every time the query changes. This causes browser style recalculation for the menu DOM plus `querySelectorAll(".mention-item")` in `updateMentionHighlight()`. For a user typing `@claude`, that is 6 full rebuilds.

2. **`showSlashMenu()` does the same pattern** — full `ctx.slashMenu.innerHTML` rebuild on every keypress when input starts with `/`.

3. **`selectionchange` still runs `window.getSelection()` + JSON.stringify on every caret move** — Even with `shouldBroadcastCollab()` returning false, the event is registered globally and the guard is evaluated every time. Firefox fires `selectionchange` on every keypress including when the textarea caret moves. The guard is a function call chain (6 lookups) that runs synchronously.

4. **`disarmStickyBottom()` on every `input` event** (line 952 in input.js) — calls into app-rendering.js, clears two timers unconditionally, even when sticky-bottom is already disarmed. In Firefox, timer operations are slightly heavier.

5. **`hideSuggestionChips()` called conditionally** but the `getGhostSuggestion()` check only skips the DOM if the ghost is already hidden — the condition itself runs a closure and store lookup on every keypress.

### Fixes

#### Fix 1A — Mention menu diff-update instead of full rebuild

**File:** `lib/public/modules/mention.js`

Change `showMentionMenu()` to:
- Track last rendered `mentionFiltered` array by length + item ids
- If the filtered set is identical to what was last rendered, only call `updateMentionHighlight()` — do NOT rebuild `innerHTML`
- Only rebuild when the candidate set actually changes (new query that filters differently)

Implementation:
```js
var _lastMentionRenderKey = "";

export function showMentionMenu(query) {
  var candidates = buildMentionCandidates();
  // ... filter to mentionFiltered ...

  // Compute a cheap key: indices of filtered candidates in the full list
  var renderKey = mentionFiltered.map(function (c) { return c.id || c.name; }).join(",");
  if (mentionActive && renderKey === _lastMentionRenderKey) {
    // Same candidates — just update highlight
    mentionActiveIdx = 0;
    updateMentionHighlight();
    return;
  }
  _lastMentionRenderKey = renderKey;
  // ... full rebuild ...
}

export function hideMentionMenu() {
  _lastMentionRenderKey = "";
  // ... rest ...
}
```

Also switch `updateMentionHighlight()` listener from `querySelectorAll` to event delegation on the container — bind once at init, not per render.

#### Fix 1B — Slash menu diff-update

**File:** `lib/public/modules/input.js`

Same pattern as 1A. `showSlashMenu()` (lines 607–622): track last query, skip rebuild if filtered set and active index would produce identical HTML. Only rebuild when the slash filter result changes.

```js
var _lastSlashRenderKey = "";

function showSlashMenu(filter) {
  var query = filter.toLowerCase();
  slashFiltered = getAllCommands().filter(...);
  var renderKey = slashFiltered.map(function (c) { return c.name; }).join(",");
  if (ctx.slashMenu.classList.contains("visible") && renderKey === _lastSlashRenderKey) {
    slashActiveIdx = 0;
    updateSlashHighlight();
    return;
  }
  _lastSlashRenderKey = renderKey;
  // ... full rebuild ...
}

function hideSlashMenu() {
  _lastSlashRenderKey = "";
  // ... rest ...
}
```

#### Fix 1C — Guard `disarmStickyBottom` call with state check

**File:** `lib/public/modules/app-rendering.js`

`disarmStickyBottom()` (lines 141–145) should no-op immediately if `stickyBottom` is already false:

```js
export function disarmStickyBottom() {
  if (!stickyBottom) return; // already disarmed — skip timer ops
  stickyBottom = false;
  if (stickyBottomQuietTimer) { clearTimeout(stickyBottomQuietTimer); stickyBottomQuietTimer = null; }
  if (stickyBottomCeilingTimer) { clearTimeout(stickyBottomCeilingTimer); stickyBottomCeilingTimer = null; }
}
```

This eliminates two `clearTimeout(null)` calls per keypress in the normal typing case.

#### Fix 1D — Early-exit `selectionchange` when not in multi-user mode

**File:** `lib/public/modules/app-cursors.js`

The `selectionchange` listener (line 446) currently fires for all users and calls `shouldBroadcastCollab()` every time. Refactor to check once at load time whether multi-user mode is on, and in the single-user case, do not install the listener at all:

```js
// In initCursors():
if (store.get('isMultiUserMode')) {
  document.addEventListener("selectionchange", function () {
    if (!shouldBroadcastCollab()) return;
    // ... rest of handler ...
  });
}
```

Note: `isMultiUserMode` is stable after auth — it does not toggle during a session. This is safe. If the store value could change during a session, add a `store.subscribe` to install/remove the listener when mode changes.

---

## Issue 2: Session Resume Scroll-to-Bottom

### Root cause analysis

The scroll-to-bottom on resume path works as follows:

1. `history_done` message arrives (app-messages.js line 71)
2. `armStickyBottom(750)` is called (line 83)
3. Batched code highlighting runs (`highlightCodeBlocks`, `renderMermaidBlocks`)
4. Dead-session todo compaction runs
5. `finalizeAssistantBlock()` is called

The `armStickyBottom` call at step 2 is doing the right thing in theory: the `ResizeObserver` on `#messages` should re-pin to bottom each time layout shifts. But the issue is:

**The `armStickyBottom` quiet window is 750ms, and the ResizeObserver extends it on each resize.** However, on mobile, the ARM happens at `history_done` — but images that are `loading="lazy"` (see `addUserMessage` line 479: `img.loading = "lazy"`) do not load until they scroll into view. On a long session, if the bottom is far down, lazy images near the bottom may not load (and thus not trigger ResizeObserver) until the user has already scrolled there manually. This creates a chicken-and-egg: we need to scroll to see images, but the scroll is waiting for images to settle.

Additionally, `armStickyBottom` has a guard `if (prependAnchor) return` (line 119) — if pagination state is dirty, the arm is a no-op.

**Secondary issue — race between `history_done` and `finalizeAssistantBlock`:** `finalizeAssistantBlock` does async markdown rendering (`renderMarkdownAsync` → `setTimeout(0)`) for any incomplete turn. The `armStickyBottom` fires before this async render completes. When the `setTimeout(0)` fires and the last message block is rendered, it expands the DOM height — but by then the quiet timer may have already expired and sticky-bottom is disarmed. The user sees the page pinned to the second-to-last message.

**Mobile-specific aggravation:** On mobile, the viewport is smaller, so the bottom is further from the last scrolled position proportionally. The browser's mobile rendering pipeline is also slower, so the sticky-bottom quiet window may expire before layout fully settles.

### Fixes

#### Fix 2A — Extend quiet window for history replay

**File:** `lib/public/modules/app-messages.js`

Change `history_done` to arm with a longer quiet window when there is substantial history:

```js
case "history_done":
  // ...existing code...
  if (!hasNavTarget) {
    // Use a longer quiet window when replaying long history — deferred
    // content (lazy images, async markdown, todo compaction) can keep
    // arriving for several seconds on mobile with a large transcript.
    var historyLen = store.get('historyTotal') || 0;
    var quietMs = historyLen > 20 ? 2000 : 750;
    armStickyBottom(quietMs);
  }
```

Also increase `stickyBottomCeilingMs` from 8000 to 12000 for the resume case (or make it configurable on `armStickyBottom`).

#### Fix 2B — Re-arm after `finalizeAssistantBlock` completes async render

**File:** `lib/public/modules/app-rendering.js`

`finalizeAssistantBlock()` calls `renderMarkdownAsync(textToRender).then(...)` and inside the then does `setTimeout(0, ...)` before writing `innerHTML`. This means the DOM mutation that expands the last message block happens in a future task. After that write, we should re-call `pinToBottomNow()` if sticky-bottom is still armed, or re-arm briefly if it was just disarmed:

```js
// Inside finalizeAssistantBlock's setTimeout callback:
setTimeout(function () {
  if (contentEl.isConnected) {
    contentEl.innerHTML = html;
    highlightCodeBlocks(contentEl);
    renderMermaidBlocks(contentEl);
    // Re-pin after the last-message expansion — this fires after the
    // initial history_done arm may have already expired on mobile.
    armStickyBottom(500);
  }
}, 0);
```

#### Fix 2C — Force-scroll after syntax highlight batch completes

**File:** `lib/public/modules/app-messages.js`

After `highlightCodeBlocks(messagesEl)` and `renderMermaidBlocks(messagesEl)` run in `history_done`, those calls are synchronous but Highlight.js defers work using `requestAnimationFrame` internally. Add an explicit re-pin after a short delay to catch anything the deferred highlighter does:

```js
// After the highlightCodeBlocks + renderMermaidBlocks calls:
setTimeout(function () {
  if (!store.get('processing')) {
    armStickyBottom(500);
  }
}, 300);
```

This is a belt-and-suspenders fallback. If sticky-bottom is already armed and the ResizeObserver is doing its job, this is a no-op (the arm just resets timers). If sticky-bottom already expired before highlighting finished, this re-arms briefly.

#### Fix 2D — Ensure `forceScrollToBottom` uses a longer quiet window

**File:** `lib/public/modules/app-rendering.js`

`forceScrollToBottom()` (line 195) always calls `armStickyBottom(750)`. This is fine for new messages. But we should export a `forceScrollToBottomLong()` variant or add a `duration` parameter for resume paths:

```js
export function forceScrollToBottom(quietMs) {
  if (prependAnchor) return;
  armStickyBottom(quietMs || 750);
}
```

Update callers that are resume-path callers (history_done, session switch) to pass 2000.

#### Fix 2E — `scrollToBottom()` should not be bypassed when `prependAnchor` is set (review only)

Currently `scrollToBottom()` returns early if `prependAnchor` is set (line 182). This is correct for pagination. Verify that `prependAnchor` is always cleared before `history_done` fires. If not, add a clear.

---

## Issue 3: Syntax Highlight Batching During History Replay

### Root cause analysis

**File:** `lib/public/modules/app-messages.js`, `history_done` handler

The current code calls `highlightCodeBlocks(messagesEl)` as a single synchronous call on the entire `messagesEl` container. Internally, `highlightCodeBlocks` (in `markdown.js`) iterates over all `pre > code` blocks and runs `hljs.highlightElement()` on each. For a session with 50 assistant messages containing code blocks, this is 50+ synchronous hljs runs in one call, producing a long task that jank the scroll and blocks input.

Evidence from prior session engrams: "scroll settle time" is the primary complaint — the page takes 1–3 seconds to settle after resuming a long session because highlights and layout shifts cascade.

### Fix

#### Fix 3A — Defer highlight batch in requestIdleCallback (with rAF fallback)

**File:** `lib/public/modules/markdown.js` (or `app-messages.js` depending on where the batch call lives)

Split the batch highlighting across multiple idle callbacks. Process N blocks per callback to keep individual tasks under ~10ms (the "long task" threshold is 50ms, but 10ms leaves headroom for other work):

```js
export function highlightCodeBlocksBatched(container, onDone) {
  var blocks = Array.prototype.slice.call(container.querySelectorAll("pre > code:not(.hljs)"));
  if (blocks.length === 0) { if (onDone) onDone(); return; }

  var BATCH = 5; // blocks per idle callback
  var idx = 0;

  function processBatch(deadline) {
    while (idx < blocks.length) {
      // In rAF fallback mode, deadline is null — process one per frame
      if (deadline && deadline.timeRemaining() < 2) break;
      try { hljs.highlightElement(blocks[idx]); } catch (e) {}
      idx++;
      if (!deadline) break; // rAF mode: one per frame
    }
    if (idx < blocks.length) {
      if (typeof requestIdleCallback !== "undefined") {
        requestIdleCallback(processBatch, { timeout: 2000 });
      } else {
        requestAnimationFrame(function () { processBatch(null); });
      }
    } else {
      if (onDone) onDone();
    }
  }

  if (typeof requestIdleCallback !== "undefined") {
    requestIdleCallback(processBatch, { timeout: 2000 });
  } else {
    requestAnimationFrame(function () { processBatch(null); });
  }
}
```

In `history_done`, replace `highlightCodeBlocks(messagesEl)` with `highlightCodeBlocksBatched(messagesEl, function() { armStickyBottom(500); })`.

The `onDone` callback re-arms sticky-bottom after all highlights are applied (fixing Issue 2 interaction).

Note: Firefox does not have `requestIdleCallback` as of 2026 — the `rAF` fallback is essential.

---

## Issue 4: Unbounded DOM Growth (Deferred)

### Why deferred

Virtual scrolling requires:
- A height estimation algorithm for variable-height message bubbles (tools, code blocks, images)
- A scroll position → item index mapping
- IntersectionObserver-based sentinel nodes for pagination triggers
- Compatible with the existing `prependAnchor` history pagination system
- Compatible with ResizeObserver sticky-bottom

This is a ~2-week architectural change. The immediate wins from Issues 1–3 address the primary pain points without this risk. Defer to a dedicated task after the above is validated.

### Mitigation in scope (not in this spec pass)

`content-visibility: auto` on individual messages (lr-56a3 explored this — marked done/P4, meaning it was tried but likely reverted or partially applied). Check current state before re-attempting.

---

## Implementation Order

The fixes are ordered by risk (lowest first) and independence:

1. **Fix 1C** — `disarmStickyBottom` early-exit (5-line change, zero risk)
2. **Fix 2A** — Extend quiet window for long history replay (2-line change)
3. **Fix 2B** — Re-arm after `finalizeAssistantBlock` async render (3-line change)
4. **Fix 2C** — Force-scroll after highlight batch delay (4-line change)
5. **Fix 2D** — `forceScrollToBottom` accepts duration param (2-line change + callers)
6. **Fix 3A** — Batched `highlightCodeBlocks` with idle callback (new function + replace call)
7. **Fix 1A** — Mention menu diff-update (mention.js refactor)
8. **Fix 1B** — Slash menu diff-update (input.js refactor)
9. **Fix 1D** — `selectionchange` guard in initCursors

Fixes 1–5 are safe for a single commit. Fix 6 should be a separate commit. Fixes 7–9 should be a separate commit with mention/slash regression testing.

---

## Testing Checklist

### Typing lag (Firefox required)
- [ ] Type in empty session: no visible lag
- [ ] Type `@` and filter through candidates: menu does not flicker/rebuild on every char
- [ ] Type `/` and filter commands: same
- [ ] Type in a session with 50+ messages: no lag
- [ ] Type while assistant is streaming: no interference

### Scroll-to-bottom on resume
- [ ] Resume a session with 20+ messages on desktop: lands at bottom
- [ ] Resume a session with 20+ messages on mobile: lands at bottom
- [ ] Resume a session with code blocks: scroll settles after highlighting
- [ ] Resume a session where the last message was a tool use: scroll lands at bottom
- [ ] Resume a session where the last turn was cut off (incomplete): scroll lands at bottom
- [ ] Start a new session: still pins to bottom normally
- [ ] Send a message mid-session: still pins to bottom normally

### Regression
- [ ] Draft sync across two tabs still works
- [ ] DM typing indicator still works
- [ ] Cursor sharing still works in multi-user sessions (manual test with two browsers)
- [ ] Single-user session: zero `cursor_move` or `text_select` WS sends while typing
- [ ] Session switch clears and resets scroll correctly
- [ ] Pagination (scroll to top, older history loads) still works
- [ ] Mention selection (keyboard + mouse) still works
- [ ] Slash command selection still works

---

## Files Modified

| File | Changes |
|---|---|
| `lib/public/modules/app-rendering.js` | Fix 1C, Fix 2B, Fix 2D |
| `lib/public/modules/app-messages.js` | Fix 2A, Fix 2C |
| `lib/public/modules/markdown.js` | Fix 3A (new function) |
| `lib/public/modules/input.js` | Fix 1B |
| `lib/public/modules/mention.js` | Fix 1A |
| `lib/public/modules/app-cursors.js` | Fix 1D |

---

## Related Tasks

- lr-742c — Typing lag (P1) — Issues 1 + 1D address this
- lr-b4dd — Batch syntax highlighting (P3) — Issue 3 addresses this
- lr-0a3e — Virtual scrolling (P3) — deferred
- lr-728a (done) — Prior scroll resume fix — regression check required

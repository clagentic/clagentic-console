// app-history-replay.js - history_meta / history_prepend / history_done
// Extracted from app-messages.js (lr-4e49 Part 2: 185-case switch -> handler
// registry). This block was called out in the split task as the sharpest
// ordering risk: history_meta arms sticky-bottom scroll BEFORE the replay
// batch runs, and history_done re-evaluates / finalizes it AFTER. Both
// handlers share no local module state with each other (all state lives in
// `store` or module-level refs in app-rendering.js / pending-navigate.js),
// so extracting them verbatim preserves the exact sequencing the client
// already depends on — nothing here changes call order relative to the
// original switch.

import { store } from './store.js';
import { renderMarkdown, renderMarkdownAsync, highlightCodeBlocksBatched, renderMermaidBlocks } from './markdown.js';
import { getPendingNavigate, peekPendingNavigate } from './pending-navigate.js';
import { armStickyBottom, disarmStickyBottom, scrollToBottom, finalizeAssistantBlock, flushStreamBuffer, getFinalizedText, setFinalizedText, getLiveMessageText, applyRenderedHtml } from './app-rendering.js';
import { applyDeadSessionTodoCompaction, markAllToolsDone } from './tools.js';
import { accumulateContext, updateContextPanel, updateUsagePanel, getSessionUsage } from './app-panels.js';
import { stopUrgentBlink } from './app-favicon.js';

var replayLoadingEl = document.getElementById("replay-loading");

// updateHistorySentinel is intentionally NOT imported here: app-header.js
// imports processMessage from app-messages.js, so an app-history-replay.js
// -> app-header.js import would close an import cycle back through
// app-messages.js. The caller (app-messages.js, which already imports
// app-header.js today) supplies it instead.
export function handleHistoryMeta(msg, updateHistorySentinelFn) {
  store.set({ historyFrom: msg.from, historyTotal: msg.total, replayingHistory: true });
  if (replayLoadingEl) replayLoadingEl.classList.remove("hidden");
  updateHistorySentinelFn();
  // Arm sticky-bottom at the START of replay so the scroll listener's
  // "user scrolled up" detection is suppressed for the entire history
  // append sequence. Without this, scroll events fired during DOM growth
  // can set isUserScrolledUp=true before history_done's arm fires, leaving
  // the user stranded mid-conversation on resume (especially on mobile).
  // Peek without consuming — getPendingNavigate() is the single consumer
  // in the history_done branch below.  Calling getPendingNavigate() here
  // would clear the value before history_done can use it.
  var _metaNav = peekPendingNavigate();
  if (!_metaNav || !(_metaNav.toolId || _metaNav.assistantUuid)) {
    armStickyBottom(5000, true); // force: history replay must scroll to bottom
  }
}

// One assistant reply is a run of consecutive "delta" records. The server
// trims the in-memory history at a fixed count, so the run whose first message
// is already rendered at the top can continue into the tail of the next older
// page. Rendering that tail as its own message would show a second header, so
// it is split off and stitched into the top message instead. The top message
// can only be the run's own message when it is an assistant message, which is
// all the client can see of the boundary.
export function canStitchDeltaRun(topEl) {
  return !!(topEl && topEl.classList && topEl.classList.contains("msg-assistant"));
}

// Splits the trailing delta records off an older page. `lead` is their text in
// order; `head` is the rest of the page, to render normally.
export function splitTrailingDeltaRun(items) {
  var cut = items.length;
  while (cut > 0 && items[cut - 1] && items[cut - 1].type === "delta" && typeof items[cut - 1].text === "string") cut--;
  var lead = "";
  for (var i = cut; i < items.length; i++) lead += items[i].text;
  return { head: items.slice(0, cut), lead: lead };
}

// Puts `lead` in front of the text of the already-rendered message `el` and
// redraws it, keeping one header. Returns the merged text.
// The render is async, so the write is skipped when the message no longer holds
// the merged text: a delta or a later stitch changed it, and whichever changed
// it redraws the message from its own full text, so nothing is lost.
export function stitchLeadingText(el, existingText, lead) {
  var merged = lead + existingText;
  var contentEl = el.querySelector(".md-content");
  if (contentEl) {
    renderMarkdownAsync(merged).then(function (html) {
      setTimeout(function () {
        if (!contentEl.isConnected) return;
        if (getLiveMessageText(el) !== merged) return;
        applyRenderedHtml(contentEl, html);
      }, 0);
    });
  }
  return merged;
}

// Stitches `lead` into a finalized top message.
export function stitchIntoFinalized(el, lead) {
  var merged = stitchLeadingText(el, getFinalizedText(el), lead);
  setFinalizedText(el, merged);
  return merged;
}

// Stitches `lead` into the top message `el`. A message still streaming keeps its
// text in the live accumulator, so the merged text is returned for the caller to
// restore there; a finalized one keeps it in the finalized-text map. Returns the
// accumulator text to restore.
export function stitchIntoTopMessage(el, streamingEl, streamingText, lead) {
  if (el === streamingEl) return stitchLeadingText(el, streamingText, lead);
  stitchIntoFinalized(el, lead);
  return streamingText;
}

export function handleHistoryDone(msg) {
  var messagesEl = document.getElementById("messages");
  store.set({ replayingHistory: false });
  if (replayLoadingEl) replayLoadingEl.classList.add("hidden");
  // Arm sticky-bottom FIRST so the ResizeObserver is watching before the
  // bulk DOM mutations below (syntax highlighting, mermaid, todo
  // compaction) displace the scroll position. Arming after those writes
  // races the browser's layout resolution and can leave the user stranded
  // mid-conversation. The arm is later re-evaluated and potentially
  // replaced by the nav-target branch below; that branch calls
  // scrollToBottom() and does NOT re-arm, so this early arm is harmless.
  var nav = getPendingNavigate();
  var hasNavTarget = nav && (nav.toolId || nav.assistantUuid);
  if (!hasNavTarget) {
    // Scale the quiet window with history depth. A 20-item threshold
    // (old code) gave identical 2000ms to sessions with 21 and 1000
    // items. The scaled formula gives fast disarm for small sessions
    // and up to 3000ms for very large ones (>=500 events), without
    // a hard ceiling that cuts off still-settling content on mobile.
    var historyLen = store.get('historyTotal') || 0;
    var quietMs = Math.min(Math.max(500, Math.round(historyLen * 2.5)), 3000);
    armStickyBottom(quietMs, true); // force: history replay must scroll to bottom
  }
  // Batched syntax highlight + mermaid pass for the entire replayed
  // transcript. Per-message highlights are skipped during replay
  // (see markdown.js). Uses requestIdleCallback batching to avoid
  // blocking the main thread — the old synchronous highlightCodeBlocks()
  // fired hljs on every code block at once, each triggering a
  // ResizeObserver callback that reset the sticky-bottom quiet timer,
  // keeping the scroll pinned and the UI unresponsive for several
  // seconds on large sessions (especially on mobile). The completion
  // callback re-arms once after all blocks are done.
  if (messagesEl) {
    highlightCodeBlocksBatched(messagesEl, function () {
      if (!store.get('processing')) {
        armStickyBottom(500, true); // force: re-pin after all blocks settle
      }
    });
    renderMermaidBlocks(messagesEl);
    // NOTE: The old 300ms setTimeout re-arm is removed. The batched
    // highlight completion callback above replaces it. The 300ms timer
    // was a workaround for Highlight.js deferred work that no longer
    // applies with the idle-callback batching path.
  }
  // Compact dead-session todo widgets (unfinished items will never
  // resolve — the agent isn't coming back) so they don't anchor
  // visual position mid-page on resume.
  if (!store.get('sessionIsProcessing')) {
    applyDeadSessionTodoCompaction();
  }
  // Hide vendor toggle if session has history (vendor already locked)
  var _hTotal = store.get('historyTotal') || 0;
  var _vtw2 = document.getElementById("vendor-toggle-wrap");
  if (_vtw2 && _hTotal > 0) { _vtw2.classList.remove("hidden"); _vtw2.classList.add("locked"); }
  // Restore cached rich context usage BEFORE updateContextPanel runs
  if (msg.contextUsage) {
    store.set({ richContextUsage: msg.contextUsage });
  }
  // Restore accurate context data from the last result in full history.
  // accumulateContext handles context bar fill; accumulateUsage restores the
  // usage panel's context/cost values. Both assign (not sum) so replay
  // accumulation during history messages is correctly overwritten here.
  if (msg.lastUsage || msg.lastModelUsage) {
    accumulateContext(msg.lastCost, msg.lastUsage, msg.lastModelUsage, msg.lastStreamInputTokens);
  }
  // Restore usage panel from the last result in history.
  // output/cacheWrite are cumulative sums that were accumulated during replay above;
  // we keep them. cost and context come from the last result directly.
  if (msg.lastCost != null) {
    var su = getSessionUsage();
    su.cost = msg.lastCost;
    if (msg.lastStreamInputTokens) su.context = msg.lastStreamInputTokens;
  }
  updateContextPanel();
  updateUsagePanel();
  // Render + finalize any incomplete turn from the replayed history. A reply
  // still streaming is rendered but not finalized: flushing syncs the replayed
  // text into the store without closing the block, so the live deltas append to
  // it instead of opening a second message with a second header.
  var stillProcessing = !!store.get('sessionIsProcessing');
  if (stillProcessing) flushStreamBuffer();
  var _hs = store.snap();
  if (_hs.currentMsgEl && _hs.currentFullText) {
    var replayContentEl = _hs.currentMsgEl.querySelector(".md-content");
    if (replayContentEl) {
      replayContentEl.innerHTML = renderMarkdown(_hs.currentFullText);
    }
  }
  markAllToolsDone();
  if (!stillProcessing) finalizeAssistantBlock();
  stopUrgentBlink();
  // Scroll to tool element if navigating from file edit history.
  // nav/hasNavTarget are declared above (early arm block).
  if (hasNavTarget) {
    // Nav target: discard the early sticky-bottom arm and scroll to element.
    disarmStickyBottom();
    scrollToBottom();
  }
  if (hasNavTarget) {
    requestAnimationFrame(function() {
      // Prefer scrolling to the exact tool element
      var target = nav.toolId ? messagesEl.querySelector('[data-tool-id="' + nav.toolId + '"]') : null;
      if (!target && nav.assistantUuid) {
        target = messagesEl.querySelector('[data-uuid="' + nav.assistantUuid + '"]');
      }
      if (target) {
        // Auto-expand parent tool group if collapsed
        var parentGroup = target.closest(".tool-group");
        if (parentGroup) parentGroup.classList.remove("collapsed");
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("message-blink");
        setTimeout(function() { target.classList.remove("message-blink"); }, 2000);
      }
    });
  }
}

// activity-state.js - Single frontend derivation module for activity
// indicator state (dots) across every render surface.
//
// Replaces 21 previously-divergent render sites across sidebar-sessions.js,
// sidebar-projects.js, sidebar-mobile.js, app-home-hub.js, app-projects.js,
// and the 3 different state sources they used to read directly (the
// per-session processing flag, the client's own live connection processing
// flag, and setActivity) with ONE derivation:
//
//   sessionActivity(sess, currentUserId, opts) -> { active, alert, tone, label }
//   rollupActivity(list, currentUserId, opts)  -> same shape, OR-reduced
//   indicatorClass(state)                      -> the one place a CSS class is chosen
//
// Design notes:
//
// - Precedence (LOCKED, operator ruling lr-0aa7b6, promoted here from its
//   former home-hub-only special case): alert > processing > live > idle.
//   "live" and "processing" collapse to the same visual state today (no
//   separate 'live' CSS class exists anywhere in the codebase — the
//   home-hub.css comment claiming 4 states was aspirational, not real; see
//   indicatorClass() below for the reconciliation). tone: 'alert' | 'self' |
//   'other' | 'idle'.
//
// - Multi-user tone (operator ruling, epic lr-a6a449): a session/project
//   whose activity belongs to a DIFFERENT user renders in a third,
//   non-red/non-green tone ('other'), never conflated with your own
//   ('self'). Rollup rule: self wins over other when a folder/project
//   contains both — your own work is the more actionable signal, same
//   spirit as the locked alert-over-processing precedence.
//
// - This module is pure: no DOM, no store import, no WS. Callers own
//   rendering (indicatorClass gives the CSS class; callers still build the
//   element/title/etc.). This keeps activity-state.js testable as plain
//   data transforms and reusable from any surface (sidebar, mobile sheet,
//   home hub) without an import cycle back into store.js or a render module.

/**
 * @typedef {Object} ActivityState
 * @property {boolean} active - true if there is any live activity to show a dot for.
 * @property {boolean} alert - true if this represents unread/alert state (wins over active).
 * @property {"alert"|"self"|"other"|"idle"} tone - which color family to render.
 * @property {string} label - short human label for a title/tooltip attribute.
 */

/**
 * Derive activity state for a single session-shaped object. Callers pass the
 * RAW session/project object straight through — activity-state.js is the
 * ONLY place in lib/public/modules/ allowed to read .isProcessing (CI
 * assertion #2); render sites must never read it themselves, even to build
 * a wrapper object for this function.
 *
 * Accepts any object carrying the fields already on the wire for a session
 * list item (lib/sessions.js mapSessionForClient): isProcessing, unread,
 * ownerId. Also accepts the project-shaped objects used by the icon strip /
 * mobile sheets (isProcessing, unread) — ownerId is absent there, which
 * correctly falls back to tone 'self' since a project has no single owner
 * distinguishing "mine" from "someone else's" the way a session does.
 *
 * @param {object} sess - session or project object with isProcessing/unread/ownerId.
 * @param {string|number|null} [currentUserId] - the viewing user's id, for
 *   self-vs-other tone. Omit (or pass null/undefined) in single-user mode —
 *   every session then renders as 'self'.
 * @param {object} [opts]
 * @param {boolean} [opts.ignoreUnread] - suppress alert/unread from flipping
 *   `.active`/tone, for a consumer that has no unread-alert affordance of
 *   its own. Project-level dots (icon strip, mobile project rows, folder
 *   headers, home-hub project summary) are the original case: they have
 *   their OWN separate unread badge and have never shown alert red on the
 *   dot itself, so passing the raw project object (which does carry
 *   .unread, for the badge) must not also flip the dot to alert tone.
 *   lr-5edd64: the transcript footer's "is a turn running" projection
 *   (app-messages.js's session_list handler) is a second, SESSION-level
 *   caller of this — it is a processing indicator, not a dot with its own
 *   alert affordance, so unread must not pin it on. Most other
 *   session-level dots (sidebar rows, hub recent-session rows) still want
 *   full alert precedence and must NOT set this.
 * @returns {ActivityState}
 */
export function sessionActivity(sess, currentUserId, opts) {
  if (!sess) {
    return { active: false, alert: false, tone: "idle", label: "Idle" };
  }

  var alert = !(opts && opts.ignoreUnread) && (sess.unread || 0) > 0;
  var active = !!sess.isProcessing;

  if (alert) {
    return { active: true, alert: true, tone: "alert", label: "Unread activity" };
  }

  if (!active) {
    return { active: false, alert: false, tone: "idle", label: "Idle" };
  }

  var isOther = !!(sess.ownerId != null && currentUserId != null && sess.ownerId !== currentUserId);
  return isOther
    ? { active: true, alert: false, tone: "other", label: "Active (another user)" }
    : { active: true, alert: false, tone: "self", label: "Active" };
}

/**
 * lr-5edd64: the exact derivation app-messages.js's session_list handler
 * performs to project the transcript footer's 'processing' field from a
 * session_list broadcast — extracted here (a pure, DOM-free module) rather
 * than left inline, specifically so a test can import and exercise the
 * REAL production logic directly. app-messages.js is not importable under
 * plain Node (its import graph reaches the theme.js<->markdown.js circular
 * boot hazard — see activity-latch-lr-96e7da.test.js's header), so without
 * this extraction a behavioral test of this projection would necessarily
 * be testing a hand-copied reimplementation, not the code that actually
 * ships. Bounded to the entry matching activeSessionId; { ignoreUnread:
 * true } is REQUIRED here — see sessionActivity's ignoreUnread doc above
 * for why (PEACHES finding 2, this task's 8th recurrence): the footer is a
 * turn-running indicator, not an unread-alert surface.
 *
 * @param {Array<object>} sessions - msg.sessions from a session_list broadcast.
 * @param {string|number|null} activeSessionId
 * @returns {{found: boolean, active: boolean}} found=false means no entry
 *   matched activeSessionId (or activeSessionId is null) — caller must not
 *   apply a projection in that case.
 */
export function deriveSessionListProcessing(sessions, activeSessionId) {
  if (activeSessionId == null || !sessions) return { found: false, active: false };
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].id === activeSessionId) {
      return { found: true, active: sessionActivity(sessions[i], null, { ignoreUnread: true }).active };
    }
  }
  return { found: false, active: false };
}

// Precedence used by both sessionActivity's tone choice above and
// rollupActivity's OR-reduce below. Higher wins. 'self' outranks 'other'
// per the locked rollup rule; 'alert' outranks everything.
var TONE_RANK = { idle: 0, other: 1, self: 2, alert: 3 };

/**
 * Roll up a list of already-derived (or raw session/project) items into a
 * single ActivityState, replacing the 8 open-coded `anyProcessing` OR-loops
 * this module supersedes.
 *
 * Accepts either raw session/project objects (in which case sessionActivity
 * is applied per-item using the given currentUserId) or an array of
 * ActivityState objects already produced by sessionActivity — the latter is
 * useful when a caller has already computed per-item tone for other reasons
 * and wants to fold the results without re-deriving.
 *
 * @param {Array<object|ActivityState>} list
 * @param {string|number|null} [currentUserId]
 * @param {object} [opts] - forwarded to sessionActivity() for each raw item;
 *   see its ignoreUnread doc. Ignored for items that are already derived
 *   ActivityState objects.
 * @returns {ActivityState}
 */
export function rollupActivity(list, currentUserId, opts) {
  if (!list || list.length === 0) {
    return { active: false, alert: false, tone: "idle", label: "Idle" };
  }

  var best = { active: false, alert: false, tone: "idle", label: "Idle" };
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    var state = (item && typeof item.tone === "string" && typeof item.active === "boolean")
      ? item
      : sessionActivity(item, currentUserId, opts);
    if (TONE_RANK[state.tone] > TONE_RANK[best.tone]) {
      best = state;
    }
  }
  return best;
}

// The 5 CSS class families this reconciles all key their "on" state off a
// bare ".processing" (or ".alert" for the home-hub dot) suffix appended to a
// per-surface base class. indicatorClass() returns ONLY that suffix (or ""
// for idle) — callers still own their own base class name, since the base
// classes themselves are not being unified (that would be a DOM/CSS
// restructure, out of scope for a derivation module) — only the STATE ->
// CLASS decision is centralized.
/**
 * The one place a CSS class suffix is chosen from an ActivityState.
 * @param {ActivityState} state
 * @returns {string} "" | "processing" | "alert" | "other"
 */
export function indicatorClass(state) {
  if (!state || !state.active) return "";
  if (state.tone === "alert") return "alert";
  if (state.tone === "other") return "other";
  // tone === "self": the reconciled state. home-hub.css's stale comment
  // claimed 4 states (alert/processing/live/idle) but only ever shipped 3
  // classes (.alert, .processing, bare/idle) — there is no separate "live"
  // class anywhere in the codebase. "self" activity renders as ".processing"
  // everywhere, matching what every surface already shipped.
  return "processing";
}

// build-notice-gate.js — decides what the diagnostics list does with the
// "newer build installed" notice, which the daemon replays to every client that
// connects (once per project connection) and refreshes while the build is stale.
//
// Pure state and rules, no DOM: lib/public/modules/diagnostics.js asks it what
// to do and does it. The rules:
//   - one notice per running/installed build pair; an identical one never stacks;
//   - a different pair replaces the held one, or retracts it when the incoming
//     pair is itself quiet (nothing new is shown until the cooldown passes);
//   - once the operator has closed the notice (the toast, or the panel entry),
//     the same pair stays quiet until the cooldown has passed.

export var BUILD_NOTICE_SOURCE = 'build-update';
export var BUILD_NOTICE_ACTION = 'restart_for_build_update';
export var DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

/** The pair a standing notice is about, or null when `msg` is not that notice. */
export function noticeKeyOf(msg) {
  if (!msg || msg.source !== BUILD_NOTICE_SOURCE) return null;
  if (!msg.actionable || msg.actionable.action !== BUILD_NOTICE_ACTION) return null;
  var b = msg.buildUpdate;
  if (!b || !b.loadedBuildSha || !b.installedBuildSha) return null;
  return b.loadedBuildSha + ':' + b.installedBuildSha;
}

/** The daemon-configured cooldown carried on the notice, else the default. */
export function cooldownOf(msg) {
  var ms = msg && msg.noticeCooldownMs;
  return typeof ms === 'number' && isFinite(ms) && ms >= 0 ? ms : DEFAULT_COOLDOWN_MS;
}

export function createNoticeGate() {
  // key -> {at, entryGone}. entryGone: the operator removed the panel entry too,
  // so the notice must not come back at all, not just without a toast.
  var closed = Object.create(null);

  return {
    /**
     * @param {object} s
     * @param {string} s.key — noticeKeyOf(msg)
     * @param {?string} s.heldKey — key of the notice already in the list, or null
     * @param {boolean} s.toastOnScreen — a toast for the held notice is showing
     * @param {number} s.now
     * @param {number} s.cooldownMs
     * @returns {{action: 'add'|'replace'|'retract'|'skip'|'retoast', toast: boolean}}
     */
    decide: function (s) {
      var rec = closed[s.key];
      var quiet = rec !== undefined && s.now - rec.at < s.cooldownMs;
      if (rec !== undefined && !quiet) delete closed[s.key];

      if (s.heldKey === s.key) {
        // Identical notice: never a second entry. After the cooldown the toast
        // may come back if the operator had closed it.
        if (rec !== undefined && !quiet && !s.toastOnScreen) return { action: 'retoast', toast: true };
        return { action: 'skip', toast: false };
      }
      // A quiet current pair shows nothing, so a different held pair is stale
      // and must go too: one current notice, never an obsolete one left visible.
      if (quiet && s.heldKey) return { action: 'retract', toast: false };
      if (quiet && rec.entryGone) return { action: 'skip', toast: false };
      return { action: s.heldKey ? 'replace' : 'add', toast: !quiet };
    },
    toastClosed: function (key, now) {
      if (!key) return;
      var rec = closed[key];
      closed[key] = { at: now, entryGone: rec ? rec.entryGone : false };
    },
    entryDismissed: function (key, now) {
      if (key) closed[key] = { at: now, entryGone: true };
    },
  };
}

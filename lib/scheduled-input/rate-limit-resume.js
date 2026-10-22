// rate-limit-resume.js - the one scheduled input the console arms by itself: an
// automatic "continue" for a session that hit a rate limit.
//
// It is an ordinary once record with its own note. The one thing that is its
// own is its timing, which lives here and nowhere else, so a person's "in 10
// min" fires at 10 minutes.

// What the chat says an automatic "continue" after a rate limit is.
var RATE_LIMIT_RESUME_NOTE = "automatic resume after rate limit";

var RESUME_TEXT = "continue";
// After the limit resets, the vendor needs a moment before it accepts a turn.
var RESET_BUFFER_MS = 60 * 1000;
// With extra usage available (or a reset already past) there is nothing to wait
// for except the rejected query finishing.
var IMMEDIATE_DELAY_MS = 5 * 1000;

// When to send the resume for a limit that resets at `resetsAt` (ms).
function resumeAt(resetsAt, now) {
  if (!resetsAt || resetsAt <= now) return now + IMMEDIATE_DELAY_MS;
  return resetsAt + RESET_BUFFER_MS;
}

// The two calls the SDK bridge makes for a project: arm the resume for a
// session, and ask whether one is already armed (its guard). A project with no
// scheduled-input service arms nothing.
// deps: { service, slug, now? }
function createRateLimitResume(deps) {
  var now = deps.now || Date.now;
  return {
    schedule: function (session, resetsAt) {
      if (!deps.service || !session || session.destroying) return;
      var armed = deps.service.armResume(deps.slug, session, {
        at: resumeAt(resetsAt, now()),
        text: RESUME_TEXT,
        note: RATE_LIMIT_RESUME_NOTE,
      });
      if (armed && !armed.ok) console.error("[rate-limit-resume] could not arm the resume for session " + session.localId + ": " + armed.reason);
    },
    has: function (session) {
      return !!deps.service && deps.service.hasArmedResume(deps.slug, session);
    },
  };
}

module.exports = {
  createRateLimitResume: createRateLimitResume,
  RATE_LIMIT_RESUME_NOTE: RATE_LIMIT_RESUME_NOTE,
  RESUME_TEXT: RESUME_TEXT,
  RESET_BUFFER_MS: RESET_BUFFER_MS,
  IMMEDIATE_DELAY_MS: IMMEDIATE_DELAY_MS,
  resumeAt: resumeAt,
};

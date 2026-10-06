"use strict";

// Bound on operator-typed answer text. The WebSocket accepts frames far
// larger than any answer (it also carries uploads), so a kind bounds the free
// text it hands to a vendor callback and records in history. A value over the
// bound is refused rather than cut: an answer is never silently altered.
//
// The answer codecs (./ask-user-codec.js, ./elicitation-codec.js), which the
// client shares, each carry this bound in their shared body;
// test/shared-codecs.test.js holds them to this value.

var MAX_ANSWER_CHARS = 10000;

module.exports = {
  MAX_ANSWER_CHARS: MAX_ANSWER_CHARS,
};

"use strict";

// Maps the console's per-turn initiator (lib/turn-initiator.js) to the
// contract's origin vocabulary.
//
// "human" is produced only for a turn the console knows a person typed. A turn
// whose entry point named no initiator is never read as typed: it maps to
// "trigger", so an absent signal cannot render an agent as the human.

var turnInitiator = require("../turn-initiator");

var INITIATORS = turnInitiator.INITIATORS;

function originForInitiator(initiator) {
  switch (initiator) {
    case INITIATORS.HUMAN:
      return "human";
    case INITIATORS.SCHEDULED:
    case INITIATORS.SCHEDULED_NOW:
      return "scheduled";
    case INITIATORS.LOOP:
      return "loop";
    default:
      return "trigger";
  }
}

module.exports = { originForInitiator: originForInitiator };

// message-participants.js - how many different people have typed in the
// transcript on screen, which decides what the viewer's own header shows: time
// only while one person has spoken, avatar, name and time once two or more have.
// Agents and injected input are never people here.
//
// Pure state and no DOM, so node:test can run it. The renderer calls noteHuman()
// for each typed message and applies the result as a class on the transcript;
// the stylesheet does the rest, so an earlier own message changes the moment a
// second person speaks.

export var MULTI_HUMAN_CLASS = "multi-human";

var speakers = Object.create(null);
var count = 0;

/** Records a person who typed a message. Returns how many people have spoken. */
export function noteHuman(userId) {
  var key = userId == null || userId === "" ? "self" : String(userId);
  if (!speakers[key]) {
    speakers[key] = true;
    count++;
  }
  return count;
}

export function humanCount() {
  return count;
}

/** True once two or more people have spoken. */
export function isMultiHuman() {
  return count >= 2;
}

/** Forget everyone: the transcript was cleared (session or project switch). */
export function resetHumans() {
  speakers = Object.create(null);
  count = 0;
}

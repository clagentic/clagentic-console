// own-key.js - keyed lookups on names that arrive from outside: a
// requestId, a decision, a cancel reason, a kind. A plain object answers a
// name it only inherits (constructor, toString, __proto__, ...) as if it
// held it, so prompt cards read every such map through ownValue().
//
// The body between the shared-codec markers is byte-identical in
// lib/prompt-kinds/own-key.js, which wraps it for require();
// test/shared-codecs.test.js holds the two copies to that.

// <shared-codec>
var hasOwn = Object.prototype.hasOwnProperty;

// Whether map holds key itself. Only a string names an entry: any other
// value would be coerced, and an object can refuse coercion by throwing.
function hasOwnKey(map, key) {
  return typeof key === "string" && map !== null && map !== undefined && hasOwn.call(map, key);
}

// map[key] when map holds key itself, else undefined.
function ownValue(map, key) {
  return hasOwnKey(map, key) ? map[key] : undefined;
}

// Defined, not assigned, so a key named "__proto__" is an entry rather than
// a change of map's prototype.
function putOwn(map, key, value) {
  Object.defineProperty(map, key, { value: value, enumerable: true, writable: true, configurable: true });
}
// </shared-codec>

export { hasOwnKey, ownValue, putOwn };

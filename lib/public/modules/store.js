// store.js - Zustand-like vanilla store for client state
// Single source of truth for all mutable UI state.
// Functions stay in their modules; only data lives here.

var _state = {};
var _listeners = [];

function createStore(initial) {
  _state = Object.assign({}, initial);
}

var store = {
  // Read a single field: store.get('dmMode')
  get: function (key) { return _state[key]; },
  // Grab full snapshot for multi-field reads: var s = store.snap();
  snap: function () { return _state; },
  // Shallow-merge update: store.set({ dmMode: true, dmKey: 'abc' })
  set: function (partial) {
    var prev = _state;
    _state = Object.assign({}, _state, partial);
    for (var i = 0; i < _listeners.length; i++) {
      var entry = _listeners[i];
      if (entry.keys) {
        // Key-filtered subscriber: only fire if one of its declared keys changed
        var changed = false;
        for (var k = 0; k < entry.keys.length; k++) {
          if (_state[entry.keys[k]] !== prev[entry.keys[k]]) { changed = true; break; }
        }
        if (!changed) continue;
      }
      entry.fn(_state, prev);
    }
  },
  // Keep legacy aliases for gradual migration
  getState: function () { return _state; },
  setState: function (partial) { store.set(partial); },
  // subscribe(cb) — fires on every store.set (legacy, unfiltered)
  // subscribe(keys, cb) — fires only when one of the listed keys changes
  subscribe: function (keysOrFn, maybeFn) {
    var keys = null;
    var fn;
    if (typeof keysOrFn === 'function') {
      fn = keysOrFn;
    } else {
      keys = keysOrFn;
      fn = maybeFn;
    }
    var entry = { keys: keys, fn: fn };
    _listeners.push(entry);
    return function () {
      _listeners = _listeners.filter(function (l) { return l !== entry; });
    };
  }
};

export { createStore, store };

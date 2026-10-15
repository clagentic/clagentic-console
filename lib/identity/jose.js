"use strict";

// jose is an ES module. It is loaded on first use, so a console with no
// identity provider configured never loads it.

var loading = null;

function loadJose() {
  if (!loading) loading = import("jose");
  return loading;
}

module.exports = { loadJose: loadJose };

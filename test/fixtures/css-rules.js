"use strict";
// Reads a stylesheet as text into rules, with the @media condition each sits in,
// so a test can say which declarations hold at a given viewport width without a
// browser. Only width media queries are understood; any other condition is
// treated as not applying.

// Rules as { selector, body, media } in source order. media is the enclosing
// @media condition, or null for a top-level rule. Other at-rule blocks
// (@keyframes, @supports ...) are skipped, not read as rules.
function rules(css) {
  var stripped = css.replace(/\/\*[\s\S]*?\*\//g, function (m) { return " ".repeat(m.length); });
  var out = [];

  function blockEnd(open) {
    var depth = 0;
    for (var i = open; i < stripped.length; i++) {
      if (stripped[i] === "{") depth++;
      else if (stripped[i] === "}" && --depth === 0) return i;
    }
    throw new Error("unbalanced braces in stylesheet");
  }

  function walk(from, to, media) {
    var pos = from;
    while (pos < to) {
      var open = stripped.indexOf("{", pos);
      if (open === -1 || open >= to) return;
      var close = blockEnd(open);
      var prelude = stripped.slice(pos, open).trim().replace(/\s+/g, " ");
      if (/^@media\b/.test(prelude)) {
        walk(open + 1, close, prelude.replace(/^@media\s*/, ""));
      } else if (!/^@/.test(prelude)) {
        out.push({ selector: prelude, body: stripped.slice(open + 1, close), media: media });
      }
      pos = close + 1;
    }
  }

  walk(0, stripped.length, null);
  return out;
}

function mediaApplies(media, width) {
  if (media === null) return true;
  return media.split(/\s+and\s+/).every(function (p) {
    var m = /^\((max|min)-width:\s*(\d+)px\)$/.exec(p.trim());
    if (!m) return false;
    return m[1] === "max" ? width <= Number(m[2]) : width >= Number(m[2]);
  });
}

// The value a property ends up with for a selector at a viewport width: the
// last declaration among the rules that name exactly that selector and whose
// media condition holds. null when none declares it.
function valueAt(css, selector, prop, width) {
  var value = null;
  var re = new RegExp("(?:^|[;\\s])" + prop + "\\s*:\\s*([^;]+?)\\s*(?:;|$)");
  rules(css).forEach(function (r) {
    if (!mediaApplies(r.media, width)) return;
    if (r.selector.split(",").map(function (s) { return s.trim(); }).indexOf(selector) === -1) return;
    var m = re.exec(r.body);
    if (m) value = m[1];
  });
  return value;
}

module.exports = { rules: rules, mediaApplies: mediaApplies, valueAt: valueAt };

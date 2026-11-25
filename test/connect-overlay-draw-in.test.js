// connect-overlay-draw-in.test.js
//
// The connect overlay plays the console-icon draw-in from the page's first
// paint: the icon markup ships in index.html, the keyframes in css/overlays.css,
// and console-logo.js only toggles the .logo-running class on the overlay.
//
//   1. The served page and stylesheet, read as files: overlay present and not
//      hidden, icon strokes inside #console-logo-svg, the animation class on the
//      overlay, keyframes defined, nothing holds the logo at opacity 0 at first
//      paint, and the animation is gated off while hidden and on boot-error.
//   2. The real app.js graph on the shared browser stub: stopped on connect,
//      re-applied from its first frame when the socket stays down past the grace.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var { pathToFileURL } = require("url");
var stub = require("./browser-stub");

var PUBLIC_DIR = path.join(__dirname, "..", "lib", "public");
var html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
var css = fs.readFileSync(path.join(PUBLIC_DIR, "css", "overlays.css"), "utf8");

var OVERLAY_TAG = /<div id="connect-overlay"([^>]*)>/.exec(html);
var SVG = /<svg id="console-logo-svg"[^>]*>([\s\S]*?)<\/svg>/.exec(html);
var GATE = '#connect-overlay.logo-running:not(.hidden):not([data-state="boot-error"])';

var SERVED_ROWS = [
  {
    name: "the overlay is in the page, not hidden, and carries the animation class",
    check: function () {
      assert.ok(OVERLAY_TAG, "index.html has #connect-overlay");
      assert.match(OVERLAY_TAG[1], /class="[^"]*\blogo-running\b/);
      assert.doesNotMatch(OVERLAY_TAG[1], /\bhidden\b/);
    },
  },
  {
    name: "#console-logo-svg holds the icon strokes before any script runs",
    check: function () {
      assert.ok(SVG, "index.html has #console-logo-svg");
      assert.equal((SVG[1].match(/class="clogo-path /g) || []).length, 14);
      assert.match(SVG[1], /<linearGradient id="cg-overlay"/);
    },
  },
  {
    name: "each stroke has a keyframe set and a gated animation binding",
    check: function () {
      for (var i = 0; i < 14; i++) {
        assert.ok(SVG[1].indexOf("clogo-p" + i + '"') !== -1, "stroke class clogo-p" + i);
        assert.ok(css.indexOf("@keyframes clogo-draw-" + i + " ") !== -1, "keyframes clogo-draw-" + i);
        assert.ok(css.indexOf(GATE + " .clogo-p" + i + " { animation-name: clogo-draw-" + i + "; }") !== -1, "binding " + i);
      }
      assert.ok(css.indexOf("@keyframes clogo-cycle") !== -1);
      assert.ok(css.indexOf(GATE + " #console-logo-svg {") !== -1);
    },
  },
  {
    name: "no rule that applies to the running, visible overlay holds the logo at opacity 0",
    check: function () {
      var base = /#console-logo-svg \{([^}]*)\}/.exec(css);
      assert.doesNotMatch(base[1], /opacity/);
      var offRule = /(#connect-overlay:not\(\.logo-running\)[^{}]*)\{\s*opacity: 0;\s*\}/.exec(css);
      assert.ok(offRule, "the logo is hidden only by a not-running selector");
      assert.ok(offRule[1].indexOf("#connect-overlay.hidden") !== -1);
      assert.ok(offRule[1].indexOf('[data-state="boot-error"]') !== -1, "boot-error: logo off");
    },
  },
];

SERVED_ROWS.forEach(function (row) {
  test("served page: " + row.name, row.check);
});

function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

test("real module graph: connect stops the draw-in, a drop past the grace restarts it from the first frame", { timeout: 20000 }, async function () {
  var els = {};
  var overlay = stub.makeElement("connect-overlay");
  overlay.classes.add("logo-running"); // as served
  els["connect-overlay"] = overlay;
  var log = [];
  ["add", "remove"].forEach(function (m) {
    var orig = overlay.classList[m];
    overlay.classList[m] = function (c) {
      if (c === "logo-running") log.push(m);
      return orig.apply(this, arguments);
    };
  });
  stub.installBrowserGlobals({ els: els, label: "draw-in-probe" });
  await import(pathToFileURL(path.join(PUBLIC_DIR, "app.js")).href);
  var conn = await import(pathToFileURL(path.join(PUBLIC_DIR, "modules", "app-connection.js")).href);
  await wait(50);
  assert.equal(overlay.classList.contains("hidden"), true, "connected: overlay hidden");
  assert.equal(overlay.classList.contains("logo-running"), false, "connected: draw-in not running");

  log.length = 0;
  conn.setStatus("disconnected");
  await wait(300);
  assert.equal(overlay.classList.contains("hidden"), true, "inside the grace the overlay stays hidden");
  await wait(500);
  assert.equal(overlay.classList.contains("hidden"), false, "past the grace the overlay is shown");
  assert.equal(overlay.classList.contains("logo-running"), true, "draw-in running");
  assert.deepEqual(log, ["remove", "add"], "class re-applied so the cycle restarts from frame 0");

  conn.setStatus("connected");
  assert.equal(overlay.classList.contains("logo-running"), false, "reconnected: draw-in stopped");
});

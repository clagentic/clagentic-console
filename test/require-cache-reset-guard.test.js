// A test that clears modules from the require cache must fail when one of the
// modules it names no longer resolves. An empty catch around require.resolve
// hid a renamed or removed module and left the stale cached copy in place, so
// the test ran against old code without saying so.
//
// Two checks, over every .js file under test/ (subdirectories included):
//   1. no try block that calls require.resolve, however deeply its body nests,
//      is followed by a catch that does nothing;
//   2. every relative module a require-cache reset names resolves, whether it
//      is written as require.resolve("./x"), in a list passed to forEach, or
//      in a list held in a variable, with either quote style.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var TEST_DIR = __dirname;
var SELF = path.join(TEST_DIR, path.basename(__filename));

function testFiles(dir) {
  var out = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out = out.concat(testFiles(full));
    } else if (/\.js$/.test(entry.name) && full !== SELF) {
      out.push(full);
    }
  });
  return out;
}

// Index of the brace that closes the one opened at `open`, skipping string
// literals and comments, or -1 when it never closes.
function closingBrace(source, open) {
  var depth = 0;
  for (var i = open; i < source.length; i++) {
    var c = source[i];
    var next = source[i + 1];
    if (c === "/" && next === "/") {
      var eol = source.indexOf("\n", i);
      if (eol === -1) return -1;
      i = eol;
    } else if (c === "/" && next === "*") {
      var end = source.indexOf("*/", i + 2);
      if (end === -1) return -1;
      i = end + 1;
    } else if (c === '"' || c === "'" || c === "`") {
      for (i = i + 1; i < source.length && source[i] !== c; i++) {
        if (source[i] === "\\") i++;
      }
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function isOnlyComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").trim() === "";
}

// The try statements in `source` that call require.resolve and whose catch is empty.
function emptyCatchesAroundResolve(source) {
  var found = [];
  var tryRe = /\btry\s*\{/g;
  var m;
  while ((m = tryRe.exec(source)) !== null) {
    var open = m.index + m[0].length - 1;
    var close = closingBrace(source, open);
    if (close === -1) continue;
    var body = source.slice(open + 1, close);
    if (body.indexOf("require.resolve") === -1) continue;
    var after = /^\s*catch\s*(?:\([^)]*\))?\s*\{/.exec(source.slice(close + 1));
    if (!after) continue;
    var catchOpen = close + 1 + after[0].length - 1;
    var catchClose = closingBrace(source, catchOpen);
    if (catchClose === -1) continue;
    if (isOnlyComments(source.slice(catchOpen + 1, catchClose))) {
      found.push(source.slice(m.index, catchClose + 1).replace(/\s+/g, " ").slice(0, 100));
    }
  }
  return found;
}

// Relative module names a require-cache reset in `source` names.
function namedModules(source) {
  var names = [];
  var m;
  var literal = /require\.resolve\(\s*(["'])(\.{1,2}\/[^"']+)\1\s*\)/g;
  while ((m = literal.exec(source)) !== null) names.push(m[2]);
  if (source.indexOf("require.cache") !== -1) {
    // Any array of relative module names in a file that resets the cache,
    // whether it feeds forEach directly or is held in a variable first.
    var list = /\[\s*((?:(["'])\.{1,2}\/[^"']+\2\s*,?\s*)+)\]/g;
    while ((m = list.exec(source)) !== null) {
      var entry = /(["'])(\.{1,2}\/[^"']+)\1/g;
      var e;
      while ((e = entry.exec(m[1])) !== null) names.push(e[2]);
    }
  }
  return names;
}

test("the guard recognises the pattern it forbids", function () {
  var bad = [
    'try { delete require.cache[require.resolve(m)]; } catch (_) {}',
    'try { delete require.cache[require.resolve(m)]; } catch(_) {}',
    'try { delete require.cache[require.resolve("../lib/x")]; } catch (e) { /* ignore */ }',
    'try {\n  delete require.cache[require.resolve(m)];\n} catch (_) {\n}',
    'try { if (fresh) { delete require.cache[require.resolve(m)]; } } catch (_) {}',
    'try {\n  forEach(function (n) { if (n) { delete require.cache[require.resolve(n)]; } });\n} catch {\n  // nothing\n}',
    "try { const s = '}'; delete require.cache[require.resolve(m)]; } catch (_) {}",
  ];
  bad.forEach(function (source) {
    assert.equal(emptyCatchesAroundResolve(source).length, 1, source);
  });
  var fine = [
    'delete require.cache[require.resolve(m)];',
    'try { delete require.cache[require.resolve(m)]; } catch (e) { throw new Error("stale " + m); }',
    'try { if (x) { fs.rmSync(dir, { recursive: true }); } } catch (_) {}',
    'try { if (x) { delete require.cache[require.resolve(m)]; } } catch (e) { if (e) { throw e; } }',
  ];
  fine.forEach(function (source) {
    assert.deepEqual(emptyCatchesAroundResolve(source), [], source);
  });
});

test("the guard finds every way a reset names a module", function () {
  assert.deepEqual(namedModules('delete require.cache[require.resolve("../lib/a")]; require.resolve(\'./b\')'), ["../lib/a", "./b"]);
  assert.deepEqual(namedModules('["../lib/a", \'../lib/b\', "./c"].forEach(f); require.cache'), ["../lib/a", "../lib/b", "./c"]);
  assert.deepEqual(namedModules('var MODULES = [\n  "../lib/a",\n  \'./b\',\n];\nMODULES.forEach(reset); require.cache'), ["../lib/a", "./b"]);
  assert.deepEqual(namedModules('var NAMES = ["../lib/a"];'), [], "a list in a file that never touches the cache is not a reset");
});

test("no test swallows a failed require.resolve in a require-cache reset", function () {
  var offenders = [];
  testFiles(TEST_DIR).forEach(function (file) {
    emptyCatchesAroundResolve(fs.readFileSync(file, "utf8")).forEach(function (text) {
      offenders.push(path.relative(TEST_DIR, file) + ": " + text);
    });
  });
  assert.deepEqual(offenders, [], "a missing module must fail the test, not be skipped");
});

test("every module a require-cache reset names resolves", function () {
  var unresolved = [];
  testFiles(TEST_DIR).forEach(function (file) {
    namedModules(fs.readFileSync(file, "utf8")).forEach(function (name) {
      try {
        require.resolve(path.resolve(path.dirname(file), name));
      } catch (e) {
        unresolved.push(path.relative(TEST_DIR, file) + ": " + name);
      }
    });
  });
  assert.deepEqual(unresolved, []);
});

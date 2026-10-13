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

// Words after which a "/" starts a regular expression rather than a division.
var REGEX_AFTER_WORD = /^(?:return|typeof|case|in|of|delete|void|throw|new|else|do|instanceof|yield|await)$/;
var REGEX_AFTER_CHAR = "(,=:[!&|?{};+-*%<>~^";

// Whether the "+" or "-" at `j` closes a postfix "++" or "--". Such an operator
// ends an operand, so a "/" after it is a division, while a lone "+" or "-"
// (or one that follows a space-separated operator) is binary or unary and a
// "/" after it opens a regex.
function endsPostfixOperator(source, j) {
  var c = source[j];
  return (c === "+" || c === "-") && source[j - 1] === c;
}

// Whether the "/" at `i` opens a regular expression literal, judged from the
// last significant token before it. A "/" after an identifier, number, ")",
// "]" or a postfix "++"/"--" is a division. "}" is read as a division too,
// which misreads only a regex literal that starts a statement straight after a
// block.
function opensRegex(source, i) {
  var j = i - 1;
  while (j >= 0 && /\s/.test(source[j])) j--;
  if (j < 0) return true;
  if (endsPostfixOperator(source, j)) return false;
  if (REGEX_AFTER_CHAR.indexOf(source[j]) !== -1) return true;
  var end = j + 1;
  while (j >= 0 && /[A-Za-z0-9_$]/.test(source[j])) j--;
  return REGEX_AFTER_WORD.test(source.slice(j + 1, end));
}

// Index of the "/" that closes the regex literal opened at `open`, or -1.
function regexEnd(source, open) {
  var inClass = false;
  for (var i = open + 1; i < source.length; i++) {
    var c = source[i];
    if (c === "\n") return -1;
    if (c === "\\") i++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i;
  }
  return -1;
}

// Index of the brace that closes the one opened at `open`, skipping string
// literals, regular expression literals and comments, or -1 when it never
// closes. Not parsed: code nested inside a template literal's ${...}, so a
// quote or brace written there can still throw the count off.
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
    } else if (c === "/" && opensRegex(source, i)) {
      var close = regexEnd(source, i);
      if (close === -1) return -1;
      i = close;
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

// A catch body that does nothing: only comments, empty statements (";") and
// the no-op expression "void 0;".
function isEmptyBody(text) {
  var code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return code.replace(/\bvoid\s+0\b/g, "").replace(/[;\s]/g, "") === "";
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
    if (isEmptyBody(source.slice(catchOpen + 1, catchClose))) {
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
    'try { var q = /"/; delete require.cache[require.resolve(m)]; } catch (_) {}',
    "try { var b = /}/.test(x); delete require.cache[require.resolve(m)]; } catch (_) {}",
    "try { var c = /[}'\"]/g; delete require.cache[require.resolve(m)]; } catch (_) {}",
    "try { return /{/.test(x) && require.resolve(m); } catch (_) {}",
    'try { delete require.cache[require.resolve(m)]; } catch (_) { ; }',
    'try { delete require.cache[require.resolve(m)]; } catch (_) { void 0; }',
    'try { delete require.cache[require.resolve(m)]; } catch (_) { /* x */ ; void 0; ; }',
    // A "/" after a postfix ++ or -- is a division, not the start of a regex.
    'try { i++ / 2; delete require.cache[require.resolve(m)]; } catch (_) {}',
    'try { n-- / 2; delete require.cache[require.resolve(m)]; } catch (_) {}',
    'try { var h = i++ /2; delete require.cache[require.resolve(m)]; } catch (_) {}',
    // A binary or unary + or - still ends in a regex operand.
    "try { var p = a + /}/.test(x); delete require.cache[require.resolve(m)]; } catch (_) {}",
    "try { var q = i++ + /}/.test(x); delete require.cache[require.resolve(m)]; } catch (_) {}",
    "try { var r = -/}/.test(x); delete require.cache[require.resolve(m)]; } catch (_) {}",
  ];
  bad.forEach(function (source) {
    assert.equal(emptyCatchesAroundResolve(source).length, 1, source);
  });
  var fine = [
    'delete require.cache[require.resolve(m)];',
    'try { delete require.cache[require.resolve(m)]; } catch (e) { throw new Error("stale " + m); }',
    'try { if (x) { fs.rmSync(dir, { recursive: true }); } } catch (_) {}',
    'try { if (x) { delete require.cache[require.resolve(m)]; } } catch (e) { if (e) { throw e; } }',
    'try { var half = total / 2; delete require.cache[require.resolve(m)]; } catch (e) { log(half / 2); }',
    'try { delete require.cache[require.resolve(m)]; } catch (_) { void 1; }',
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

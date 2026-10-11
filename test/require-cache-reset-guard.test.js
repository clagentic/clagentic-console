// A test that clears modules from the require cache must fail when one of the
// modules it names no longer resolves. An empty catch around require.resolve
// hid a renamed or removed module and left the stale cached copy in place, so
// the test ran against old code without saying so.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var TEST_DIR = __dirname;
var SELF = path.basename(__filename);

// try { ...require.resolve(...)... } catch [(e)] { [comment] }  with nothing in the catch body
var EMPTY_CATCH_AROUND_RESOLVE = /try\s*\{[^{}]*require\.resolve[^{}]*\}\s*catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*\}/g;

function testFiles() {
  return fs.readdirSync(TEST_DIR).filter(function (f) {
    return /\.js$/.test(f) && f !== SELF;
  });
}

test("the guard recognises the pattern it forbids", function () {
  var bad = [
    'try { delete require.cache[require.resolve(m)]; } catch (_) {}',
    'try { delete require.cache[require.resolve(m)]; } catch(_) {}',
    'try { delete require.cache[require.resolve("../lib/x")]; } catch (e) { /* ignore */ }',
    'try {\n  delete require.cache[require.resolve(m)];\n} catch (_) {\n}',
  ];
  bad.forEach(function (source) {
    EMPTY_CATCH_AROUND_RESOLVE.lastIndex = 0;
    assert.ok(EMPTY_CATCH_AROUND_RESOLVE.test(source), source);
  });
  var fine = [
    'delete require.cache[require.resolve(m)];',
    'try { delete require.cache[require.resolve(m)]; } catch (e) { throw new Error("stale " + m); }',
    'try { fs.rmSync(dir, { recursive: true }); } catch (_) {}',
  ];
  fine.forEach(function (source) {
    EMPTY_CATCH_AROUND_RESOLVE.lastIndex = 0;
    assert.equal(EMPTY_CATCH_AROUND_RESOLVE.test(source), false, source);
  });
});

test("no test swallows a failed require.resolve in a require-cache reset", function () {
  var offenders = [];
  testFiles().forEach(function (file) {
    var source = fs.readFileSync(path.join(TEST_DIR, file), "utf8");
    EMPTY_CATCH_AROUND_RESOLVE.lastIndex = 0;
    var match;
    while ((match = EMPTY_CATCH_AROUND_RESOLVE.exec(source)) !== null) {
      offenders.push(file + ": " + match[0].replace(/\s+/g, " ").slice(0, 100));
    }
  });
  assert.deepEqual(offenders, [], "a missing module must fail the test, not be skipped");
});

test("every module a require-cache reset names resolves", function () {
  var unresolved = [];
  testFiles().forEach(function (file) {
    var source = fs.readFileSync(path.join(TEST_DIR, file), "utf8");
    var literal = /require\.resolve\(\s*"(\.\.?\/[^"]+)"\s*\)/g;
    var match;
    while ((match = literal.exec(source)) !== null) {
      try {
        require.resolve(path.resolve(TEST_DIR, match[1]));
      } catch (e) {
        unresolved.push(file + ": " + match[1]);
      }
    }
    var lists = /\[\s*((?:"\.\.\/[^"]+"\s*,?\s*)+)\]\s*\.forEach/g;
    while ((match = lists.exec(source)) !== null) {
      match[1].split(",").forEach(function (item) {
        var name = item.trim().replace(/^"|"$/g, "");
        if (!name) return;
        try {
          require.resolve(path.resolve(TEST_DIR, name));
        } catch (e) {
          unresolved.push(file + ": " + name);
        }
      });
    }
  });
  assert.deepEqual(unresolved, []);
});

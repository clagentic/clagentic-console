// custom-icons-lr-6c9930.test.js — lr-6c9930: emoji-picker Custom tab upload
// silently did nothing. Root cause: emoji-picker.js's doUpload() `proceed()`
// closure called hideSlugConfirm() (which nulls pendingFile) BEFORE reading
// pendingFile into the uploadCustomIcon() call, so the upload always ran
// with file=null. custom-icons.js's uploadCustomIcon() then called
// reader.readAsArrayBuffer(null), which throws synchronously inside the
// Promise executor — onerror never fires, the Promise never resolves, and
// no failure toast is ever shown (see custom-icons-lr-0847.test.js's note
// on silent failures being the recurring defect class in this surface).
//
// Coverage:
//   1. uploadCustomIcon(slug, file) resolves { ok: false } instead of
//      hanging/throwing when file is null/undefined (defense-in-depth —
//      this is the fix in custom-icons.js itself, independent of the
//      emoji-picker.js call-site ordering bug).
//   2. uploadCustomIcon(slug, file) resolves { ok: false } if
//      FileReader.readAsArrayBuffer throws synchronously for any other
//      reason, rather than leaving the Promise permanently unresolved.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

test("uploadCustomIcon: resolves ok:false when file is null (does not hang or throw)", async () => {
  var { uploadCustomIcon } = await import("../lib/public/modules/custom-icons.js?t=" + Date.now());
  var result = await uploadCustomIcon("my-icon", null);
  assert.equal(result.ok, false);
  assert.ok(result.error, "must include an error message for the failure toast");
});

test("uploadCustomIcon: resolves ok:false when file is undefined (does not hang or throw)", async () => {
  var { uploadCustomIcon } = await import("../lib/public/modules/custom-icons.js?t=" + (Date.now() + 1));
  var result = await uploadCustomIcon("my-icon", undefined);
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("uploadCustomIcon: resolves ok:false rather than hanging if FileReader throws synchronously", async () => {
  var origFileReader = global.FileReader;
  // Simulate readAsArrayBuffer(badInput) throwing synchronously — the exact
  // failure mode a null/invalid file previously triggered with the real
  // browser FileReader, which left the Promise permanently unresolved.
  global.FileReader = function () {
    this.onload = null;
    this.onerror = null;
    this.readAsArrayBuffer = function () {
      throw new TypeError("Failed to execute 'readAsArrayBuffer'");
    };
  };
  try {
    var { uploadCustomIcon } = await import("../lib/public/modules/custom-icons.js?t=" + (Date.now() + 2));
    // Pass a truthy "file" so the null-check short-circuit doesn't mask this
    // path — this exercises the try/catch around readAsArrayBuffer itself.
    var result = await uploadCustomIcon("my-icon", { name: "not-really-a-file" });
    assert.equal(result.ok, false);
    assert.ok(result.error);
  } finally {
    global.FileReader = origFileReader;
  }
});

test("uploadCustomIcon: happy path still uploads a real file and resolves ok:true (no regression)", async () => {
  var origFileReader = global.FileReader;
  var origFetch = global.fetch;
  var fetchedWith = null;
  global.FileReader = function () {
    this.onload = null;
    this.onerror = null;
    var self = this;
    this.readAsArrayBuffer = function (file) {
      setTimeout(function () {
        self.onload({ target: { result: new ArrayBuffer(8) } });
      }, 0);
    };
  };
  global.fetch = function (url, options) {
    fetchedWith = { url: url, options: options };
    return Promise.resolve({
      ok: true,
      json: function () { return Promise.resolve({ slug: "my-icon", url: "/api/custom-emoji/my-icon" }); },
    });
  };
  try {
    var { uploadCustomIcon } = await import("../lib/public/modules/custom-icons.js?t=" + (Date.now() + 3));
    var result = await uploadCustomIcon("my-icon", { name: "icon.png" });
    assert.equal(result.ok, true);
    assert.equal(fetchedWith.url, "/api/custom-emoji/my-icon");
    assert.equal(fetchedWith.options.method, "POST");
  } finally {
    global.FileReader = origFileReader;
    global.fetch = origFetch;
  }
});

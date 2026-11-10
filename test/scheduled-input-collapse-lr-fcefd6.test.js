"use strict";
// A pending scheduled input is an outbox item (scheduled-outbox.js) and long
// fired scheduled messages collapse to one line. The helper logic always runs; the browser cases drive the real
// client against a daemon booted by the harness over a private home and port,
// at a desktop and a phone width. Playwright is not a dependency of this repo:
// the browser cases run when it resolves (CLAGENTIC_CONSOLE_TEST_PLAYWRIGHT
// names its directory, otherwise a normal require) and are skipped otherwise.
// CLAGENTIC_CONSOLE_TEST_SHOTS names a directory to write screenshots into.

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var { pathToFileURL } = require("url");

var MODULES = path.join(__dirname, "..", "lib", "public", "modules");

function loadPlaywright() {
  var where = process.env.CLAGENTIC_CONSOLE_TEST_PLAYWRIGHT;
  try { return require(where || "playwright"); } catch (e) { return null; }
}

test("collapsible-text: first line, threshold and scheduled initiators", async function () {
  var m = await import(pathToFileURL(path.join(MODULES, "collapsible-text.js")).href);
  assert.equal(m.firstLine("\n\n  wake up\nsecond\nthird"), "  wake up");
  assert.equal(m.firstLine(""), "");
  assert.equal(m.firstLine(null), "");
  assert.equal(m.needsCollapse("one short line"), false);
  assert.equal(m.needsCollapse("one short line\n"), false, "a trailing newline is not a second line");
  assert.equal(m.needsCollapse("a\nb"), true);
  assert.equal(m.needsCollapse("x".repeat(m.COLLAPSE_CHAR_LIMIT)), false);
  assert.equal(m.needsCollapse("x".repeat(m.COLLAPSE_CHAR_LIMIT + 1)), true);
  assert.equal(m.isScheduledInitiator("scheduled"), true);
  assert.equal(m.isScheduledInitiator("scheduled-now"), true);
  assert.equal(m.isScheduledInitiator("loop"), false);
  assert.equal(m.isScheduledInitiator(undefined), false);
});

var PROMPT = Array.from({ length: 10 }, function (_, i) { return "line " + (i + 1) + " of the wake-up prompt"; }).join("\n");
var VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
];

var playwright = loadPlaywright();
var harness = require("./fixtures/daemon-harness");

VIEWPORTS.forEach(function (vp) {
  test("browser " + vp.name + ": pending scheduled input is an outbox item, a long fired one collapses", { skip: !playwright && "playwright not available", timeout: 120000 }, async function () {
    var d = await harness.bootDaemon();
    var browser = null;
    try {
      var cookie = (await d.adminCookie()).split("=");
      browser = await playwright.chromium.launch();
      var ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      await ctx.addCookies([{ name: cookie[0], value: cookie.slice(1).join("="), url: "http://127.0.0.1:" + d.port }]);
      var page = await ctx.newPage();
      await page.goto("http://127.0.0.1:" + d.port + "/p/entry-project/");
      await page.waitForFunction(function () { return document.querySelector("#messages"); });

      // The real path: the page's own socket arms the input and the server's
      // scheduled_input_list draws the card.
      var armed = await page.evaluate(async function (args) {
        var ref = await import("/p/entry-project/modules/ws-ref.js");
        for (var i = 0; i < 100 && !(ref.getWs() && ref.getWs().readyState === 1); i++) await new Promise(function (r) { setTimeout(r, 100); });
        return ref.sendWs({ type: "schedule_message", text: args.text, resetsAt: Date.now() + 3 * 3600000 });
      }, { text: PROMPT });
      assert.equal(armed, true, "the page's websocket was open");

      // The pending schedule is an outbox item in the composer, the only
      // rendering of it: it carries the fire time and Fire now and Cancel.
      var card = page.locator(".scheduled-queued");
      await card.waitFor({ timeout: 15000 });
      assert.equal(await page.locator(".scheduled-msg-wrap").count(), 0, "no second card");
      assert.equal(await card.locator(".scheduled-queued-fire").isVisible(), true, "Fire now visible");
      assert.equal(await card.locator(".scheduled-queued-cancel").isVisible(), true, "Cancel visible");
      assert.match(await card.locator(".scheduled-queued-time").textContent(), /Sends at/);
      assert.equal(await card.locator(".shell-queued-text").getAttribute("title"), PROMPT, "the whole prompt is kept on the item");
      if (process.env.CLAGENTIC_CONSOLE_TEST_SHOTS) await card.screenshot({ path: path.join(process.env.CLAGENTIC_CONSOLE_TEST_SHOTS, "pending-" + vp.name + ".png") });

      // Fired scheduled messages, through the client's own renderer: a short one
      // stays as it was, a long one collapses with the same control.
      await page.evaluate(async function (long) {
        var r = await import("/p/entry-project/modules/app-rendering.js");
        var inj = { senderKind: "automation", fromName: "scheduler", initiator: "scheduled" };
        r.addUserMessage("short fired message", null, null, undefined, undefined, inj);
        r.addUserMessage(long, null, null, undefined, undefined, inj);
      }, PROMPT);
      var fired = page.locator(".msg-user-injected");
      assert.equal(await fired.count(), 2);
      assert.equal(await fired.nth(0).locator(".collapsible-toggle").count(), 0, "a short fired message does not collapse");
      assert.equal(await fired.nth(0).locator(".bubble").textContent(), "short fired message");
      var longMsg = fired.nth(1);
      assert.equal(await longMsg.locator(".collapsible-full").isVisible(), false);
      assert.equal(await longMsg.locator(".collapsible-preview").textContent(), "line 1 of the wake-up prompt");
      await longMsg.locator(".collapsible-toggle").click();
      assert.equal(await longMsg.locator(".collapsible-full").textContent(), PROMPT);
      assert.equal(await longMsg.locator(".collapsible-full").isVisible(), true);
      await longMsg.locator(".collapsible-toggle").click();
      assert.equal(await longMsg.locator(".collapsible-full").isVisible(), false);
      if (process.env.CLAGENTIC_CONSOLE_TEST_SHOTS) await page.screenshot({ path: path.join(process.env.CLAGENTIC_CONSOLE_TEST_SHOTS, "fired-" + vp.name + ".png") });

      // The service is the source of truth: a reload draws the pending schedule again.
      await page.reload();
      await card.waitFor({ timeout: 15000 });
      assert.equal(await card.count(), 1);
    } finally {
      if (browser) await browser.close();
      await d.cleanup();
    }
  });
});

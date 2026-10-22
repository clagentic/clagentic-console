"use strict";
// `clagentic-console schedule-input create | list | delete`: the argument
// parsing, and the verbs end to end through the daemon's IPC handler over the
// one service the browser also uses.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var cli = require("../lib/cli/schedule-input-subcommands");
var sessionCli = require("../lib/cli/session-subcommands");
var { handleScheduledInputCommand } = require("../lib/scheduled-input/ipc");
var { createScheduledInputService } = require("../lib/scheduled-input/service");
var { createWsHandlers } = require("../lib/scheduled-input/ws-handlers");
var senderRef = require("../lib/sender-ref");
var fakes = require("./scheduled-input-fakes");

var MIN = 60000;

function local(y, mo, d, h, mi) {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}
var NOW = local(2026, 3, 1, 19, 0);

function parse(sub, args, env) {
  return cli.parseScheduleArgs(sub, args, NOW, env || {});
}

// --- parsing ---

test("create --in resolves to an absolute time and carries the session, project and prompt", function () {
  var out = parse("create", ["--session", "s1", "--project", "p", "--in", "10m", "--prompt", "hello"]);
  assert.deepEqual(out.request, { cmd: "schedule_input_create", projectSlug: "p", sessionId: "s1", prompt: "hello", at: NOW + 10 * MIN });
  assert.equal(out.resolved.atLocal, "2026-03-01 19:10");
  assert.equal(out.resolved.tomorrow, false);
});

test("create --at takes a local clock time; a past one means tomorrow and the result says so", function () {
  var today = parse("create", ["--session", "s1", "--project", "p", "--at", "20:01", "--prompt", "x"]);
  assert.equal(today.request.at, local(2026, 3, 1, 20, 1));
  assert.equal(today.resolved.tomorrow, false);
  var past = parse("create", ["--session", "s1", "--project", "p", "--at", "08:00", "--prompt", "x"]);
  assert.equal(past.request.at, local(2026, 3, 2, 8, 0));
  assert.equal(past.resolved.tomorrow, true);
  assert.equal(past.resolved.atLocal, "2026-03-02 08:00");
});

test("create --every needs exactly one end, --until or --count", function () {
  var base = ["--session", "s1", "--project", "p", "--every", "30m", "--prompt", "x"];
  var byCount = parse("create", base.concat(["--count", "4"]));
  assert.deepEqual(byCount.request.every, 30 * MIN);
  assert.equal(byCount.request.count, 4);
  assert.equal(byCount.request.until, undefined);
  var byUntil = parse("create", base.concat(["--until", "21:00"]));
  assert.equal(byUntil.request.until, local(2026, 3, 1, 21, 0));
  assert.equal(byUntil.resolved.untilLocal, "2026-03-01 21:00");
  assert.match(parse("create", base).error, /needs an end/);
  assert.match(parse("create", base.concat(["--count", "4", "--until", "21:00"])).error, /needs an end/);
  assert.match(parse("create", base.concat(["--count", "four"])).error, /whole number/);
});

test("a past --until means tomorrow", function () {
  var out = parse("create", ["--session", "s", "--project", "p", "--every", "1h", "--until", "07:00", "--prompt", "x"]);
  assert.equal(out.request.until, local(2026, 3, 2, 7, 0));
  assert.equal(out.resolved.tomorrow, true);
});

test("exactly one of --in, --at, --every; --until and --count belong to --every", function () {
  var base = ["--session", "s", "--project", "p", "--prompt", "x"];
  assert.match(parse("create", base).error, /exactly one of --in, --at or --every/);
  assert.match(parse("create", base.concat(["--in", "5m", "--at", "20:00"])).error, /exactly one/);
  assert.match(parse("create", base.concat(["--in", "5m", "--count", "2"])).error, /belong to --every/);
  assert.match(parse("create", base.concat(["--at", "20:00", "--until", "21:00"])).error, /belong to --every/);
});

test("a bad duration or time is refused with the accepted forms named", function () {
  var base = ["--session", "s", "--project", "p", "--prompt", "x"];
  assert.match(parse("create", base.concat(["--in", "soon"])).error, /--in: not a duration/);
  assert.match(parse("create", base.concat(["--at", "25:00"])).error, /--at: not a time of day/);
  assert.match(parse("create", base.concat(["--every", "x", "--count", "1"])).error, /--every: not a duration/);
});

test("the text is given one way: --prompt (or - for stdin) or --prompt-file", function () {
  var base = ["--session", "s", "--project", "p", "--in", "5m"];
  assert.match(parse("create", base).error, /one way only/);
  assert.match(parse("create", base.concat(["--prompt", "a", "--prompt-file", "f"])).error, /one way only/);
  assert.equal(parse("create", base.concat(["--prompt-file", "f.txt"])).request.promptFile, "f.txt");
  assert.equal(parse("create", base.concat(["--prompt", "-"])).request.prompt, "-");
});

test("the project defaults to the calling console session's own; outside one it is required", function () {
  var env = {};
  env[senderRef.PROJECT_ENV] = "mine";
  env[senderRef.SESSION_ENV] = "7";
  assert.equal(parse("create", ["--session", "s", "--in", "5m", "--prompt", "x"], env).request.projectSlug, "mine");
  assert.equal(parse("create", ["--session", "s", "--project", "other", "--in", "5m", "--prompt", "x"], env).request.projectSlug, "other");
  assert.match(parse("create", ["--session", "s", "--in", "5m", "--prompt", "x"]).error, /Missing required option --project/);
  assert.match(parse("create", ["--project", "p", "--in", "5m", "--prompt", "x"]).error, /Missing required option --session/);
});

test("unknown flags, missing values and repeated flags are refused; list and delete take their own flags", function () {
  assert.match(parse("create", ["--session", "s", "--bogus", "x"]).error, /Unknown option/);
  assert.match(parse("create", ["--session"]).error, /Missing value for --session/);
  assert.match(parse("create", ["--session", "a", "--session", "b"]).error, /given twice/);
  assert.match(parse("list", ["--prompt", "x"]).error, /Unknown option/);
  assert.match(parse("delete", ["--session", "s"]).error, /Unknown option/);
  assert.match(parse("delete", []).error, /Missing required option --id/);
  assert.deepEqual(parse("delete", ["--id", "si_1", "--project", "p"]).request, { cmd: "schedule_input_delete", projectSlug: "p", id: "si_1" });
  assert.deepEqual(parse("list", ["--session", "s", "--project", "p", "--state", "any"]).request,
    { cmd: "schedule_input_list", projectSlug: "p", sessionId: "s", state: "any" });
  assert.deepEqual(parse("list", []).request, { cmd: "schedule_input_list" });
  assert.match(parse("explode", []).error, /Unknown schedule-input command/);
});

test("a prompt is read from stdin for - and from a file for --prompt-file, without the final newline", function () {
  var fromStdin = { prompt: "-" };
  assert.equal(cli.loadPrompt(fromStdin, function () { return "from stdin\n"; }, null), null);
  assert.equal(fromStdin.prompt, "from stdin");
  var fromFile = { promptFile: "/some/file" };
  assert.equal(cli.loadPrompt(fromFile, null, function (p) { assert.equal(p, "/some/file"); return "from file\n"; }), null);
  assert.equal(fromFile.prompt, "from file");
  assert.equal("promptFile" in fromFile, false);
  var plain = { prompt: "kept\n" };
  cli.loadPrompt(plain, null, null);
  assert.equal(plain.prompt, "kept\n", "an argument is not trimmed");
  var missing = { promptFile: "/nope" };
  assert.match(cli.loadPrompt(missing, null, function () { throw new Error("ENOENT"); }), /Cannot read --prompt-file/);
});

test("the exit codes follow the session verbs: 0 done, 1 anything else", function () {
  assert.equal(cli.exitCodeFor({ ok: true }), sessionCli.EXIT.OK);
  assert.equal(cli.exitCodeFor({ ok: false, result: "refused" }), sessionCli.EXIT.FAILED);
  assert.equal(cli.exitCodeFor({ ok: false, result: "not-found" }), sessionCli.EXIT.FAILED);
  assert.equal(cli.exitCodeFor(undefined), sessionCli.EXIT.FAILED);
});

test("bin/cli.js dispatches schedule-input and lists the verbs in its help; the daemon routes all three commands", function () {
  var bin = fs.readFileSync(path.join(__dirname, "..", "bin", "cli.js"), "utf8");
  assert.match(bin, /args\[0\] === "schedule-input"/);
  ["create", "list", "delete"].forEach(function (sub) {
    assert.match(bin, new RegExp("schedule-input " + sub + " "));
  });
  var daemon = fs.readFileSync(path.join(__dirname, "..", "lib", "daemon.js"), "utf8");
  ["schedule_input_create", "schedule_input_list", "schedule_input_delete"].forEach(function (cmd) {
    assert.match(daemon, new RegExp('case "' + cmd + '":'));
  });
});

// --- end to end: the verbs through the daemon's handler, over the one service ---

function world() {
  var dir = fakes.tmpDir();
  var clock = fakes.makeClock(NOW);
  var caller = fakes.makeSession(3, "vendor-caller", { isProcessing: true, agentName: "planner", vendor: "claude" });
  var target = fakes.makeSession(1, "vendor-target");
  var other = fakes.makeSession(1, "vendor-other");
  var projects = {
    alpha: fakes.makeProject("/work/alpha", [target, caller]),
    beta: fakes.makeProject("/work/beta", [other]),
  };
  var sessionInputs = {};
  var service = createScheduledInputService({
    dir: dir,
    getProject: function (slug) { return projects[slug] || null; },
    sessionInput: {
      fireScheduled: function (req) {
        sessionInputs[req.projectSlug] = (sessionInputs[req.projectSlug] || []).concat([req]);
        return { ok: true, result: "delivered" };
      },
    },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  service.attachProject("alpha");
  service.attachProject("beta");
  var daemonDeps = { service: service, getProject: function (slug) { return projects[slug] || null; } };
  // Runs one CLI invocation the way runScheduleInput does, with the daemon's
  // handler on the far side of the IPC call.
  async function run(sub, args, env) {
    var parsed = cli.parseScheduleArgs(sub, args, clock.now(), env || {});
    if (parsed.error) return { error: parsed.error };
    var request = parsed.request;
    if (sub === "create") {
      cli.loadPrompt(request, function () { return "prompt from stdin\n"; }, function () { return "prompt from file\n"; });
      sessionCli.withSenderRef(request, env || {});
    }
    var res = await sessionCli.requestDaemon(request, {
      isDaemonAlive: function () { return true; },
      sendIPC: function (req) { return Promise.resolve(handleScheduledInputCommand(daemonDeps, JSON.parse(JSON.stringify(req)))); },
    });
    return { res: cli.withResolved(res, parsed.resolved), code: cli.exitCodeFor(res) };
  }
  return {
    dir: dir, clock: clock, service: service, projects: projects, sessionInputs: sessionInputs, run: run, caller: caller,
    cleanup: function () { service.stop(); fakes.removeDir(dir); },
  };
}

test("create, list and delete through the daemon; a once input then fires into the session", async function () {
  var w = world();
  try {
    var made = await w.run("create", ["--session", "vendor-target", "--project", "alpha", "--in", "10m", "--prompt", "ping"]);
    assert.equal(made.code, 0);
    assert.equal(made.res.result, "scheduled");
    assert.equal(made.res.project, "alpha");
    assert.equal(made.res.record.kind, "once");
    assert.equal(made.res.record.createdBy, "cli");
    assert.equal(made.res.resolved.atLocal, "2026-03-01 19:10");
    var id = made.res.record.id;

    var listed = await w.run("list", ["--session", "vendor-target", "--project", "alpha"]);
    assert.equal(listed.code, 0);
    assert.equal(listed.res.count, 1);
    assert.equal(listed.res.inputs[0].id, id);
    assert.equal(listed.res.inputs[0].project, "alpha");
    assert.equal(listed.res.inputs[0].nextAt, NOW + 10 * MIN);
    assert.equal(listed.res.inputs[0].firedCount, 0);
    assert.equal(listed.res.inputs[0].lastOutcome, null);

    await w.clock.advance(10 * MIN);
    assert.equal(w.sessionInputs.alpha.length, 1);
    assert.equal(w.sessionInputs.alpha[0].prompt, "ping");
    var after = await w.run("list", ["--project", "alpha", "--state", "any"]);
    assert.equal(after.res.inputs[0].state, "done");
    assert.equal(after.res.inputs[0].lastOutcome, "delivered");
    assert.equal(after.res.inputs[0].firedCount, 1);

    var again = await w.run("create", ["--session", "1", "--project", "alpha", "--every", "5m", "--count", "3", "--prompt-file", "/x"]);
    assert.equal(again.code, 0, "a console id works as well as the vendor id");
    assert.equal(again.res.record.sessionId, "vendor-target", "and is stored as the stable id");
    var gone = await w.run("delete", ["--id", again.res.record.id]);
    assert.equal(gone.code, 0);
    assert.equal(gone.res.result, "deleted");
    assert.equal(gone.res.project, "alpha", "found without naming the project");
    assert.equal((await w.run("delete", ["--id", again.res.record.id])).code, 1);
  } finally { w.cleanup(); }
});

test("the limits and the missing end are refused through the daemon with exit 1", async function () {
  var w = world();
  try {
    var args = function (extra) { return ["--session", "vendor-target", "--project", "alpha", "--prompt", "x"].concat(extra); };
    assert.equal((await w.run("create", args(["--every", "30s", "--count", "2"]))).res.reason.indexOf("every must be between 1 minute and 24 hours"), 0);
    assert.equal((await w.run("create", args(["--every", "25h", "--count", "2"]))).code, 1);
    assert.equal((await w.run("create", args(["--every", "1m", "--count", "2"]))).code, 0);
    assert.equal((await w.run("create", args(["--every", "24h", "--count", "2"]))).code, 0);
    assert.ok((await w.run("create", args(["--every", "10m"]))).error, "no end is refused before it reaches the daemon");
    for (var i = 0; i < 3; i++) assert.equal((await w.run("create", args(["--in", (i + 1) + "h"]))).code, 0);
    var sixth = await w.run("create", args(["--in", "5h"]));
    assert.equal(sixth.code, 1);
    assert.match(sixth.res.reason, /limit/);
  } finally { w.cleanup(); }
});

test("an unknown session or project is refused, not created", async function () {
  var w = world();
  try {
    var noSession = await w.run("create", ["--session", "vendor-nobody", "--project", "alpha", "--in", "5m", "--prompt", "x"]);
    assert.equal(noSession.code, 1);
    assert.equal(noSession.res.result, "not-found");
    var noProject = await w.run("create", ["--session", "vendor-target", "--project", "gamma", "--in", "5m", "--prompt", "x"]);
    assert.equal(noProject.code, 1);
    assert.equal(w.service.list("alpha", { state: "any" }).count, 0);
  } finally { w.cleanup(); }
});

test("createdBy is the calling console session, as send-input records its sender", async function () {
  var w = world();
  try {
    var env = {};
    env[senderRef.PROJECT_ENV] = "alpha";
    env[senderRef.SESSION_ENV] = "3";
    var made = await w.run("create", ["--session", "vendor-target", "--in", "5m", "--prompt", "x"], env);
    assert.equal(made.res.record.createdBy, "planner@alpha");
    assert.equal(made.res.project, "alpha", "the project defaulted to the caller's");
  } finally { w.cleanup(); }
});

test("list spans projects and filters by session; records made in the browser appear, and the CLI can delete them", async function () {
  var w = world();
  try {
    var target = w.projects.alpha.sm.sessions.get(1);
    var wsSent = [];
    var handlers = createWsHandlers({
      slug: "alpha", service: w.service, getSessionForWs: function () { return target; }, sendTo: function (ws, o) { wsSent.push(o); },
    });
    handlers.handle({}, { type: "schedule_message", text: "from the browser", resetsAt: NOW + 20 * MIN });
    await w.run("create", ["--session", "vendor-other", "--project", "beta", "--in", "5m", "--prompt", "cli one"]);

    var all = await w.run("list", []);
    assert.deepEqual(all.res.inputs.map(function (r) { return r.project + ":" + r.preview; }), ["beta:cli one", "alpha:from the browser"], "sorted by next time");
    var onlyAlpha = await w.run("list", ["--project", "alpha"]);
    assert.equal(onlyAlpha.res.count, 1);
    assert.equal(onlyAlpha.res.inputs[0].createdBy, "browser");
    assert.equal((await w.run("list", ["--session", "vendor-other"])).res.count, 1);

    // The other way: a record the CLI makes is in the browser's list.
    var made = await w.run("create", ["--session", "vendor-target", "--project", "alpha", "--every", "10m", "--count", "2", "--prompt", "from the cli"]);
    handlers.handle({}, { type: "scheduled_input_list_request" });
    var shown = wsSent[wsSent.length - 1].inputs.map(function (r) { return r.text; }).sort();
    assert.deepEqual(shown, ["from the browser", "from the cli"]);

    // And the CLI deletes what the browser made.
    var browserId = onlyAlpha.res.inputs[0].id;
    assert.equal((await w.run("delete", ["--id", browserId])).code, 0);
    handlers.handle({}, { type: "scheduled_input_list_request" });
    assert.deepEqual(wsSent[wsSent.length - 1].inputs.map(function (r) { return r.id; }), [made.res.record.id]);
  } finally { w.cleanup(); }
});

test("a once input made for a session no longer in memory is stored under its vendor id and listed", async function () {
  var w = world();
  try {
    fs.mkdirSync(path.join(w.dir, "store-of-alpha"), { recursive: true });
    w.projects.alpha.sm.sessionsDir = path.join(w.dir, "store-of-alpha");
    fs.writeFileSync(path.join(w.dir, "store-of-alpha", "vendor-reaped.jsonl"), JSON.stringify({ type: "meta", cliSessionId: "vendor-reaped" }) + "\n");
    var made = await w.run("create", ["--session", "vendor-reaped", "--project", "alpha", "--in", "5m", "--prompt", "wake"]);
    assert.equal(made.code, 0);
    assert.equal(made.res.record.sessionId, "vendor-reaped");
    await w.clock.advance(5 * MIN);
    assert.equal(w.sessionInputs.alpha[0].sessionId, "vendor-reaped", "the firing resumes it by id");
  } finally { w.cleanup(); }
});

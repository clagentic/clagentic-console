// lib/cli/output.js
//
// Ending a CLI subcommand without losing what it printed. On a pipe, stdout is
// asynchronous in Node: console.log followed at once by process.exit can cut the
// output off, and the larger the output, the likelier. exitFlushed waits for the
// writes already queued on stdout and stderr to reach the operating system, then
// exits.

// A zero-length write is queued behind every earlier write on the same stream,
// so its callback runs only after they have been flushed.
function drained(stream, then) {
  stream.write("", then);
}

// io is for tests: { out, err, exit } in place of the process streams and exit.
function exitFlushed(code, io) {
  io = io || {};
  var out = io.out || process.stdout;
  var err = io.err || process.stderr;
  var exit = io.exit || process.exit;
  drained(err, function () {
    drained(out, function () {
      exit(code);
    });
  });
}

module.exports = { exitFlushed: exitFlushed };

// Per-command option ALLOWLISTS for the read-only Bash auto-approve.
//
// Every auto-approvable command declares the exact option tokens it accepts.
// A token that starts with "-" and is not exactly in the command's set means
// the call goes to the permission prompt. There is no prefix matching (GNU
// long options accept unique abbreviations, so "--outp" would reach "--output"
// if a denylist named only the full spelling) and a token like "-xyz" is never
// split into letters. A command that declares no options accepts none.
// Non-option tokens (paths, revisions) are allowed; the caller has already
// restricted every token to the character allowlist.
//
// When in doubt leave an option out: it only costs a prompt.

var DIGIT_OPTION_RE = /^-[0-9]+$/;

function opts(list) {
  var set = {};
  list.split(/\s+/).filter(Boolean).forEach(function (o) { set[o] = true; });
  return set;
}

var GREP_OPTS = "-r -R -n -i -v -l -c -E -F -w -x -o -h -H -q -s -e -rn -ri -rl -rin -in -ni -nr -il -iv";

// name -> { opts: set, digits: true when "-<digits>" is accepted }
var COMMANDS = {
  // Navigation
  cd: {}, pushd: {}, popd: {},
  // File and directory inspection
  ls: { opts: opts("-l -a -la -al -h -lh -1 -R -t -r -A -lA -lah -ltr") },
  cat: { opts: opts("-n") },
  head: { opts: opts("-n -c"), digits: true },
  wc: { opts: opts("-l -w -c -m") },
  stat: {}, du: { opts: opts("-h -s -sh -c") }, df: { opts: opts("-h -T") },
  readlink: {}, realpath: {}, basename: {}, dirname: {},
  // Search
  grep: { opts: opts(GREP_OPTS) },
  fgrep: { opts: opts(GREP_OPTS) },
  egrep: { opts: opts(GREP_OPTS) },
  rg: { opts: opts("-n -i -l -c -w -F -v -t -e") },
  // Lookup
  which: { opts: opts("-a") }, type: { opts: opts("-a -t") }, whereis: {}, hash: {},
  // Environment and system info
  echo: { opts: opts("-n") }, printf: {}, printenv: {}, pwd: {},
  whoami: {}, id: { opts: opts("-u -g -n") }, groups: {},
  uname: { opts: opts("-a -r -m -s -n") }, uptime: { opts: opts("-p") }, arch: {},
  nproc: {}, free: { opts: opts("-h -m -g") }, lsb_release: { opts: opts("-a") },
  sw_vers: {}, locale: {},
  // Text processing (stdin to stdout)
  jq: { opts: opts("-r -c -s -n -e") },
  cut: { opts: opts("-d -f -c -s") },
  tr: { opts: opts("-d -s -c") },
  paste: { opts: opts("-s -d") },
  column: { opts: opts("-t -s") },
  fold: { opts: opts("-w -s") },
  rev: {}, tac: {}, nl: {}, expand: {}, unexpand: {},
  fmt: {}, pr: {}, comm: { opts: opts("-1 -2 -3 -12 -13 -23") }, join: {},
  // Comparison and hashing
  diff: { opts: opts("-u -q -r -i -w -b") },
  cmp: { opts: opts("-s -l") },
  md5sum: { opts: opts("-c") }, sha256sum: { opts: opts("-c") }, sha1sum: { opts: opts("-c") },
  shasum: { opts: opts("-c") }, cksum: {}, sum: {}, b2sum: { opts: opts("-c") },
  base64: { opts: opts("-d") },
  od: { opts: opts("-c -x") }, hexdump: { opts: opts("-C") },
  // Misc read-only
  test: { opts: opts("-e -f -d -r -w -x -s -z -n") }, "true": {}, "false": {}, seq: {},
  help: {}, apropos: {},
  cal: { opts: opts("-y") }, bc: { opts: opts("-l") }, expr: {}, factor: {},
  lsof: { opts: opts("-i -n -P") },
  ps: { opts: opts("-e -f -ef -A") },
  pgrep: { opts: opts("-f -l -a -x") },
  netstat: { opts: opts("-a -n -l -t -u -p -r -tuln -tulnp -tlnp -an") },
  dig: {}, nslookup: {}, host: {}, traceroute: {},
};

var GIT_SUBCOMMANDS = {
  status: { opts: opts("-s --short -b --branch --porcelain") },
  log: { opts: opts("--oneline -n --stat --graph --decorate"), digitsMax: 50 },
  diff: { opts: opts("--stat --name-only --name-status --cached --staged") },
  show: { opts: opts("--stat --name-only") },
};

// Whether every option token in args is declared by spec.
function optionsAllowed(args, spec, startIndex) {
  var declared = spec.opts || {};
  for (var i = startIndex; i < args.length; i++) {
    var tok = args[i];
    if (tok.charAt(0) !== "-") continue;
    if (Object.prototype.hasOwnProperty.call(declared, tok)) continue;
    if (DIGIT_OPTION_RE.test(tok)) {
      if (spec.digitsMax) {
        var n = parseInt(tok.slice(1), 10);
        if (n >= 1 && n <= spec.digitsMax) continue;
      } else if (spec.digits) {
        continue;
      }
    }
    return false;
  }
  return true;
}

// Commands whose whole argument form, not just the options, is fixed.
var EXACT_FORMS = {
  // date -s sets the clock: only no argument or one +FORMAT.
  date: function (args) {
    return args.length === 0 || (args.length === 1 && args[0].charAt(0) === "+");
  },
  // hostname NAME renames the host; ifconfig with arguments configures an interface.
  hostname: function (args) { return args.length === 0; },
  ifconfig: function (args) { return args.length === 0; },
  // "ip link set ..." and the rest write: only the two plain listings.
  ip: function (args) {
    return args.length === 1 && (args[0] === "addr" || args[0] === "route");
  },
  // Only the read-only subcommands; no remote, tag, branch (mutating forms).
  git: function (args) {
    if (args.length === 0) return false;
    if (args[0] === "--version") return args.length === 1;
    if (!Object.prototype.hasOwnProperty.call(GIT_SUBCOMMANDS, args[0])) return false;
    return optionsAllowed(args, GIT_SUBCOMMANDS[args[0]], 1);
  },
};

// tokens: the segment's words, command word first.
function isAutoApprovableSegment(tokens) {
  var name = tokens[0];
  if (!name) return false;
  if (Object.prototype.hasOwnProperty.call(EXACT_FORMS, name)) return EXACT_FORMS[name](tokens.slice(1));
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, name)) return false;
  return optionsAllowed(tokens.slice(1), COMMANDS[name], 0);
}

module.exports = { isAutoApprovableSegment: isAutoApprovableSegment };

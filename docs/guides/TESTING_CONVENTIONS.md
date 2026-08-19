# Testing Conventions

## Regression tests must be demonstrated failing pre-fix (lr-4e1242)

### The problem

Three PRs shipped a regression test that passed both with and without the
bug it claimed to cover:

1. **lr-9bcd7b** — a test passed with and without the bug.
2. **lr-255e** — same.
3. **PR #394**, first attempt (lr-3ccc78) — a test that claimed to cover a
   symlink-escape containment fix never called `fs.symlinkSync`. It created
   an unrelated directory that a `readdirSync` listing never surfaced, so it
   passed whether or not containment worked.

The correction each time is the same and already known: verify, via `git
stash` or an equivalent pre-fix checkout, that the test genuinely **fails**
against unmodified code before the fix exists. Applied, it works — AMoS
confirmed 5 of 8 tests genuinely failed pre-fix on lr-4a13c3, and 3 of 5 on
PR #393.

The PR #394 case is the one worth reading closely, because it shows the
convention failing even when everyone involved already knew it. The
dispatching prompt named lr-9bcd7b and lr-255e explicitly. The author
apparently believed (or claimed) the test was verified. PEACHES reviewed the
same test and its narrative described it as verifying "symlinks don't
escape base dir" — a plausible-sounding description of a test that never
exercised a symlink at all. The test was only caught because BOBBIE, on a
second pass, independently traced the pre-fix commit rather than trusting
the author's or PEACHES's read of it.

### Why a reminder isn't a mechanism

The convention was, at that point, transmitted entirely by a coordinator
remembering to paste it into a dispatch prompt. It held exactly as long as
someone remembered to say it, and it failed on the one round where it was
said explicitly and a human/agent reviewer still passed the vacuous test on
a plausible-sounding description rather than tracing it. Restating the
convention more prominently (a project CLAUDE.md rule, for example) does not
change that failure mode: CLAUDE.md is read by the *author*, not
independently checked by anyone downstream, and the PR #394 failure was a
**reviewer** failure, not an author-forgot-the-rule failure — the author's
claim was simply not verified.

### The mechanism actually adopted

**`.crew/peaches.yaml` rule `clagentic-console.demonstrated-test-failure`**
makes BOBBIE's PR #394 behavior — independently tracing the pre-fix commit
rather than accepting a claim — the standard PEACHES review step for any new
or modified file under `test/**/*.js`, not something that happens only when
a particular reviewer happens to think of it. This was chosen over three
other candidates considered for this task:

- **A CLAUDE.md convention alone.** Rejected: this is the mechanism that
  already existed and already failed at PR #394, including in the specific
  case where the reminder was stated explicitly in the dispatch prompt. It
  binds the author, not the reviewer, and the demonstrated failure mode was
  a reviewer failure.
- **A required annotation/comment in the test file, checked by a lint
  rule.** Rejected: a lint rule can only check that an annotation exists,
  not that its claim is true. A fabricated "observed failing pre-fix"
  comment costs the same one line as a fabricated stash claim already does
  today — the rule would add a decorative artifact without adding
  verification. It also conflicts with this codebase's standing convention
  against decorative/provenance comments in source (lore-ID discipline):
  once the claim is unverifiable by the lint itself, the comment is exactly
  that — decoration, not enforcement.
- **Mutation testing on changed files.** Rejected as disproportionate for
  this codebase. It would catch a broader class than the one in front of
  us (regression tests that don't actually exercise the changed logic) but
  at real cost: a new dependency and toolchain (`allow_new_deps` is not
  granted for this), added runtime on a suite that already has a documented
  flake budget (lr-b5d62f), and per-file tuning to avoid false positives on
  the daemon's heavily integration-style tests (WebSocket relay, IPC,
  filesystem). The narrower problem — "this specific new test would have
  passed against the bug it claims to fix" — is fully covered by the
  reviewer trace above at a fraction of the cost. If the class of bug this
  task exists for widens (e.g. correctness bugs with no accompanying test
  at all slipping through), mutation testing is worth revisiting on its own
  merits, but adopting it now to solve a narrower, already-solved problem
  would be disproportionate.

PEACHES applies the rule as a review-judgment item (no regex `pattern`
field — the reviewer's model reasoning applies it directly against the
diff), consistent with how PEACHES already applies non-mechanical rulebook
entries.

### The nondeterministic-failure case

Not every regression test can be demonstrated failing on demand. lr-b5d62f
is a load-dependent flake in `test/daemon-bootstrap-guard.test.js` that
reproduces in only about 3 of 8 full-suite runs — by construction, a
"prove it fails before the fix" checkout cannot reliably reproduce it either.
A rule that required demonstrated failure unconditionally would either block
this legitimate class of work or, worse, teach people to write a false
"verified via stash" attestation to get past it — which is the exact
failure mode this rule exists to close, just moved one level up.

The rule's answer: for a nondeterministic/load-dependent failure, PEACHES
does not require demonstrated failure. It requires the PR body or a commit
message to say explicitly that the failure is load-dependent/nondeterministic
**and name the actual mechanism** — the specific race, ordering, or timing
condition — not merely assert "flaky, trust me". An unnamed-mechanism
flakiness claim is treated as a finding in its own right: it is exactly as
unverifiable as an unproven determinism claim, and accepting it without
challenge would recreate the same gap this rule closes.

# backtrack-ledger

[![test](https://github.com/llinok111/backtrack-ledger/actions/workflows/test.yml/badge.svg?branch=master)](https://github.com/llinok111/backtrack-ledger/actions/workflows/test.yml)
[![pages](https://github.com/llinok111/backtrack-ledger/actions/workflows/pages.yml/badge.svg?branch=master)](https://github.com/llinok111/backtrack-ledger/actions/workflows/pages.yml)

**Live workbench:** https://llinok111.github.io/backtrack-ledger/

Measure what a regular expression actually costs a backtracking engine, construct the
input that makes it worse, and check whether a rewrite is safe — with numbers you can
reproduce.

Built on [`regexp-tree`](https://github.com/DmitrySoshnikov/regexp-tree) (MIT). The
parser, AST, generator and finite-automaton interpreter are the upstream ones; this
project adds a second interpreter that keeps a ledger.

```
pattern   /(a+)+b/
pump      "a" (innermost unbounded repetition)
suffix    "c"

n   input               steps       backtracks  stack   ms
4   "aaaac"             84          52          4       1.08
8   "aaaaaaaac"         1516        1004        8       0.65
12  "aaaaaaaaaaaac"     24548       16356       12      5.38
16  "aaaaaaaaaaaaaaa…"  393180      262108      16      13.14

growth    exponential
          Each extra character multiplies the step count by about 2.02x
```

## Why this exists

Existing tooling answers "is this regex dangerous?" — `eslint-plugin-regexp` reports
super-linear backtracking and even ships a fix, `recheck` performs a precise automaton
analysis, and `regexp-tree`'s own interpreter simulates NFA/DFA state transitions for
education.

What is missing is the measurement layer:

| Question | Upstream `regexp-tree` | `eslint-plugin-regexp` | This project |
|---|---|---|---|
| Does it match? | yes (`exec`, `fa.test`) | n/a | yes |
| Static risk verdict | no | yes | derived from measurements |
| How many decisions on *this* input? | no | no | **yes, counted in the VM** |
| Which input causes the blow-up? | no | reports an accepted attack string | **yes, constructed and measured** |
| Is the rewrite language-preserving? | no | applies a fix without re-verification | **yes, bounded counterexample search** |
| Observed cost in the native engine | no | no | **yes, median of repeated runs** |

`grep -r backtrack src/` in the upstream tree returns **zero** hits. The interpreter
there is explicitly described as aiming at "educational purposes" — it walks an
automaton, and an automaton never revisits a choice. The cost that makes a regexp a
denial-of-service risk is exactly the revisiting, so it needs a different machine.

## Install and run

```bash
npm install                 # installs dev dependencies
npm run build               # produces dist/
npx jest                    # 459 tests
```

Requires Node 16+. No runtime dependencies.

### CLI

Patterns may be written as literals (`/(a+)+b/`) or bare (`(a+)+b`). The bare form is
recommended in POSIX shells, which rewrite a leading slash into a filesystem path.

```bash
# Cost of one match attempt, theoretical and observed
npx backtrack-ledger ledger '(a+)+b' --anchor

# Build an attack string and fit the growth curve
npx backtrack-ledger attack '(a+)+b'

# Propose a rewrite, then search for a counterexample
npx backtrack-ledger rewrite '(a+)+b'

# Both
npx backtrack-ledger check '(a+)+b' --json
```

### API

```js
const regexpTree = require('backtrack-ledger');
const {ledger, attack, rewrite, exec} = regexpTree.backtrack;

ledger('/(a+)+b/', 'aaaaaaaaaaaaaaaa!', {maxSteps: 200000});
// -> {theoretical: {steps, backtracks, maxStack, truncated}, observed: {medianMs}, verdict}

attack('/(a+)+b/', {sizes: [4, 8, 12, 16]});
// -> {pump: 'a', suffix: 'c', points: [...], growth: {verdict: 'exponential', perChar: 2.01}}

rewrite('/(a+)+b/', {maxLength: 6});
// -> {candidates: [{rewritten: '/(a)+b/', verification: {tested: 3280, differences: []}, ...}]}
```

The upstream API is unchanged and still available: `parse`, `traverse`, `transform`,
`generate`, `optimize`, `compatTranspile`, `exec`, `fa`.

### Workbench

```bash
npm run demo:bundle
# open demo/index.html directly from disk — no server, no network
```

The page renders the growth curve on a log axis, the measurement table, the rewrite
candidate with its verification statement, and the native engine's median for the same
input. `?pattern=...&input=...` makes any case linkable and reproducible.

## How the numbers are produced

`src/backtrack/compiler.js` lowers the AST to a flat instruction sequence
(`CHAR`, `SPLIT`, `JMP`, `SAVE`, `ASSERT`, `MARK`, `PROGRESS`, `MATCH`).
`src/backtrack/vm.js` executes it with an **explicit stack**, not recursion.

- **steps** — one character-class or assertion decision. This is the quantity that
  grows exponentially in a catastrophic pattern.
- **backtracks** — one rewind to an earlier choice point.
- **maxStack** — deepest the choice stack grew.

A recursive-generator implementation was written first and discarded: it exhausted the
call stack at roughly 5,000 characters and took 11 seconds on a 1,000-character linear
pattern. The instruction machine runs the same inputs in 23 ms. The step counts are
identical between the two, which is how the rewrite was validated.

### Zero-width loops

`(a*)*` must terminate. The naive guard — record the offset on loop entry, exit when an
iteration fails to advance — is not enough: after a rewind past the loop entry, the
recorded offset is stale and the loop re-enters itself forever. The recorded offsets are
therefore part of the machine state and are saved and restored with each choice point.
`src/backtrack/__tests__/backtrack-test.js` pins four such shapes.

### Two measurements, deliberately separate

`steps` comes from the naive machine. `observed` comes from V8. They disagree, and that
disagreement is information: V8 returns from `/(a*)*b/` in about a millisecond because it
recognises the empty-loop shape, while the naive machine needs 2^n decisions. Reporting
only the step count would claim a disaster that does not happen on this engine; reporting
only the timer would hide the algorithmic shape that is fragile elsewhere. Both are
printed, and `divergence` flags a mismatch in the match verdict.

## Capability boundary

The engine refuses constructs it cannot reproduce exactly, rather than approximating them:

| Construct | Status |
|---|---|
| literals, character classes, ranges, negation | supported |
| `.`, `\d`, `\D`, `\w`, `\W`, `\s`, `\S` | supported |
| greedy, lazy, bounded and unbounded quantifiers | supported |
| groups (capturing and non-capturing) | supported |
| `^`, `$`, `\b`, `\B` | supported |
| `i`, `m`, `s`, `g`, `d` flags | supported |
| lookahead, lookbehind | **rejected** |
| backreferences | **rejected** |
| `\p{...}` unicode property escapes | **rejected** |
| `u`, `v` flags | **rejected** (code-point semantics differ) |
| `\cA` control escapes | **rejected** |

Rejection is a hard error with a located reason (`UnsupportedPatternError`), not a silent
fallback. Case-insensitive matching folds ASCII only; this is reported as a limitation
whenever the `i` flag is present.

## What the rewrite does and does not claim

One rule is implemented: collapse a quantifier whose body is itself a quantifier of the
same family. `(X+)+`, `(X+)*`, `(X*)+` and `(X*)*` all accept exactly the language of `X*`
(or `X+` when no star is involved), so the inner repetition is dropped. Measured effect on
`(a+)+b` across nine inputs: **27,803 steps before, 413 after** (67×), with the group
preserved.

Verification enumerates every string up to a bounded length over a small alphabet drawn
from the pattern plus one sentinel, and compares accept decisions. The result is always
reported as `complete: false` with the sentence *"This is a bounded check, not an
equivalence proof."* Regular-language equivalence is decidable, but implementing a
decision procedure is a different project, and a verifier that overstates its reach is
worse than no verifier.

Capture group *values* can differ after collapsing (`(a+)+` records one iteration, `(a)+`
records one character). The accepted language is preserved; the caveat is printed with
every candidate.

## Tests

```
Test Suites: 43 passed, 43 total
Tests:       459 passed, 459 total
```

- **398** are the upstream suite, untouched and passing — that is the no-regression gate.
- **61** are new. The largest block is differential: for 36 patterns × 18 inputs, the
  custom machine must agree with the native engine on accept/reject, match text and start
  index. Also covered: zero-width termination, growth classification, budget truncation,
  rewrite equivalence, and a **negative** case that feeds the verifier a deliberately
  broken rewrite and requires it to report a counterexample.

```bash
npx jest src/backtrack          # new tests only
node scripts/verify-demo.js     # headless DOM acceptance, 5 cases
node scripts/png-probe.js shots/demo.png   # screenshot statistics
```

## Upstream build defect (fixed here)

`npm run build` on Windows was a **silent no-op**: `scripts/build.js` invoked
`NODE_ENV=production "node_modules/.bin/babel"`, which `cmd.exe` parses as "run a command
named NODE_ENV". The script then printed `All done.` and exited **0** with no `dist/`
produced, so `index.js` threw `MODULE_NOT_FOUND` and the integration suite could not load.

Upstream issue [#134](https://github.com/DmitrySoshnikov/regexp-tree/issues/134) reported
this; PR [#138](https://github.com/DmitrySoshnikov/regexp-tree/pull/138) moved to
`shelljs` but noted in its own description that "the symlinks may fail when the command is
not run as an administrator". The environment-variable form remained.

This fork checks every build step's exit code, passes `NODE_ENV` through the child
environment, treats git-hook symlink failure as a warning, and fails loudly if
`dist/regexp-tree.js` is missing. Baseline and fix transcripts are in `docs/evidence/`.

## License and provenance

MIT. Upstream copyright (c) 2017 Dmitry Soshnikov is retained in `LICENSE`; this fork's
changes are described in `NOTICE`. The upstream README is preserved verbatim as
`README.upstream.md`. Commit history from upstream is preserved in this repository.

## Known limits

- Step counts describe a **naive** backtracking machine, not V8's optimised engine. They
  are comparable across inputs and patterns under this implementation; they are not a
  claim about instruction counts inside V8.
- The attack string is derived from one heuristic (innermost unbounded repetition plus a
  character that cannot complete the match). It finds the classic shapes; it is not a
  proof of worst-case input.
- Timeouts and stack limits truncate the curve. A truncated point is marked in every
  output; a truncated curve is not evidence of a bound.
- Bounded quantifiers are expanded inline; a bound above 20,000 instructions is refused.
- No `u`/`v` support means astral-plane patterns are out of scope.

---

中文摘要：本项目在 `regexp-tree`（MIT）之上新增一个**带账本的回溯虚拟机**，逐次统计
正则匹配时的字符判定数、回退次数与最大栈深，并自动构造攻击串、给出改写候选。与现有工具的
区别在于「测量」而非「判定」：既有工具报告"可能有风险"，这里报告"在这个输入上做了
393,180 次判定，每多一个字符翻 2.02 倍"。改写只做一条可证明保语言的规则，并用有界穷举
搜索反例，结果永远标注为「有限检查，不是等价证明」。

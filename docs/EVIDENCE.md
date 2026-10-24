# Evidence index

Every claim in the README points at something in this directory or at a command in
`package.json`. Raw transcripts are in `evidence/`; the numbers below were produced on
the machine described in "Environment".

## Environment

| Item | Value |
|---|---|
| OS | Windows 11 (win32) |
| Node | v22.22.2 |
| npm | 10.9.7 |
| Upstream commit | `cadffbd` (2026-10-22) |
| Upstream version | regexp-tree 0.1.27 |

## 1. Upstream baseline, before any change

`evidence/01-install.txt` — `npm install` succeeded, 716 packages.

`evidence/02-build-baseline.txt` — **the build reported success and produced nothing**:

```
[3/3] Transpiling JS code...
'NODE_ENV' is not recognized as an internal or external command
All done.
EXIT_CODE=0
ls: cannot access 'dist': No such file or directory
```

Two independent defects are visible in those four lines:

1. `NODE_ENV=production "node_modules/.bin/babel"` is POSIX shell syntax. `cmd.exe`
   parses it as a command named `NODE_ENV`.
2. `shell.exec` return codes were never checked, so the script printed `All done.` and
   exited **0** with no artifacts. A silent no-op is worse than a failure: CI stays green.

`evidence/03-test-baseline.txt` — 41 of 42 suites pass, 389 tests pass, and
`__tests__/integration-test.js` fails to load with
`Cannot find module './dist/regexp-tree'` — a direct consequence of the build defect.

## 2. After the build fix

`evidence/04-build-fixed.txt` — every step checks its exit code, `NODE_ENV` is passed
through the child environment, hook symlink failure is a warning. `dist/regexp-tree.js`
is produced.

`evidence/05-test-after-build.txt` — **42 suites, 398 tests, all passing.** The nine
integration tests that could not previously load now run.

## 3. Engine implementation: generator vs instruction machine

The first implementation used recursive generators. It was correct but unusable:

| Case | Recursive generators | Explicit-stack VM |
|---|---|---|
| `/(a+)+b/` on `a`×20 + `!` | 7,385 ms | 86 ms |
| `/a+b/` on `a`×1,000 + `!` | 11,067 ms | 23 ms |
| `/a+b/` on `a`×5,000 + `!` | `RangeError: Maximum call stack size exceeded` | 88 ms (budget-truncated) |

Step counts were identical in both implementations (1,516 / 6,120 / 24,548 / 98,272 /
393,180 for n = 8/10/12/14/16), which is what allowed the rewrite to be trusted.

## 4. Attack-string measurements

`node bin/backtrack-ledger attack '(a+)+b'`:

| n | steps | backtracks | stack |
|---|---|---|---|
| 4 | 84 | 52 | 4 |
| 8 | 1,516 | 1,004 | 8 |
| 12 | 24,548 | 16,356 | 12 |
| 16 | 393,180 | 262,108 | 16 |

Fitted growth: **2.02× per character**, classified `exponential`. Two controls:

- `/(a|aa)+b/` → 1.63× per character (Fibonacci growth) → `exponential`
- `/a+b/` → 1.11× per character, steps 9 → 17 → 25 → 33 → `linear`

## 5. Native engine comparison

`node bin/backtrack-ledger ledger '(a+)+b' <24 a's + '!'>`:

```
truncated    StepLimitExceeded
observed     median 92.1 ms, worst 1692.6 ms, 5 samples
```

The gap between median and worst on the same input is itself evidence for taking a
median instead of a single reading.

For a 12-character input the same pattern reports 24,548 theoretical steps but a native
median of 0.04 ms. V8 short-circuits this shape. The tool prints that explanation rather
than letting the two numbers contradict each other silently.

## 6. Rewrite verification

`node bin/backtrack-ledger rewrite '(a+)+b'`:

```
before    /(a+)+/
after     /(a)+b/
steps     27803 -> 413  (67.32x fewer)
check     No counterexample found among 3280 strings of length <= 7 over [a, b, !].
          This is a bounded check, not an equivalence proof.
```

The verifier is not a rubber stamp: `src/backtrack/__tests__/backtrack-test.js` feeds it
`/(a|ab)c/` against `/(a|ab)d/` and requires it to report differing accept decisions.

## 7. Workbench rendering

`node scripts/verify-demo.js` drives headless Edge with `?pattern=` and asserts on the
rendered region only — five cases, including an unsupported construct and a syntax error.

`node scripts/png-probe.js shots/demo.png` decodes the screenshot rather than trusting a
visual impression:

```
size        1200 x 2600
colors      560
accent      crimson=183
verdict     CONTENT
```

183 crimson pixels is the growth curve. A blank or half-rendered page cannot reach that
count with 560 distinct colours.

## Reproducing

```bash
npm install
npm run build
npx jest
npm run smoke
npm run demo:bundle
npm run verify:demo
```

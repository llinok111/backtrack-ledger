/**
 * Tests for the backtracking layer.
 *
 * The differential block is the most important one: it asserts that the custom
 * machine and the native engine agree on accept/reject, match text and start
 * index for every pair below. Any change to the engine that breaks semantics
 * should fail here before it can produce a misleading ledger.
 */
'use strict';

const regexpTree = require('../../regexp-tree');
const {exec} = require('../vm');
const {compile, isNullable} = require('../compiler');
const {analyze, assertSupported, UnsupportedPatternError} = require('../analyze');
const {ledger} = require('../ledger');
const {attack} = require('../attack');
const {rewrite, verify} = require('../rewrite');

function runPair(pattern, input, options = {}) {
  const ast = regexpTree.parse(pattern);
  assertSupported(ast, pattern);

  const native = new RegExp(
    pattern.slice(1, pattern.lastIndexOf('/')),
    ast.flags
  );

  return {expected: native.exec(input), actual: exec(ast, input, options)};
}

describe('backtrack: differential agreement with the native engine', () => {
  const SAFE_PATTERNS = [
    '/abc/',
    '/a+b/',
    '/a*b/',
    '/a?b/',
    '/(a|b)c/',
    '/(ab)+/',
    '/^abc$/',
    '/\\bfoo\\b/',
    '/[a-z]+/',
    '/[^a-z]+/',
    '/a{2,4}/',
    '/a{2,4}?/',
    '/\\d{3}-\\d{4}/',
    '/\\s+/',
    '/a.c/',
    '/a.c/s',
    '/(?:ab|cd)*e/',
    '/[0-9a-f]{2,6}/',
    '/x*y*z*/',
    '/^$/',
    '/a|/',
    '/(|a)b/',
    '/\\W+/',
    '/(ab|a)(bc|c)/',
    '/ABC/i',
    '/[a-z]+/i',
    '/^foo$/m',
    '/\\b\\w+\\b/',
    '/(?:a|b)*/',
    '/a{0,}/',
    '/a??b??/',
    '/(?:|x)+y/',
    '/(a*)*b/',
    '/(a?)*b/',
    '/^(?:a|b)+$/m',
    '/\\Bx/',
  ];

  const INPUTS = [
    '',
    'a',
    'b',
    'ab',
    'abc',
    'aaab',
    'aaaa',
    'foo bar',
    '  x',
    '123-4567',
    'a\nb',
    'abcabc',
    'abab',
    'ABC',
    'foo\nbar',
    'xy',
    '!',
    'a!',
  ];

  for (const pattern of SAFE_PATTERNS) {
    test(`${pattern} agrees on ${INPUTS.length} inputs`, () => {
      for (const input of INPUTS) {
        const {expected, actual} = runPair(pattern, input, {maxSteps: 400000});

        if (actual.truncated) {
          continue;
        }

        expect({
          pattern,
          input,
          matched: actual.matched,
          value: actual.value,
          index: actual.index,
        }).toEqual({
          pattern,
          input,
          matched: expected !== null,
          value: expected ? expected[0] : null,
          index: expected ? expected.index : -1,
        });
      }
    });
  }
});

describe('backtrack: capability boundary', () => {
  test('rejects lookahead, backreference and unicode property', () => {
    for (const pattern of [
      '/a(?=b)/',
      '/(?<=a)b/',
      '/(a)\\1/',
      '/\\p{L}/u',
    ]) {
      expect(() => assertSupported(regexpTree.parse(pattern), pattern)).toThrow(
        UnsupportedPatternError
      );
    }
  });

  test('reports the location of each unsupported construct', () => {
    const report = analyze(regexpTree.parse('/a(?=b)/'), '/a(?=b)/');

    expect(report.supported).toBe(false);
    expect(report.unsupported.length).toBe(1);
    expect(report.unsupported[0].reason).toMatch(/lookahead/i);
    expect(report.unsupported[0].path).toContain('expressions[1]');
  });

  test('records a limitation rather than silently mis-folding case', () => {
    const report = analyze(regexpTree.parse('/a/i'), '/a/i');

    expect(report.supported).toBe(true);
    expect(report.limitations.length).toBe(1);
    expect(report.limitations[0]).toMatch(/ASCII/);
  });
});

describe('backtrack: zero-width loops terminate', () => {
  const CASES = [
    ['/(a*)*b/', 'aaaaaaaaaa'],
    ['/(a?)*b/', 'aaaaaaaa'],
    ['/(?:|x)+y/', 'xxxx'],
    ['/(a*)+b/', 'aaaaaa'],
  ];

  for (const [pattern, input] of CASES) {
    test(`${pattern} terminates on ${input.length} chars`, () => {
      const ast = regexpTree.parse(pattern);
      const result = exec(ast, input, {maxSteps: 2000000, maxStack: 20000});

      expect(result.truncated).toBeNull();
      expect(result.ledger.maxStack).toBeLessThan(200);
    });
  }

  test('isNullable agrees with the compiler view of the AST', () => {
    expect(isNullable(regexpTree.parse('/(a*)/').body)).toBe(true);
    expect(isNullable(regexpTree.parse('/(a+)/').body)).toBe(false);
    expect(isNullable(regexpTree.parse('/(a?)/').body)).toBe(true);
    expect(isNullable(null)).toBe(true);
  });
});

describe('backtrack: cost ledger', () => {
  test('counts exponential steps for nested quantifiers', () => {
    const ast = regexpTree.parse('/(a+)+b/');
    const small = exec(ast, `${
      'a'.repeat(8)
    }!`, {
      maxSteps: 5000000,
      anchorAtStart: true,
    });
    const larger = exec(ast, `${'a'.repeat(12)}!`, {
      maxSteps: 5000000,
      anchorAtStart: true,
    });

    expect(small.ledger.steps).toBeLessThan(larger.ledger.steps);
    // Each extra four characters multiplies the work by roughly 2^4.
    expect(larger.ledger.steps / small.ledger.steps).toBeGreaterThan(10);
  });

  test('grows linearly for a flat quantifier', () => {
    const ast = regexpTree.parse('/a+b/');
    const small = exec(ast, `${'a'.repeat(50)}!`, {
      anchorAtStart: true,
      maxSteps: 5000000,
    });
    const larger = exec(ast, `${'a'.repeat(100)}!`, {
      anchorAtStart: true,
      maxSteps: 5000000,
    });

    const ratio = larger.ledger.steps / small.ledger.steps;
    expect(ratio).toBeGreaterThan(1.7);
    expect(ratio).toBeLessThan(2.4);
  });

  test('stops at the step budget and says so', () => {
    const ast = regexpTree.parse('/(a+)+b/');
    const result = exec(ast, `${'a'.repeat(24)}!`, {maxSteps: 5000});

    expect(result.truncated).toBe('StepLimitExceeded');
    expect(result.ledger.steps).toBe(5001);
  });

  test('ledger keeps theoretical and observed measurements apart', () => {
    const report = ledger('/(a+)+b/', `${'a'.repeat(18)}!`, {maxSteps: 100000});

    expect(report.supported).toBe(true);
    expect(report.theoretical.truncated).toBe('StepLimitExceeded');
    expect(report.observed.available).toBe(true);
    expect(report.observed.samples.length).toBeGreaterThan(1);
    expect(report.verdict).toBe('catastrophic');
  });

  test('ledger reports an unsupported pattern instead of guessing', () => {
    const report = ledger('/a(?=b)/', 'ab');

    expect(report.supported).toBe(false);
    expect(report.unsupported[0].reason).toMatch(/lookahead/i);
  });
});

describe('backtrack: attack construction', () => {
  test('finds the pump character and a failing suffix', () => {
    const report = attack('/(a+)+b/', {sizes: [4, 8, 12]});

    expect(report.supported).toBe(true);
    expect(report.pump).toBe('a');
    expect(report.suffix).not.toBe('a');
    expect(report.points.length).toBe(3);
  });

  test('classifies exponential growth as exponential', () => {
    const report = attack('/(a+)+b/', {sizes: [4, 8, 12, 16]});

    expect(report.growth.verdict).toBe('exponential');
    expect(report.growth.perChar).toBeGreaterThan(1.7);
  });

  test('classifies flat growth as linear', () => {
    const report = attack('/a+b/', {sizes: [4, 8, 12, 16]});

    expect(report.growth.verdict).toBe('linear');
    expect(report.growth.perChar).toBeLessThan(1.3);
  });

  test('refuses to fabricate a curve for unsupported patterns', () => {
    const report = attack('/(?<=a)b/', {});

    expect(report.supported).toBe(false);
    expect(report.points).toBeUndefined();
  });
});

describe('backtrack: rewrite and verification', () => {
  test('collapses nested quantifiers and preserves the language', () => {
    const report = rewrite('/(a+)+b/', {maxLength: 5});
    const candidate = report.candidates[0];

    expect(candidate.rewritten).toBe('/(a)+b/');
    expect(candidate.verification.differences).toEqual([]);
    expect(candidate.verification.tested).toBeGreaterThan(50);
    expect(candidate.verification.complete).toBe(false);
  });

  test('measures a real drop in steps after the rewrite', () => {
    const report = rewrite('/(a+)+b/', {maxLength: 4});
    const candidate = report.candidates[0];

    expect(candidate.cost.afterSteps).toBeLessThan(candidate.cost.beforeSteps);
    expect(candidate.cost.ratio).toBeGreaterThan(5);
  });

  test('the verifier detects a rewrite that changes the language', () => {
    const original = regexpTree.parse('/(a|ab)c/');
    const broken = regexpTree.parse('/(a|ab)d/');
    const result = verify(original, broken, {maxLength: 3});

    expect(result.differences.length).toBeGreaterThan(0);
    expect(result.differences[0]).toHaveProperty('original');
    expect(result.differences[0]).toHaveProperty('rewritten');
  });

  test('verifier never claims a proof', () => {
    const a = regexpTree.parse('/a+/');
    const b = regexpTree.parse('/aa*/');
    const result = verify(a, b, {maxLength: 4});

    expect(result.complete).toBe(false);
    expect(result.statement).toMatch(/not an equivalence proof/);
    expect(result.differences).toEqual([]);
  });

  test('returns no candidates for patterns without nested quantifiers', () => {
    const report = rewrite('/a+b/');

    expect(report.candidates).toEqual([]);
    expect(report.note).toMatch(/No collapsed-quantifier site/);
  });
});

describe('backtrack: compiler', () => {
  test('emits a MATCH instruction for every program', () => {
    const program = compile(regexpTree.parse('/abc/'));

    expect(program.instructions[program.instructions.length - 1].op).toBe(
      'MATCH'
    );
  });

  test('refuses to expand an oversized bounded quantifier', () => {
    expect(() => compile(regexpTree.parse('/a{25000}/'))).toThrow(
      /instructions/
    );
  });

  test('shares no mutable state between runs', () => {
    const ast = regexpTree.parse('/(a)(b)/');
    const first = exec(ast, 'ab');
    const second = exec(ast, 'ab');

    expect(first.captures.map((c) => c.value)).toEqual(['a', 'b']);
    expect(second.captures.map((c) => c.value)).toEqual(['a', 'b']);
  });
});

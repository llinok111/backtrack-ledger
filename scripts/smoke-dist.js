#!/usr/bin/env node
/**
 * Release-artifact smoke test.
 *
 * The jest suite runs against `src/`. The published entry point is `dist/`,
 * which is babel-transpiled, and transpilation changes behaviour in ways source
 * tests cannot see: `instanceof` against a built-in subclass stops matching, and
 * generators need a runtime that is not installed. Both bugs were found here, not
 * in jest.
 *
 * Run this after `npm run build`, before packaging.
 *
 * The MIT License (MIT)
 * Copyright (c) 2017-present Dmitry Soshnikov <dmitry.soshnikov@gmail.com>
 */

'use strict';

const assert = require('assert');

let regexpTree;

try {
  regexpTree = require('../dist/regexp-tree');
} catch (error) {
  console.error('Cannot load dist/regexp-tree. Run `npm run build` first.');
  console.error(error.message);
  process.exit(1);
}

const {backtrack} = regexpTree;
const checks = [];

function check(name, fn) {
  try {
    fn();
    checks.push({name, ok: true});
  } catch (error) {
    checks.push({name, ok: false, error: error.message});
  }
}

check('upstream parse still works', () => {
  const ast = regexpTree.parse('/(a+)+b/');
  assert.strictEqual(ast.type, 'RegExp');
  assert.strictEqual(regexpTree.generate(ast), '/(a+)+b/');
});

check('upstream fa interpreter still works', () => {
  assert.strictEqual(regexpTree.fa.test(/ab|c*/, 'ab'), true);
});

check('backtrack is exported additively', () => {
  for (const key of ['exec', 'ledger', 'attack', 'rewrite', 'analyze', 'compile']) {
    assert.strictEqual(typeof backtrack[key], 'function', `missing ${key}`);
  }
});

check('budget exhaustion returns a truncated ledger instead of throwing', () => {
  // This is the exact path that threw before the error-code fix: babel's class
  // transform broke `instanceof` against the Error subclass.
  const result = backtrack.exec(regexpTree.parse('/(a+)+b/'), `${'a'.repeat(30)}!`, {
    maxSteps: 5000,
  });

  assert.strictEqual(result.truncated, 'StepLimitExceeded');
  assert.ok(result.ledger.steps > 0);
});

check('no-regression: behaviour matches native on a fixed corpus', () => {
  const cases = [
    ['/a+b/', 'aaab'],
    ['/(a|b)c/', 'bc'],
    ['/\\d{3}-\\d{4}/', '555-1234'],
    ['/(a*)*b/', 'aaa'],
    ['/^foo$/m', 'x\nfoo'],
  ];

  for (const [pattern, input] of cases) {
    const ast = regexpTree.parse(pattern);
    const native = new RegExp(pattern.slice(1, pattern.lastIndexOf('/')), ast.flags);
    const expected = native.exec(input);
    const actual = backtrack.exec(ast, input);

    assert.strictEqual(
      actual.matched,
      expected !== null,
      `${pattern} on ${JSON.stringify(input)}`
    );

    if (expected) {
      assert.strictEqual(actual.value, expected[0]);
      assert.strictEqual(actual.index, expected.index);
    }
  }
});

check('attack classifies exponential growth', () => {
  const report = backtrack.attack('/(a+)+b/', {sizes: [4, 8, 12]});
  assert.strictEqual(report.supported, true);
  assert.strictEqual(report.growth.verdict, 'exponential');
  assert.ok(report.points[2].steps > report.points[0].steps);
});

check('rewrite produces a verified candidate', () => {
  const report = backtrack.rewrite('/(a+)+b/', {maxLength: 4});
  assert.strictEqual(report.candidates.length, 1);
  assert.strictEqual(report.candidates[0].verification.differences.length, 0);
  assert.strictEqual(report.candidates[0].verification.complete, false);
});

check('unsupported constructs are refused, not approximated', () => {
  const report = backtrack.ledger('/a(?=b)/', 'ab');
  assert.strictEqual(report.supported, false);
  assert.ok(report.unsupported.length > 0);
});

console.log('');
for (const result of checks) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
  if (!result.ok) {
    console.log(`      ${result.error}`);
  }
}

const failed = checks.filter((result) => !result.ok).length;
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);

if (failed > 0) {
  process.exitCode = 1;
}

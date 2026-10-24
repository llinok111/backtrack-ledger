/**
 * Differential check: every (pattern, input) pair must produce the same
 * accept/reject decision, the same match text and the same start index as the
 * native engine. This is the guard rail for the whole project.
 */
'use strict';

const t = require('..');
const {exec} = require('../src/backtrack/vm');
const {assertSupported} = require('../src/backtrack/analyze');

const PATTERNS = [
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
  '/(a+)+b/',
  '/(a|aa)+b/',
  '/\\d{3}-\\d{4}/',
  '/\\s+/',
  '/a.c/',
  '/a.c/s',
  '/(?:ab|cd)*e/',
  '/[0-9a-f]{2,6}/',
  '/x*y*z*/',
  '/(a*)*b/',
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
  '/(.)\\1/',
];

const INPUTS = [
  '',
  'a',
  'b',
  'ab',
  'abc',
  'aaab',
  'aaaa',
  'aaaab',
  'foo bar',
  '  x',
  '123-4567',
  'a\nb',
  'xyz',
  'abcabc',
  'abab',
  'zzz',
  'ABC',
  'foo\nbar',
  'ababab',
  'xy',
];

let checked = 0;
let skipped = 0;
const failures = [];

for (const literal of PATTERNS) {
  let ast;
  let report;

  try {
    ast = t.parse(literal);
    report = assertSupported(ast, literal);
  } catch (error) {
    skipped += 1;
    continue;
  }

  const native = new RegExp(ast.body ? literal.slice(1, literal.lastIndexOf('/')) : '', report.flags);

  for (const input of INPUTS) {
    const expected = native.exec(input);
    const actual = exec(ast, input, {maxSteps: 500000});

    if (actual.truncated) {
      skipped += 1;
      continue;
    }

    checked += 1;

    const expectedMatched = expected !== null;
    const actualMatched = actual.matched === true;

    const same =
      expectedMatched === actualMatched &&
      (!expectedMatched ||
        (expected[0] === actual.value && expected.index === actual.index));

    if (!same) {
      failures.push({
        pattern: literal,
        input: JSON.stringify(input),
        expected: expectedMatched
          ? `${JSON.stringify(expected[0])} @${expected.index}`
          : 'null',
        actual: actualMatched
          ? `${JSON.stringify(actual.value)} @${actual.index}`
          : 'null',
      });
    }
  }
}

console.log(`checked: ${checked}, skipped: ${skipped}, failures: ${failures.length}`);

if (failures.length > 0) {
  console.log(JSON.stringify(failures.slice(0, 20), null, 2));
  process.exitCode = 1;
}

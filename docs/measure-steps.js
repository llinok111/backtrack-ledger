'use strict';

const t = require('..');
const {exec} = require('../src/backtrack/vm');

function measure(pattern, input, maxSteps = 5000000) {
  const ast = t.parse(pattern);
  const started = process.hrtime.bigint();
  const result = exec(ast, input, {maxSteps});
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

  return {
    steps: result.ledger.steps,
    backtracks: result.ledger.backtracks,
    maxStack: result.ledger.maxStack,
    truncated: result.truncated,
    matched: result.matched,
    ms: Number(elapsed.toFixed(1)),
  };
}

console.log('=== /(a+)+b/ on "a"*n + "!" ===');
for (const n of [8, 10, 12, 14, 16, 18, 20]) {
  const input = 'a'.repeat(n) + '!';
  const m = measure('/(a+)+b/', input);
  console.log(`n=${String(n).padStart(2)}  steps=${String(m.steps).padStart(9)}  backtracks=${String(m.backtracks).padStart(9)}  stack=${m.maxStack}  ${m.ms}ms`);
}

console.log('\n=== /(a|aa)+b/ on "a"*n + "!" ===');
for (const n of [8, 10, 12, 14, 16, 18]) {
  const input = 'a'.repeat(n) + '!';
  const m = measure('/(a|aa)+b/', input);
  console.log(`n=${String(n).padStart(2)}  steps=${String(m.steps).padStart(9)}  ${m.ms}ms`);
}

console.log('\n=== linear control: /a+b/ on "a"*n + "!" ===');
for (const n of [100, 1000, 5000]) {
  const input = 'a'.repeat(n) + '!';
  const m = measure('/a+b/', input);
  console.log(`n=${String(n).padStart(4)}  steps=${String(m.steps).padStart(9)}  ${m.ms}ms`);
}

console.log('\n=== native timing for comparison ===');
for (const n of [20, 24, 26]) {
  const input = 'a'.repeat(n) + '!';
  const re = /(a+)+b/;
  const started = process.hrtime.bigint();
  re.exec(input);
  console.log(`native n=${n}  ${(Number(process.hrtime.bigint() - started) / 1e6).toFixed(1)}ms`);
}

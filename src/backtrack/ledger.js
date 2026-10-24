/**
 * The ledger: one regexp, one input, two independent measurements.
 *
 * `theoretical` comes from the backtracking VM and counts decisions the way a
 * naive recursive-descent engine would make them. `observed` comes from the
 * native engine and reports wall-clock time.
 *
 * The two are deliberately kept separate because they disagree. V8 recognises
 * some empty-loop shapes and returns from `/(a*)*b/` in about a millisecond,
 * while the naive machine needs 2^n decisions. Reporting only the step count
 * would claim a disaster that does not happen; reporting only the timer would
 * hide the algorithmic shape that makes the pattern fragile on another engine
 * or another input. When they diverge, `divergence` says so explicitly.
 *
 * The MIT License (MIT)
 * Copyright (c) 2017-present Dmitry Soshnikov <dmitry.soshnikov@gmail.com>
 */

'use strict';

const {exec} = require('./vm');
const {now} = require('./clock');
const {analyze} = require('./analyze');

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Times the native engine on the same input.
 *
 * A single timing is noise: the same call can differ by an order of magnitude
 * between runs. Repeating and taking the median is the cheapest way to get a
 * number worth printing. `samples` is reported so the reader can judge it.
 */
function measureNative(ast, pattern, input, {runs = 5, timeoutMs = 2000} = {}) {
  let native;

  try {
    native = new RegExp(
      pattern.slice(1, pattern.lastIndexOf('/')),
      ast.flags || ''
    );
  } catch (error) {
    return {available: false, reason: error.message, samples: []};
  }

  const samples = [];
  let matched = null;
  let index = -1;
  let value = null;

  for (let i = 0; i < runs; i += 1) {
    const started = now();
    const result = native.exec(input);
    const elapsed = now() - started;

    samples.push(elapsed);

    if (i === 0) {
      matched = result !== null;
      index = result ? result.index : -1;
      value = result ? result[0] : null;
    }

    if (elapsed > timeoutMs) {
      break;
    }
  }

  return {
    available: true,
    samples,
    medianMs: Number(median(samples).toFixed(4)),
    worstMs: Number(Math.max(...samples).toFixed(4)),
    matched,
    index,
    value,
  };
}

/**
 * Derives a coarse verdict from the step count relative to input length.
 *
 * Thresholds are expressed as decisions per input character so that they do not
 * silently depend on the absolute size of the sample.
 */
function classify(theoretical, length) {
  if (theoretical.truncated) {
    return 'unbounded';
  }

  if (length === 0) {
    return theoretical.steps > 100 ? 'overhead-dominated' : 'negligible';
  }

  const perChar = theoretical.steps / length;

  if (perChar < 10) {
    return 'linear';
  }

  if (perChar < 1000) {
    return 'superlinear';
  }

  return 'catastrophic';
}

function ledger(pattern, input, options = {}) {
  const regexpTree = require('../regexp-tree');
  const ast = regexpTree.parse(pattern);
  const report = analyze(ast, pattern);

  if (!report.supported) {
    return {
      pattern,
      input,
      supported: false,
      unsupported: report.unsupported,
      limitations: report.limitations,
    };
  }

  const theoretical = exec(ast, input, {
    maxSteps: options.maxSteps,
    maxStack: options.maxStack,
    anchorAtStart: options.anchorAtStart,
  });

  const observed = measureNative(ast, pattern, input, {
    runs: options.runs,
    timeoutMs: options.timeoutMs,
  });

  const divergent =
    observed.available &&
    observed.matched !== null &&
    theoretical.matched !== null &&
    observed.matched !== theoretical.matched;

  // A high step count next to a sub-millisecond native median is not a
  // contradiction, it is an optimisation. Saying so prevents a reader from
  // concluding either that the tool is wrong or that the pattern is an emergency.
  let engineNote = null;

  if (
    observed.available &&
    theoretical.ledger.steps > 1000 &&
    observed.medianMs < 1
  ) {
    engineNote =
      'The naive machine needs many decisions here, but the native engine ' +
      'answered in under a millisecond. That points to an engine-level ' +
      'short-circuit for this shape, not to a cheap pattern in general.';
  }

  return {
    pattern,
    input,
    supported: true,
    unsupported: [],
    limitations: report.limitations,
    starHeight: report.starHeight,
    theoretical: {
      matched: theoretical.matched,
      index: theoretical.index,
      value: theoretical.value,
      steps: theoretical.ledger.steps,
      backtracks: theoretical.ledger.backtracks,
      maxStack: theoretical.ledger.maxStack,
      truncated: theoretical.truncated,
    },
    observed,
    verdict: classify(theoretical.ledger, input.length),
    divergence: divergent
      ? 'The native engine and the naive machine disagree on whether this input ' +
        'matches. Treat the step count as indicative only.'
      : null,
    engineNote,
  };
}

module.exports = {ledger, measureNative, median, classify};

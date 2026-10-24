/**
 * Attack-string construction.
 *
 * A ReDoS report is only actionable if it names the input that hurts. This
 * module derives one from the AST instead of asking the reader to invent it:
 * pick a character the repeated group can consume, repeat it, then append a
 * character that cannot complete the match. That is the classic `a^n !` shape.
 *
 * The growth verdict comes from measured points, not from a static rule. If the
 * curve is flat, the report says flat.
 *
 * The MIT License (MIT)
 * Copyright (c) 2017-present Dmitry Soshnikov <dmitry.soshnikov@gmail.com>
 */

'use strict';

const {exec} = require('./vm');
const {now} = require('./clock');
const {analyze} = require('./analyze');

const PRINTABLE = 'abcdefghijklmnopqrstuvwxyz0123456789 _-.!?#@%&*+=/,:;'.split('');

function walk(node, visit) {
  if (!node) {
    return;
  }

  visit(node);

  switch (node.type) {
    case 'RegExp':
      walk(node.body, visit);
      break;
    case 'Alternative':
      node.expressions.forEach((expression) => walk(expression, visit));
      break;
    case 'Disjunction':
      walk(node.left, visit);
      walk(node.right, visit);
      break;
    case 'Group':
    case 'Repetition':
      walk(node.expression, visit);
      break;
    case 'CharacterClass':
      node.expressions.forEach((expression) => walk(expression, visit));
      break;
    case 'ClassRange':
      walk(node.from, visit);
      walk(node.to, visit);
      break;
    default:
      break;
  }
}

/**
 * Characters a node can consume, sampled rather than enumerated.
 *
 * For ranges only the endpoints and a midpoint are taken. Enumerating `[a-z]`
 * would be cheap, but enumerating a negative class is not, and the pump only
 * needs one character that the group accepts.
 */
function consumedChars(node, out) {
  if (!node) {
    return out;
  }

  if (node.type === 'Char') {
    if (node.symbol != null) {
      out.add(node.symbol);
    } else if (node.codePoint != null) {
      out.add(String.fromCharCode(node.codePoint));
    }
    return out;
  }

  if (node.type === 'CharacterClass' && !node.negative) {
    for (const expression of node.expressions) {
      if (expression.type === 'ClassRange') {
        const from = expression.from.codePoint;
        const to = expression.to.codePoint;
        out.add(String.fromCharCode(from));
        out.add(String.fromCharCode(to));
        out.add(String.fromCharCode(Math.floor((from + to) / 2)));
      } else if (expression.symbol != null) {
        out.add(expression.symbol);
      }
    }
    return out;
  }

  // The pump often sits inside a group inside a repetition; descend instead of
  // returning an empty set that silently falls back to "first literal".
  switch (node.type) {
    case 'Repetition':
    case 'Group':
      consumedChars(node.expression, out);
      break;
    case 'Alternative':
      for (const expression of node.expressions) {
        consumedChars(expression, out);
      }
      break;
    case 'Disjunction':
      consumedChars(node.left, out);
      consumedChars(node.right, out);
      break;
    default:
      break;
  }

  return out;
}

function collectRepetitions(node, out) {
  if (!node) {
    return out;
  }

  if (node.type === 'Repetition') {
    const unbounded =
      node.quantifier.kind === '*' ||
      node.quantifier.kind === '+' ||
      node.quantifier.to == null;

    if (unbounded) {
      out.push(node);
    }
  }

  switch (node.type) {
    case 'RegExp':
      collectRepetitions(node.body, out);
      break;
    case 'Alternative':
      node.expressions.forEach((expression) =>
        collectRepetitions(expression, out)
      );
      break;
    case 'Disjunction':
      collectRepetitions(node.left, out);
      collectRepetitions(node.right, out);
      break;
    case 'Group':
    case 'Repetition':
      collectRepetitions(node.expression, out);
      break;
    default:
      break;
  }

  return out;
}

/**
 * Chooses the pump character.
 *
 * Preference order: the innermost unbounded repetition (that is where nesting
 * multiplies), then any repetition, then any literal in the pattern.
 */
function choosePump(ast) {
  const repetitions = collectRepetitions(ast, []);

  if (repetitions.length > 0) {
    const innermost = repetitions[repetitions.length - 1];
    const chars = Array.from(consumedChars(innermost, new Set()));

    if (chars.length > 0) {
      return {char: chars[0], source: 'innermost unbounded repetition'};
    }
  }

  const literals = new Set();
  walk(ast, (node) => {
    if (node.type === 'Char' && node.symbol != null) {
      literals.add(node.symbol);
    }
  });

  const fallback = Array.from(literals)[0];

  return fallback
    ? {char: fallback, source: 'first literal in pattern'}
    : {char: 'a', source: 'default'};
}

function chooseSuffix(ast, pump) {
  const used = new Set();
  walk(ast, (node) => {
    if (node.type === 'Char' && node.symbol != null) {
      used.add(node.symbol);
    }
  });

  for (const candidate of PRINTABLE) {
    if (candidate !== pump && !used.has(candidate)) {
      return candidate;
    }
  }

  return '\u0001';
}

/**
 * Fits a growth class from measured points.
 *
 * A power-law fit is the wrong model here: exponential curves do not have a
 * stable exponent, and `log(steps)` versus `n` does. The slope of that line is
 * `ln(factor per character)`, which converts back into a plain multiplier a
 * reader can check by hand.
 */
function classifyGrowth(points) {
  const usable = points.filter((point) => !point.truncated && point.steps > 0);

  if (usable.length < 2) {
    return {
      verdict: 'undetermined',
      slope: null,
      perChar: null,
      note: 'Not enough untruncated points to fit a curve.',
    };
  }

  const ns = usable.map((point) => point.n);
  const logs = usable.map((point) => Math.log(point.steps));
  const meanN = ns.reduce((a, b) => a + b, 0) / ns.length;
  const meanLog = logs.reduce((a, b) => a + b, 0) / logs.length;

  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < ns.length; i += 1) {
    numerator += (ns[i] - meanN) * (logs[i] - meanLog);
    denominator += (ns[i] - meanN) ** 2;
  }

  const slope = denominator === 0 ? 0 : numerator / denominator;
  const perChar = Number(Math.exp(slope).toFixed(2));

  let verdict = 'linear';

  if (slope >= 0.4) {
    verdict = 'exponential';
  } else if (slope >= 0.12) {
    verdict = 'polynomial';
  } else if (slope < 0.02) {
    verdict = 'constant';
  }

  return {
    verdict,
    slope: Number(slope.toFixed(3)),
    perChar,
    note:
      `Each extra character multiplies the step count by about ` +
      `${perChar}x across n=${usable[0].n}..${usable[usable.length - 1].n}.`,
  };
}

/**
 * Builds and measures an attack string for `pattern`.
 */
function attack(pattern, options = {}) {
  const regexpTree = require('../regexp-tree');
  const ast = regexpTree.parse(pattern);
  const report = analyze(ast, pattern);

  if (!report.supported) {
    return {pattern, supported: false, unsupported: report.unsupported};
  }

  const pump = choosePump(ast);
  const suffix = chooseSuffix(ast, pump.char);

  const sizes = options.sizes || [4, 8, 12, 16, 20, 24];
  const maxSteps = options.maxSteps == null ? 2000000 : options.maxSteps;

  const points = sizes.map((n) => {
    const input = pump.char.repeat(n) + suffix;
    const started = now();
    const result = exec(ast, input, {
      maxSteps,
      anchorAtStart: options.anchorAtStart !== false,
    });
    const elapsed = now() - started;

    return {
      n,
      input,
      steps: result.ledger.steps,
      backtracks: result.ledger.backtracks,
      maxStack: result.ledger.maxStack,
      truncated: result.truncated,
      ms: Number(elapsed.toFixed(2)),
    };
  });

  const growth = classifyGrowth(points);
  const worst = points.reduce(
    (current, point) => (point.steps > current.steps ? point : current),
    points[0]
  );

  return {
    pattern,
    supported: true,
    pump: pump.char,
    pumpSource: pump.source,
    suffix,
    points,
    growth,
    worst,
    starHeight: report.starHeight,
  };
}

module.exports = {attack, classifyGrowth, choosePump, chooseSuffix};

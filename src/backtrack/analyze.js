/**
 * Capability analysis for a parsed RegExp AST.
 *
 * The engine deliberately refuses constructs it cannot reproduce with exact
 * semantics. A wrong answer about whether a regex is safe is worse than no
 * answer, so anything outside the supported subset is reported as a hard,
 * located limitation rather than silently approximated.
 *
 * The MIT License (MIT)
 * Copyright (c) 2017-present Dmitry Soshnikov <dmitry.soshnikov@gmail.com>
 */

'use strict';

const SUPPORTED_META = new Set([
  '\\d',
  '\\D',
  '\\w',
  '\\W',
  '\\s',
  '\\S',
  '.',
]);

/**
 * Flags whose semantics this engine reproduces exactly.
 *
 * `u` and `v` switch matching to code points, which changes how values are
 * compared and how `.` behaves. `d` only adds match indices and is harmless.
 */
const SUPPORTED_FLAGS = new Set(['g', 'i', 'm', 's', 'd']);

class UnsupportedPatternError extends Error {
  constructor(pattern, issues) {
    const list = issues
      .map((issue) => `  - ${issue.reason} at ${issue.path}`)
      .join('\n');

    super(
      `Cannot analyse ${pattern}: ${issues.length} construct(s) outside the ` +
        `supported subset.\n${list}`
    );

    this.name = 'UnsupportedPatternError';
    this.pattern = pattern;
    this.issues = issues;
  }
}

function walk(node, path, visit) {
  if (!node) {
    return;
  }

  visit(node, path);

  switch (node.type) {
    case 'RegExp':
      walk(node.body, `${path}.body`, visit);
      break;
    case 'Alternative':
      node.expressions.forEach((expression, index) =>
        walk(expression, `${path}.expressions[${index}]`, visit)
      );
      break;
    case 'Disjunction':
      walk(node.left, `${path}.left`, visit);
      walk(node.right, `${path}.right`, visit);
      break;
    case 'Group':
      walk(node.expression, `${path}.expression`, visit);
      break;
    case 'Repetition':
      walk(node.expression, `${path}.expression`, visit);
      break;
    case 'Assertion':
      if (node.assertion) {
        walk(node.assertion, `${path}.assertion`, visit);
      }
      break;
    case 'CharacterClass':
      node.expressions.forEach((expression, index) =>
        walk(expression, `${path}.expressions[${index}]`, visit)
      );
      break;
    case 'ClassRange':
      walk(node.from, `${path}.from`, visit);
      walk(node.to, `${path}.to`, visit);
      break;
    default:
      break;
  }
}

function collectLiteral(node, alphabet) {
  if (node.type === 'Char' && node.kind !== 'meta') {
    if (node.symbol != null) {
      alphabet.add(node.symbol);
    } else if (node.codePoint != null) {
      alphabet.add(String.fromCharCode(node.codePoint));
    }
  }

  if (node.type === 'ClassRange') {
    // Only the endpoints are sampled: enumerating a wide range would produce an
    // alphabet too large to exhaust, and endpoints cover the boundary cases.
    if (node.from.symbol != null) {
      alphabet.add(node.from.symbol);
    }
    if (node.to.symbol != null) {
      alphabet.add(node.to.symbol);
    }
  }
}

/**
 * Longest chain of nested quantifiers, the structural signal behind
 * exponential backtracking.
 */
function starHeight(node, depth = 0) {
  if (!node) {
    return depth;
  }

  switch (node.type) {
    case 'RegExp':
      return starHeight(node.body, depth);
    case 'Alternative':
      return node.expressions.reduce(
        (max, expression) => Math.max(max, starHeight(expression, depth)),
        depth
      );
    case 'Disjunction':
      return Math.max(
        starHeight(node.left, depth),
        starHeight(node.right, depth)
      );
    case 'Group':
      return starHeight(node.expression, depth);
    case 'Repetition': {
      const bounded = node.quantifier.kind === '?';
      const next = bounded ? depth : depth + 1;
      return Math.max(next, starHeight(node.expression, next));
    }
    default:
      return depth;
  }
}

/**
 * Inspects an AST and returns what the engine can and cannot do with it.
 */
function analyze(ast, pattern = '') {
  const unsupported = [];
  const limitations = [];
  const alphabet = new Set();

  const flags = ast.flags || '';
  for (const flag of flags) {
    if (!SUPPORTED_FLAGS.has(flag)) {
      unsupported.push({
        reason: `flag "${flag}" changes matching to code points`,
        path: 'flags',
      });
    }
  }

  if (flags.includes('i')) {
    limitations.push(
      'Case-insensitive matching folds ASCII only; non-ASCII case pairs are ' +
        'not folded.'
    );
  }

  walk(ast, 'regexp', (node, path) => {
    switch (node.type) {
      case 'Assertion':
        if (node.kind === 'Lookahead' || node.kind === 'Lookbehind') {
          unsupported.push({
            reason: `${node.kind.toLowerCase()} assertion`,
            path,
          });
        }
        break;
      case 'Backreference':
        unsupported.push({reason: 'backreference', path});
        break;
      case 'UnicodeProperty':
        unsupported.push({reason: 'unicode property escape', path});
        break;
      case 'Char':
        if (node.kind === 'control') {
          unsupported.push({
            reason: 'control-character escape without a resolved code point',
            path,
          });
        } else if (node.kind === 'meta' && !SUPPORTED_META.has(node.value)) {
          unsupported.push({
            reason: `meta character ${node.value}`,
            path,
          });
        }
        break;
      default:
        break;
    }

    collectLiteral(node, alphabet);
  });

  return {
    supported: unsupported.length === 0,
    unsupported,
    limitations,
    alphabet: Array.from(alphabet).sort(),
    starHeight: starHeight(ast),
    flags,
  };
}

function assertSupported(ast, pattern) {
  const report = analyze(ast, pattern);

  if (!report.supported) {
    throw new UnsupportedPatternError(pattern, report.unsupported);
  }

  return report;
}

module.exports = {
  analyze,
  assertSupported,
  starHeight,
  UnsupportedPatternError,
};

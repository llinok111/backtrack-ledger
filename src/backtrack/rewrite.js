/**
 * Rewrite candidates and a bounded equivalence check.
 *
 * The rewrite rule implemented here is deliberately narrow: collapse a
 * quantifier whose body is itself a quantifier of the same family. `(X+)+`,
 * `(X+)*`, `(X*)+` and `(X*)*` all accept exactly the language of `X*` (or
 * `X+` when no star is involved), because repeating a repetition adds no words
 * that one repetition cannot produce.
 *
 * Everything else is left alone. Rewrites that look safe but change the
 * language are worse than no rewrite, and the verifier below exists to catch
 * exactly that mistake rather than to bless it.
 *
 * The MIT License (MIT)
 * Copyright (c) 2017-present Dmitry Soshnikov <dmitry.soshnikov@gmail.com>
 */

'use strict';

const {exec} = require('./vm');
const {analyze} = require('./analyze');

const MAX_ALPHABET = 4;
const DEFAULT_MAX_LENGTH = 7;

function clone(node) {
  return JSON.parse(JSON.stringify(node));
}

function quantifierFamily(kind) {
  if (kind === '*' || kind === '+') {
    return 'star';
  }

  if (kind === '?') {
    return 'optional';
  }

  return 'range';
}

/**
 * Finds `(X+)+` shaped nodes: an unbounded repetition wrapped around a group
 * that is itself an unbounded repetition.
 *
 * The site keeps a direct reference to the parent container and the key inside
 * it. Rebuilding a dotted path string and parsing it back is an easy place to
 * lose a segment, and a wrong path silently rewrites the wrong node.
 */
function findCollapsible(node, parent, key, out) {
  if (!node) {
    return out;
  }

  if (
    node.type === 'Repetition' &&
    quantifierFamily(node.quantifier.kind) === 'star' &&
    node.expression.type === 'Group' &&
    node.expression.expression.type === 'Repetition' &&
    quantifierFamily(node.expression.expression.quantifier.kind) === 'star'
  ) {
    out.push({node, parent, key});
  }

  switch (node.type) {
    case 'RegExp':
      findCollapsible(node.body, node, 'body', out);
      break;
    case 'Alternative':
      node.expressions.forEach((expression, index) =>
        findCollapsible(expression, node.expressions, index, out)
      );
      break;
    case 'Disjunction':
      findCollapsible(node.left, node, 'left', out);
      findCollapsible(node.right, node, 'right', out);
      break;
    case 'Group':
      findCollapsible(node.expression, node, 'expression', out);
      break;
    case 'Repetition':
      findCollapsible(node.expression, node, 'expression', out);
      break;
    default:
      break;
  }

  return out;
}

/**
 * `(X+)+` -> `(X)+`: keep the group, drop the inner repetition.
 *
 * Star wins over plus: `(X+)*` and `(X*)+` both accept the empty string through
 * zero repetitions, so the collapsed form must be `*`.
 */
function collapse(node) {
  const inner = node.expression.expression;
  const outerStar = node.quantifier.kind === '*';
  const innerStar = inner.quantifier.kind === '*';

  const result = clone(node);
  result.expression.expression = clone(inner.expression);

  // Built with Object.assign rather than object spread: the upstream build uses
  // babel 6's preset-env, which has no transform for the object rest/spread
  // proposal. Adding a plugin for one line is not worth the build change.
  const quantifier = Object.assign({}, result.quantifier, {
    kind: outerStar || innerStar ? '*' : '+',
  });

  delete quantifier.from;
  delete quantifier.to;

  result.quantifier = quantifier;

  return result;
}

function replaceSite(parent, key, replacement) {
  parent[key] = replacement;
}

/**
 * Extracts a small alphabet: the literal characters in the pattern plus one
 * sentinel that the pattern does not mention. Without the sentinel, a verifier
 * could miss differences that only appear on rejected input.
 */
function buildAlphabet(asts) {
  const chars = new Set();

  for (const ast of asts) {
    const report = analyze(ast);
    for (const char of report.alphabet) {
      chars.add(char);
    }
  }

  for (const candidate of ['!', 'x', 'a']) {
    if (!chars.has(candidate)) {
      chars.add(candidate);
      break;
    }
  }

  return Array.from(chars).slice(0, MAX_ALPHABET);
}

/**
 * Enumerates every string over `alphabet` up to `maxLength`, including the empty
 * one.
 *
 * Built as breadth-first levels rather than a generator: babel 6 compiles
 * generators to `regeneratorRuntime` calls, and this project ships no runtime
 * polyfill. A bounded level expansion produces the same set with no dependency.
 */
function enumerateStrings(alphabet, maxLength) {
  const all = [''];
  let frontier = [''];

  for (let depth = 0; depth < maxLength; depth += 1) {
    const next = [];

    for (const prefix of frontier) {
      for (const char of alphabet) {
        const candidate = prefix + char;
        all.push(candidate);
        next.push(candidate);
      }
    }

    frontier = next;
  }

  return all;
}

/**
 * Checks whether two patterns accept the same strings over a bounded space.
 *
 * This is a finite check, not a proof. Regular-language equivalence is
 * decidable, but implementing a full decision procedure is a different project;
 * what this returns is "no counterexample up to length L over this alphabet".
 * `complete: false` is always reported so no caller can mistake it for a proof.
 */
function verify(astA, astB, options = {}) {
  const alphabet = options.alphabet || buildAlphabet([astA, astB]);
  const maxLength = options.maxLength || DEFAULT_MAX_LENGTH;
  const maxSteps = options.maxSteps || 20000;

  const differences = [];
  let tested = 0;
  let skipped = 0;

  for (const sample of enumerateStrings(alphabet, maxLength)) {
    const a = exec(astA, sample, {maxSteps});
    const b = exec(astB, sample, {maxSteps});

    if (a.truncated || b.truncated) {
      skipped += 1;
      continue;
    }

    tested += 1;

    if (a.matched !== b.matched) {
      differences.push({
        input: sample,
        original: a.matched,
        rewritten: b.matched,
      });

      if (differences.length >= 10) {
        break;
      }
    }
  }

  return {
    complete: false,
    alphabet,
    maxLength,
    tested,
    skipped,
    differences,
    statement:
      `No counterexample found among ${tested} strings of length <= ` +
      `${maxLength} over [${alphabet.join(', ')}]. This is a bounded check, ` +
      `not an equivalence proof.`,
  };
}

function cost(ast, inputs, maxSteps) {
  let steps = 0;
  let truncated = false;

  for (const input of inputs) {
    const result = exec(ast, input, {maxSteps});
    steps += result.ledger.steps;
    truncated = truncated || Boolean(result.truncated);
  }

  return {steps, truncated};
}

/**
 * Proposes rewrites for `pattern` and validates each one.
 */
function rewrite(pattern, options = {}) {
  const regexpTree = require('../regexp-tree');
  const ast = regexpTree.parse(pattern);
  const report = analyze(ast, pattern);

  if (!report.supported) {
    return {pattern, supported: false, unsupported: report.unsupported};
  }

  const sites = findCollapsible(ast, null, null, []);

  if (sites.length === 0) {
    return {
      pattern,
      supported: true,
      candidates: [],
      note:
        'No collapsed-quantifier site found. This module only rewrites ' +
        '`(X+)+`-shaped nesting; it does not guess at other equivalences.',
    };
  }

  const inputs = options.inputs || [
    '',
    'a',
    'aa',
    'aaa',
    'aaaa',
    'aaaaaaaa',
    'aaaaaaaaaaaa',
    'aaaa!',
    'aaaaaaaa!',
  ];

  const candidates = sites.map((site, index) => {
    const rewrittenAst = clone(ast);

    // `site.parent` points into the original tree. Re-locating the same site in
    // the clone keeps the mutation on the copy that gets generated and measured.
    const clonedSites = findCollapsible(rewrittenAst, null, null, []);
    const target = clonedSites[index];

    target.parent[target.key] = collapse(target.node);

    const generated = regexpTree.generate(rewrittenAst);
    const verification = verify(ast, rewrittenAst, options);
    const before = cost(ast, inputs, options.maxSteps || 200000);
    const after = cost(rewrittenAst, inputs, options.maxSteps || 200000);

    return {
      rule: 'collapse-nested-quantifier',
      site: site.key,
      originalFragment: regexpTree.generate({
        type: 'RegExp',
        body: site.node,
        flags: '',
      }),
      rewritten: generated,
      verification,
      cost: {
        inputs: inputs.length,
        beforeSteps: before.steps,
        afterSteps: after.steps,
        ratio:
          after.steps === 0
            ? null
            : Number((before.steps / after.steps).toFixed(2)),
        truncated: before.truncated || after.truncated,
      },
      caveat:
        'The accepted language is preserved, but capture group values may ' +
        'differ: the collapsed group records one iteration instead of many.',
    };
  });

  return {pattern, supported: true, candidates};
}

module.exports = {rewrite, verify, buildAlphabet, findCollapsible, collapse};
